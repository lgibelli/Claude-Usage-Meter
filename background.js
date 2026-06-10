// background.js  (v1.7)
// Changes in extension v1.1.0:
//   - Fable 5 / Mythos 5 (and future model) support: per-model weekly usage
//     buckets are now extracted dynamically from the usage API field suffix
//     (seven_day_<family> / weekly_<family>) instead of a hardcoded
//     opus/sonnet/haiku whitelist; fuzzy bucket matching + generic fallback.
//   - Model picker detection updated (Fable/Mythos added, "Claude" prefix
//     optional). Labels render multi-word families ("fable_5" -> "Fable 5").
// Changes in extension v1.0.9:
//   - Add: "Rate us" now routes to the correct store. Edge users open the
//     Microsoft Edge Add-ons listing; everyone else opens the Chrome Web Store
//     review page. Browser is detected via navigator.userAgentData brands with
//     a UA-token fallback ("Edg/" etc).
//   - Harden: the rate flag is persisted directly on click in the strip too, so
//     once "Rate us" is clicked it never reappears even if the background
//     message path fails.
// Changes in extension v1.0.8:
//   - Remove: the auto-scroll feature (added in v1.0.6). It interfered with
//     the page's scroll position while the overlay was mounted; removing it
//     resolves the scroll issue. The `autoScrollEnabled` setting is gone.
// Changes in extension v1.0.6:
//   - Add: optional auto-scroll. While a Claude response streams in, the chat
//     transcript is kept pinned to the bottom so you don't have to scroll
//     manually — but only when you're already near the bottom, so scrolling up
//     to read earlier messages is never interrupted. Toggle it in Settings
//     ("Reading experience" → "Auto-scroll chat to bottom"); default ON. The
//     behaviour lives in content-script.js and reads the `autoScrollEnabled`
//     setting (new default below).
// Changes in extension v1.0.5:
//   - Rename: the extension is now "Claude Usage Meter" (formerly "Claude
//     Usage Tracker"). User-facing labels (toolbar title, options page,
//     in-chat tooltip, test notification) updated accordingly. Internal
//     message-channel and CSS identifiers are unchanged.
// Changes in extension v1.0.4:
//   - Add: the on-page usage strip now follows claude.ai's OWN theme. When
//     Claude is in dark mode the strip automatically switches to dark (and
//     light when Claude is light), independent of the OS preference, and
//     updates live when the theme is toggled. See content-script.js /
//     overlay.css (.cut-theme-dark / .cut-theme-light).
// Changes in extension v1.0.3:
//   - Fix: session %, weekly % could falsely display as 100% (or other
//     inflated values) when actual usage was very low. The `utilization`
//     field returned by Claude's /api/organizations/{id}/usage endpoint is
//     already a percentage in 0..100 — not a 0..1 fraction. The previous
//     `v > 1 ? v : v * 100` heuristic corrupted any utilization value <= 1:
//     `utilization: 1` (1%) became 100%, `utilization: 0.5` (0.5%) became
//     50%, and so on. We now treat `utilization`, `percent`, and
//     `percentage` uniformly as 0..100, and prefer `used / limit` when
//     both are present.
// Changes vs v1.3:
//   - No toolbar badge counter (icon stays clean).
//   - On settings save, we reset fired-marker state and re-check thresholds against
//     current usage so a freshly-added threshold fires immediately if already crossed.
//   - notifications.create uses the callback form so we capture chrome.runtime.lastError
//     and surface failures (helps when OS-level notif permission is blocking).
//   - getPermissionLevel() is returned in get-state so the popup can warn.

const POLL_ALARM = "claude-usage-poll";
const DEFAULT_POLL_MINUTES = 1;
const ORG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CHROME_REVIEW_URL = "https://chromewebstore.google.com/detail/claude-usage-meter/kgpahkcgadpnklinijdojapiadnfelae/reviews";
const EDGE_REVIEW_URL = "https://microsoftedge.microsoft.com/addons/detail/claude-usage-meter/anhdhmpfpgbohohjlbgnggnmcmkmmcbn";
const RATE_KEY = "rate_us_clicked";

// Edge ships a Chromium engine, so feature checks won't distinguish it from
// Chrome — sniff the UA instead. Prefer the structured userAgentData brands
// (which list "Microsoft Edge") and fall back to the UA token: "Edg/" on
// desktop, "EdgA/" on Android, "EdgiOS/" on iOS, "Edge/" for legacy EdgeHTML.
function isEdgeBrowser() {
  try {
    const brands = navigator.userAgentData && navigator.userAgentData.brands;
    if (Array.isArray(brands) && brands.some((b) => /edge/i.test(b.brand))) return true;
  } catch (_) {}
  try {
    return /Edg(e|A|iOS)?\//i.test(navigator.userAgent || "");
  } catch (_) {}
  return false;
}

function getReviewUrl() {
  return isEdgeBrowser() ? EDGE_REVIEW_URL : CHROME_REVIEW_URL;
}

const DEFAULT_SETTINGS = {
  sessionThresholds: [50, 75, 90],
  weeklyThresholds:  [50, 75, 90],
  notificationsEnabled: true,
  pollMinutes: DEFAULT_POLL_MINUTES
};

const STORAGE_KEYS = {
  usage: "usage_state",
  settings: "settings",
  lastFiredThresholds: "last_fired_thresholds",
  orgCache: "org_cache",
  lastError: "last_error",
  currentModel: "current_model",
  lastNotifyError: "last_notify_error"
};

// ---------- storage helpers ----------

async function getSettings() {
  const { [STORAGE_KEYS.settings]: s } = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}
async function getUsage() {
  const { [STORAGE_KEYS.usage]: u } = await chrome.storage.local.get(STORAGE_KEYS.usage);
  return u || {
    session: null,
    weekly: null,
    weeklyByFamily: {},
    messagesRemaining: null,
    messagesResetAt: null,
    updatedAt: null
  };
}
async function saveUsage(u) {
  await chrome.storage.local.set({ [STORAGE_KEYS.usage]: u });
}
async function getCurrentModel() {
  const { [STORAGE_KEYS.currentModel]: m } = await chrome.storage.local.get(STORAGE_KEYS.currentModel);
  return m || null;
}
async function setCurrentModel(model) {
  await chrome.storage.local.set({ [STORAGE_KEYS.currentModel]: model });
}
async function getLastFired() {
  const { [STORAGE_KEYS.lastFiredThresholds]: l } =
    await chrome.storage.local.get(STORAGE_KEYS.lastFiredThresholds);
  return l || {};
}
async function saveLastFired(l) {
  await chrome.storage.local.set({ [STORAGE_KEYS.lastFiredThresholds]: l });
}
async function setLastError(msg) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.lastError]: msg ? { msg, ts: Date.now() } : null
  });
}
async function setLastNotifyError(msg) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.lastNotifyError]: msg ? { msg, ts: Date.now() } : null
  });
}

// ---------- org id discovery ----------

async function getOrgId(forceRefresh = false) {
  if (!forceRefresh) {
    const { [STORAGE_KEYS.orgCache]: cached } =
      await chrome.storage.local.get(STORAGE_KEYS.orgCache);
    if (cached && cached.id && cached.expires > Date.now()) return cached.id;
  }
  const resp = await fetch("https://claude.ai/api/organizations", {
    credentials: "include",
    headers: { accept: "application/json" }
  });
  if (resp.status === 401 || resp.status === 403) throw new Error("not_signed_in");
  if (!resp.ok) throw new Error(`orgs_http_${resp.status}`);
  const orgs = await resp.json();
  if (!Array.isArray(orgs) || orgs.length === 0) throw new Error("no_orgs");
  const candidate =
    orgs.find(o => Array.isArray(o.capabilities) && o.capabilities.includes("chat")) ||
    orgs[0];
  const id = candidate.uuid || candidate.id;
  if (!id) throw new Error("no_org_id_field");
  await chrome.storage.local.set({
    [STORAGE_KEYS.orgCache]: { id, expires: Date.now() + ORG_CACHE_TTL_MS }
  });
  return id;
}

// ---------- main poll ----------

async function pollUsage() {
  try {
    const orgId = await getOrgId();
    let resp = await fetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
      credentials: "include",
      headers: { accept: "application/json" }
    });
    if (resp.status === 401 || resp.status === 403) {
      await setLastError("Not signed in to claude.ai");
      return;
    }
    if (resp.status === 404) {
      const fresh = await getOrgId(true);
      resp = await fetch(`https://claude.ai/api/organizations/${fresh}/usage`, {
        credentials: "include",
        headers: { accept: "application/json" }
      });
    }
    if (!resp.ok) throw new Error(`usage_http_${resp.status}`);
    const data = await resp.json();
    await applyUsage(data);
    await setLastError(null);
  } catch (err) {
    const msg = (err && err.message) || String(err);
    await setLastError(msg === "not_signed_in" ? "Not signed in to claude.ai" : msg);
    console.error("[ClaudeUsage] poll failed:", err);
  }
}

function pickPct(node) {
  if (!node || typeof node !== "object") return null;

  // Most reliable signal: if both `used` and `limit` are present as numbers,
  // compute the percentage directly. No ambiguity about units.
  if (typeof node.used === "number" && typeof node.limit === "number" &&
      node.limit > 0 && !isNaN(node.used) && !isNaN(node.limit)) {
    const pct = (node.used / node.limit) * 100;
    return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
  }

  // Otherwise trust the field name. Empirically the Claude API returns
  // `utilization` already as a percentage in the 0..100 range — NOT a 0..1
  // fraction, despite the field name. The previous heuristic
  //   pct = v > 1 ? v : v * 100
  // corrupted any legitimate utilization <= 1: `utilization: 1` (meaning 1%)
  // was displayed as 100%, `utilization: 0.5` (0.5%) as 50%, etc. We now
  // treat `utilization`, `percent`, and `percentage` uniformly as 0..100.
  let pct = null;
  if (typeof node.utilization === "number" && !isNaN(node.utilization)) {
    pct = node.utilization;
  } else if (typeof node.percent === "number" && !isNaN(node.percent)) {
    pct = node.percent;
  } else if (typeof node.percentage === "number" && !isNaN(node.percentage)) {
    pct = node.percentage;
  } else {
    return null;
  }

  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}
function pickReset(node) {
  if (!node || typeof node !== "object") return null;
  const r = node.resets_at || node.reset_at || node.reset;
  if (!r) return null;
  const t = Date.parse(r);
  return isNaN(t) ? null : t;
}
function familyOfField(field) {
  if (!field) return "generic";
  // Bare weekly bucket (no model suffix) → the account-wide generic limit.
  if (field === "seven_day" || field === "weekly") return "generic";
  // v1.1.0: extract the family dynamically from the field suffix instead of
  // hardcoding opus/sonnet/haiku. With the Fable 5 / Mythos 5 launch (and
  // whatever comes next), the usage API can grow new per-model buckets like
  // `seven_day_fable` — the old whitelist mapped those to "other" and they
  // were never matched against the active model.
  const m = field.match(/^(?:seven_day|weekly)_(.+)$/);
  if (m && m[1]) return m[1].toLowerCase();
  return "other";
}

async function applyUsage(data) {
  const usage = await getUsage();

  const session = data.five_hour || data.session;
  const sPct = pickPct(session);
  if (sPct != null) usage.session = { percent: sPct, resetsAt: pickReset(session) };

  const weeklyByFamily = {};
  for (const field of Object.keys(data || {})) {
    if (!/^(seven_day|weekly)/.test(field)) continue;
    const pct = pickPct(data[field]);
    if (pct == null) continue;
    weeklyByFamily[familyOfField(field)] = {
      percent: pct,
      resetsAt: pickReset(data[field]),
      apiField: field
    };
  }
  usage.weeklyByFamily = weeklyByFamily;
  usage.weekly = pickWeeklyForActiveFamily(weeklyByFamily, await getCurrentModel());

  usage.updatedAt = Date.now();
  await saveUsage(usage);
  await maybeNotify(usage);
  await broadcastUsage(usage);
}

function pickWeeklyForActiveFamily(weeklyByFamily, currentModel) {
  if (!weeklyByFamily) return null;
  const family = ((currentModel && currentModel.family) || "generic").toLowerCase();
  const preferred = weeklyByFamily[family];
  if (preferred) return { ...preferred, family };
  // v1.1.0: fuzzy match — the API suffix shape for new models isn't
  // guaranteed to equal the picker name (e.g. detected "fable" vs a field
  // like `seven_day_fable_5`). Match any bucket whose key contains the
  // detected family (or vice-versa) before falling back to generic.
  if (family !== "generic") {
    for (const key of Object.keys(weeklyByFamily)) {
      if (key === "generic" || key === "other") continue;
      if (key.includes(family) || family.includes(key)) {
        return { ...weeklyByFamily[key], family: key };
      }
    }
  }
  const generic = weeklyByFamily.generic;
  if (generic) return { ...generic, family: "generic" };
  const anyKey = Object.keys(weeklyByFamily)[0];
  return anyKey ? { ...weeklyByFamily[anyKey], family: anyKey } : null;
}

async function applyCurrentModel(modelInfo) {
  await setCurrentModel(modelInfo);
  const usage = await getUsage();
  usage.weekly = pickWeeklyForActiveFamily(usage.weeklyByFamily || {}, modelInfo);
  await saveUsage(usage);
  await broadcastUsage(usage);
}

// ---------- SSE message_limit handler ----------

async function applyMessageLimit(payload) {
  const usage = await getUsage();
  if (payload.remaining != null) {
    usage.messagesRemaining = payload.remaining;
    usage.messagesRemainingAt = Date.now();
  }
  if (payload.resetsAt) {
    const t = Date.parse(payload.resetsAt);
    if (!isNaN(t)) usage.messagesResetAt = t;
  }
  await saveUsage(usage);
  await broadcastUsage(usage);
}

// ---------- broadcast to claude.ai tabs ----------

async function broadcastUsage(usageOpt) {
  const usage = usageOpt || await getUsage();
  try {
    const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, { type: "usage-updated", usage }, () => {
        void chrome.runtime.lastError;
      });
    }
  } catch (_) {}
}

// ---------- notifications ----------

function createNotification(id, opts) {
  return new Promise((resolve) => {
    try {
      chrome.notifications.create(id, opts, (notificationId) => {
        const err = chrome.runtime.lastError;
        if (err) {
          console.error("[ClaudeUsage] notification create failed:", err.message);
          setLastNotifyError(err.message).catch(() => {});
          resolve({ ok: false, error: err.message });
        } else {
          setLastNotifyError(null).catch(() => {});
          resolve({ ok: true, id: notificationId });
        }
      });
    } catch (e) {
      console.error("[ClaudeUsage] notification create threw:", e);
      setLastNotifyError(String(e && e.message || e)).catch(() => {});
      resolve({ ok: false, error: String(e) });
    }
  });
}

function getNotificationPermission() {
  return new Promise((resolve) => {
    try {
      chrome.notifications.getPermissionLevel((level) => resolve(level));
    } catch (_) {
      resolve("unknown");
    }
  });
}

async function maybeNotify(usage) {
  const settings = await getSettings();
  if (!settings.notificationsEnabled) return;
  const fired = await getLastFired();

  if (usage.session && usage.session.percent != null) {
    if (fired.session && usage.session.percent + 5 < fired.session) fired.session = 0;
    const next = nextThresholdToFire(usage.session.percent, settings.sessionThresholds, fired.session || 0);
    if (next != null) {
      await fireNotification("Session", next, usage.session);
      fired.session = next;
    }
  }

  const byFamily = usage.weeklyByFamily || {};
  for (const family of Object.keys(byFamily)) {
    const info = byFamily[family];
    if (info.percent == null) continue;
    const firedKey = `weekly_${family}`;
    if (fired[firedKey] && info.percent + 5 < fired[firedKey]) fired[firedKey] = 0;
    const next = nextThresholdToFire(info.percent, settings.weeklyThresholds, fired[firedKey] || 0);
    if (next != null) {
      const label = family === "generic" ? "Weekly" : `Weekly ${capitalize(family)}`;
      await fireNotification(label, next, info);
      fired[firedKey] = next;
    }
  }
  await saveLastFired(fired);
}
function capitalize(s) {
  if (!s) return "";
  // "fable" -> "Fable", "fable_5" -> "Fable 5"
  return s.split(/[_\s]+/).map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
}
function nextThresholdToFire(currentPercent, thresholds, alreadyFired) {
  const sorted = [...(thresholds || [])].sort((a, b) => a - b);
  let best = null;
  for (const t of sorted) if (currentPercent >= t && t > alreadyFired) best = t;
  return best;
}
async function fireNotification(scopeLabel, threshold, info) {
  const resetStr = info.resetsAt
    ? ` · resets ${new Date(info.resetsAt).toLocaleString()}`
    : "";
  await createNotification(`claude-usage-${scopeLabel}-${threshold}-${Date.now()}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: `Claude · ${scopeLabel} at ${threshold}%`,
    message: `You've used ${info.percent}% of your ${scopeLabel.toLowerCase()} quota${resetStr}.`,
    priority: 2
  });
}

// ---------- alarm scheduling ----------

async function rescheduleAlarm() {
  const { pollMinutes } = await getSettings();
  await chrome.alarms.clear(POLL_ALARM);
  await chrome.alarms.create(POLL_ALARM, {
    delayInMinutes: 0.05,
    periodInMinutes: Math.max(1, pollMinutes || DEFAULT_POLL_MINUTES)
  });
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) pollUsage();
});
chrome.runtime.onInstalled.addListener(async (details) => {
  const cur = await getSettings();
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: cur });
  // Clear any badge text left over from older versions.
  try { await chrome.action.setBadgeText({ text: "" }); } catch (_) {}
  // On fresh install (not on update/reload), open the welcome page.
  if (details && details.reason === "install") {
    try {
      await chrome.tabs.create({
        url: "https://www.selectorshub.com/claude-usage-meter-installed/"
      });
    } catch (_) {}
  }
  await rescheduleAlarm();
  pollUsage();
});
chrome.runtime.onStartup.addListener(async () => {
  try { await chrome.action.setBadgeText({ text: "" }); } catch (_) {}
  await rescheduleAlarm();
  pollUsage();
});

// ---------- message router ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "get-state") {
    (async () => {
      const [usage, settings, errState, currentModel, permission, notifyErrState] =
        await Promise.all([
          getUsage(),
          getSettings(),
          chrome.storage.local.get(STORAGE_KEYS.lastError),
          getCurrentModel(),
          getNotificationPermission(),
          chrome.storage.local.get(STORAGE_KEYS.lastNotifyError)
        ]);
      sendResponse({
        usage,
        settings,
        currentModel,
        notificationPermission: permission,
        lastError: errState[STORAGE_KEYS.lastError] || null,
        lastNotifyError: notifyErrState[STORAGE_KEYS.lastNotifyError] || null
      });
    })();
    return true;
  }

  if (msg.type === "save-settings") {
    (async () => {
      await chrome.storage.local.set({ [STORAGE_KEYS.settings]: msg.settings });
      await rescheduleAlarm();
      // Reset fired markers so newly-added thresholds at OR below current %
      // fire immediately on the re-check below.
      await saveLastFired({});
      const usage = await getUsage();
      await maybeNotify(usage);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "force-refresh") {
    (async () => { await pollUsage(); sendResponse({ ok: true }); })();
    return true;
  }

  if (msg.type === "set-active-model") {
    applyCurrentModel(msg.model || null)
      .then(() => sendResponse && sendResponse({ ok: true }))
      .catch(() => sendResponse && sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === "sse-message-limit") {
    applyMessageLimit(msg.payload || {})
      .then(() => sendResponse && sendResponse({ ok: true }))
      .catch(() => sendResponse && sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === "test-notification") {
    createNotification(`claude-usage-test-${Date.now()}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: "Claude Usage Meter · test",
      message: "Notifications are working. If you don't see this, check your OS notification settings for Chrome.",
      priority: 2
    }).then((r) => sendResponse(r));
    return true;
  }

  if (msg.type === "open-review") {
    (async () => {
      try {
        await chrome.storage.local.set({ [RATE_KEY]: true });
        await chrome.tabs.create({ url: getReviewUrl() });
      } catch (_) {}
      sendResponse && sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "reset-usage") {
    (async () => {
      await chrome.storage.local.set({
        [STORAGE_KEYS.usage]: {
          session: null, weekly: null, weeklyByFamily: {},
          messagesRemaining: null, messagesResetAt: null, updatedAt: null
        },
        [STORAGE_KEYS.lastFiredThresholds]: {},
        [STORAGE_KEYS.orgCache]: null,
        [STORAGE_KEYS.lastError]: null,
        [STORAGE_KEYS.lastNotifyError]: null,
        overlay_dismissed_until: 0
      });
      try { await chrome.action.setBadgeText({ text: "" }); } catch (_) {}
      pollUsage();
      sendResponse({ ok: true });
    })();
    return true;
  }
});
