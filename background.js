// background.js  (v1.12)
// Changes in extension v1.1.5:
//   - Fix: usage strip went blank (showing "—") while recording with screen
//     capture tools like Screen Studio. Root cause: macOS screen capture APIs
//     cause Chrome to treat the captured window as "hidden", which triggers
//     Chrome's service-worker throttling — chrome.alarms stops firing on
//     schedule, the poll never runs, and no data reaches the strip. Two fixes:
//     (1) content-script.js now listens for `visibilitychange` and fires a
//     `force-refresh` message the moment the tab becomes visible again, so
//     data is always current when the recording resumes or stops.
//     (2) content-script.js sends a `keepalive` ping every 20 s to prevent
//     the background service worker from being suspended mid-recording.
//     background.js handles `keepalive` as a lightweight no-op so the service
//     worker stays alive and alarms keep firing.
// Changes in extension v1.1.4:
//   - Fix: usage never showed for accounts that belong to an organization
//     (e.g. a company-managed org alongside a personal org). getOrgId picked
//     the first org from /api/organizations with a "chat" capability, which
//     for multi-org accounts is often NOT the org the user is actually using,
//     so /usage was queried for the wrong org and returned nothing. We now
//     read the active org from claude.ai's `lastActiveOrg` cookie (the same
//     source the page itself uses) via chrome.cookies, falling back to the
//     organizations-list heuristic only when the cookie is unavailable. Also
//     reflects org switches immediately. Requires the new "cookies" permission.
//   - (rolled in from interim builds) message_limit lockout pins session to
//     100%; X-Organization-UUID header sent on /usage; error-shaped response
//     bodies surfaced; raw /usage stored for diagnostics; limit=0 handled as
//     100%/0%; % text colored red with a pulse at >=90% / 100%.
// background.js  (v1.10)
// Changes in extension v1.1.7:
//   - Fix: claude.ai's usage endpoint now requires an `X-Organization-UUID`
//     header for session-cookie auth — without it the request fails with
//     {"type":"error","error":{"type":"authentication_error",
//     "message":"X-Organization-UUID header is required for session key
//     authentication"}} and no usage data is returned. We now send the org
//     UUID (already discovered via getOrgId) on both the primary and the
//     404-retry usage fetch.
//   - Add: error-shaped response bodies ({"type":"error",...}) are now
//     detected and surfaced via lastError instead of being parsed as empty
//     usage (which left the strip blank/stale with no explanation).
// Changes in extension v1.1.6:
//   - Fix: when the session limit was actually HIT (100% / "Usage limit
//     reached"), the strip and popup showed 0% instead of 100%. Root cause:
//     the /api/organizations/{id}/usage poll reports the fresh rolling window
//     (~0%) at the moment the cap is reached, while the real lockout is
//     delivered via the completion stream's `message_limit` event (the same
//     source as Claude's own red "Usage limit reached" bar). We now read the
//     reached/exhausted signal from that event and pin the session to 100%
//     until its reset time, so a lagging poll can't reset it to a stale 0%.
//   - Add: the raw /usage response is stored (`usage_raw`) and logged to the
//     service worker console to make verifying undocumented field shapes
//     (e.g. the exact 100%/limit-reached representation) straightforward.
// Changes in extension v1.1.4:
//   - Fix: session / weekly usage showed "—" (no data) when a quota was
//     completely exhausted (100%) or brand-new (0%) if the API returned
//     `limit: 0` alongside `used`. The `pickPct` helper skipped the
//     used/limit path when limit=0 (division-by-zero guard), then found no
//     fallback utilization field, and returned null — causing the strip to
//     display dashes instead of 100% (or 0%). Fix: intercept the limit=0
//     case explicitly: used>0 → 100%, used=0 → 0%.
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
// v1.2.3: when the rating happened. The strip's Share button waits 5 days from
// this timestamp (see shareUnlocked() in content-script.js). Written with a
// "first write wins" guard so a second Rate us path can't restart the clock.
const RATE_AT_KEY = "rate_us_clicked_at";

async function markRated() {
  const patch = { [RATE_KEY]: true };
  try {
    const { [RATE_AT_KEY]: existing } = await chrome.storage.local.get(RATE_AT_KEY);
    if (!existing) patch[RATE_AT_KEY] = Date.now();
  } catch (_) {
    patch[RATE_AT_KEY] = Date.now();
  }
  await chrome.storage.local.set(patch);
}

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
  lastNotifyError: "last_notify_error",
  sessionLock: "session_lock",   // {until} — pins session to 100% while a hard lockout is active
  usageRaw: "usage_raw"          // last raw /usage response, for diagnosing field shapes
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
async function getSessionLock() {
  const { [STORAGE_KEYS.sessionLock]: l } = await chrome.storage.local.get(STORAGE_KEYS.sessionLock);
  return l || null;
}
async function setSessionLock(lock) {
  await chrome.storage.local.set({ [STORAGE_KEYS.sessionLock]: lock });
}

// ---------- org id discovery ----------

// The org the user currently has active in claude.ai. For accounts that belong
// to a single org this is the only org; for accounts in multiple orgs (e.g. a
// personal org plus a company-managed org) claude.ai records the active one in
// the `lastActiveOrg` cookie and uses it for its own /api/organizations/{id}/...
// calls. Reading it directly is authoritative and instant, and — unlike
// document.cookie — chrome.cookies can read it even if it is HttpOnly.
async function getActiveOrgFromCookie() {
  if (!chrome.cookies || !chrome.cookies.get) return null;
  try {
    const cookie = await chrome.cookies.get({
      name: "lastActiveOrg",
      url: "https://claude.ai/"
    });
    return cookie && cookie.value ? cookie.value : null;
  } catch (_) {
    return null;
  }
}

async function getOrgId(forceRefresh = false) {
  // Prefer the live active-org cookie. It is read fresh every time (cheap,
  // local) so switching between a personal and a managed org is reflected
  // immediately, and it matches the org the page itself is calling.
  const activeOrg = await getActiveOrgFromCookie();
  if (activeOrg) return activeOrg;

  // Fallback (cookie unavailable): derive from the organizations list. This
  // is the legacy heuristic and is unreliable for multi-org/managed accounts,
  // so it is only used when the cookie can't be read.
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
      headers: { accept: "application/json", "X-Organization-UUID": orgId }
    });
    if (resp.status === 401 || resp.status === 403) {
      await setLastError("Not signed in to claude.ai");
      return;
    }
    if (resp.status === 404) {
      const fresh = await getOrgId(true);
      resp = await fetch(`https://claude.ai/api/organizations/${fresh}/usage`, {
        credentials: "include",
        headers: { accept: "application/json", "X-Organization-UUID": fresh }
      });
    }
    if (!resp.ok) throw new Error(`usage_http_${resp.status}`);
    const data = await resp.json();
    // Some auth/validation failures come back with a 200-ish status but an
    // error-shaped body (e.g. {"type":"error","error":{...}}). Surface those
    // instead of parsing them as empty usage (which silently leaves the strip
    // blank or showing a stale value).
    if (data && data.type === "error") {
      const m = (data.error && data.error.message) || "usage_api_error";
      await setLastError(m);
      console.warn("[ClaudeUsage] /usage returned an error body:", data);
      return;
    }
    // Diagnostic: keep the raw response so the exact field shape at any usage
    // level (including 100% / limit-reached) can be inspected from the service
    // worker console (chrome://extensions → Claude Usage Meter → service worker)
    // or via chrome.storage.local.get("usage_raw").
    try {
      await chrome.storage.local.set({ [STORAGE_KEYS.usageRaw]: { data, ts: Date.now() } });
    } catch (_) {}
    console.debug("[ClaudeUsage] raw /usage response:", data);
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
      !isNaN(node.used) && !isNaN(node.limit)) {
    // When limit=0 the API may indicate the quota is fully exhausted:
    //   used > 0 and limit = 0  →  treat as 100%
    //   used = 0 and limit = 0  →  treat as 0% (quota just reset / not started)
    if (node.limit === 0) return node.used > 0 ? 100 : 0;
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

  // Honour an active session lockout. When the limit is hit, the /usage poll
  // can still report the fresh rolling window at ~0% even though messages are
  // blocked — so a lockout recorded from the message_limit SSE event pins the
  // session to 100% until its reset time passes.
  const lock = await getSessionLock();
  if (lock && lock.until && lock.until > Date.now()) {
    const cur = usage.session;
    if (!cur || cur.percent == null || cur.percent < 100) {
      usage.session = { percent: 100, resetsAt: lock.until };
    }
  } else if (lock) {
    await setSessionLock(null);
  }

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
  let resetTs = null;
  if (payload.resetsAt) {
    const t = Date.parse(payload.resetsAt);
    if (!isNaN(t)) { usage.messagesResetAt = t; resetTs = t; }
  }

  // Hard lockout handling. The /usage poll lags (or reads the fresh window at
  // ~0%) at the moment the cap is hit; the authoritative "limit reached"
  // signal arrives here via the completion stream's message_limit event — the
  // same source Claude's own "Usage limit reached" bar uses. Pin the session
  // to 100% and hold it until the reset time so the strip doesn't fall back to
  // a stale 0% on the next poll.
  const reached = payload.reached === true || payload.remaining === 0;
  if (reached) {
    const until = resetTs || (usage.session && usage.session.resetsAt) || (Date.now() + 5 * 60 * 60 * 1000);
    await setSessionLock({ until });
    usage.session = { percent: 100, resetsAt: resetTs || (usage.session && usage.session.resetsAt) || until };
  }

  await saveUsage(usage);
  await maybeNotify(usage);
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
  // Record the install time once, to gate the "Rate us" button (extension
  // v1.2.4). A brand-new install starts the 2-day clock now, so the button
  // stays hidden until the user has actually lived with the tool. Existing
  // users upgrading have no timestamp yet — we backdate them to 0 ("gate
  // already elapsed") so the button keeps showing for them as before, rather
  // than re-hiding it for two days on every update.
  try {
    const { install_at } = await chrome.storage.local.get("install_at");
    if (install_at === undefined) {
      await chrome.storage.local.set({
        install_at: (details && details.reason === "install") ? Date.now() : 0
      });
    }
  } catch (_) {}
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
        await markRated();
        await chrome.tabs.create({ url: getReviewUrl() });
      } catch (_) {}
      sendResponse && sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "keepalive") {
    // No-op: receiving this message keeps the service worker alive so
    // chrome.alarms continues to fire normally during screen recording
    // (when Chrome would otherwise suspend the worker due to inactivity).
    sendResponse && sendResponse({ ok: true });
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
        [STORAGE_KEYS.sessionLock]: null,
        [STORAGE_KEYS.usageRaw]: null,
        overlay_dismissed_until: 0
      });
      try { await chrome.action.setBadgeText({ text: "" }); } catch (_) {}
      pollUsage();
      sendResponse({ ok: true });
    })();
    return true;
  }
});
