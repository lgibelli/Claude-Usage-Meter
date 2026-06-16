// popup.js (v1.4)

const CHROME_REVIEW_URL = "https://chromewebstore.google.com/detail/claude-usage-meter/kgpahkcgadpnklinijdojapiadnfelae/reviews";
const EDGE_REVIEW_URL = "https://microsoftedge.microsoft.com/addons/detail/claude-usage-meter/anhdhmpfpgbohohjlbgnggnmcmkmmcbn";
const RATE_KEY = "rate_us_clicked";

// Edge is Chromium under the hood, so sniff the UA to route the review link.
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

function colorClassFor(percent) {
  if (percent >= 90) return "red";
  if (percent >= 75) return "orange";
  if (percent >= 50) return "amber";
  return "";
}

function fmtReset(ts) {
  if (!ts) return "no reset info";
  const ms = ts - Date.now();
  if (ms <= 0) return "resets now";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `resets in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 48) return `resets in ${hrs}h ${rem}m`;
  return `resets in ${Math.floor(hrs / 24)}d`;
}

function fmtUpdated(ts) {
  if (!ts) return "no readings yet";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return `updated just now`;
  if (s < 60) return `updated ${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `updated ${m}m ago`;
  return `updated ${Math.floor(m / 60)}h ago`;
}

function titleCase(s) {
  if (!s) return "";
  // "fable" -> "Fable", "fable_5" -> "Fable 5"
  return s.split(/[_\s]+/).map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
}

function weeklyLabelFor(_weekly, _currentModel) {
  // Always show plain "Weekly" regardless of the active model family. The
  // correct family-specific weekly bucket is still chosen for the percentage
  // in background.js; only the label text is fixed here.
  return "Weekly";
}

function renderCard(scope, data) {
  const pctEl = document.getElementById(`${scope}-pct`);
  const fillEl = document.getElementById(`${scope}-fill`);
  const subEl = document.getElementById(`${scope}-sub`);
  if (!data || data.percent == null) {
    pctEl.textContent = "—";
    fillEl.style.width = "0%";
    fillEl.className = "bar-fill";
    subEl.textContent = "—";
    return false;
  }
  pctEl.textContent = `${data.percent}%`;
  fillEl.style.width = `${Math.min(100, data.percent)}%`;
  fillEl.className = `bar-fill ${colorClassFor(data.percent)}`;
  subEl.textContent = fmtReset(data.resetsAt);
  return true;
}

function renderMessagesLeft(usage) {
  const wrap = document.getElementById("msgs-left");
  const val = document.getElementById("msgs-left-val");
  if (usage && usage.messagesRemaining != null) {
    val.textContent = usage.messagesRemaining;
    wrap.classList.remove("hidden");
  } else {
    wrap.classList.add("hidden");
  }
}

function renderError(state) {
  const el = document.getElementById("error-banner");
  const { lastError, notificationPermission, lastNotifyError } = state;
  const lines = [];
  if (lastError && lastError.msg) {
    if (lastError.msg.toLowerCase().includes("not signed in")) {
      lines.push(`Not signed in to <a href="https://claude.ai" target="_blank">claude.ai</a>. Sign in, then click refresh.`);
    } else {
      lines.push(`Poll failed: <span class="code">${lastError.msg}</span>`);
    }
  }
  if (notificationPermission === "denied") {
    lines.push(`Chrome notifications are disabled. <a href="#" id="open-chrome-notif-settings">Allow notifications</a>.`);
  } else if (lastNotifyError && lastNotifyError.msg) {
    lines.push(`Last notification failed: <span class="code">${lastNotifyError.msg}</span>`);
  }
  el.innerHTML = lines.join("<br>");
  el.classList.toggle("hidden", lines.length === 0);
  const link = document.getElementById("open-chrome-notif-settings");
  if (link) {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: "chrome://settings/content/notifications" });
    });
  }
}

function setLoading(loading) {
  const dot = document.getElementById("loading-dot");
  const btn = document.getElementById("refresh-btn");
  if (loading) {
    dot.classList.add("pulsing");
    btn.classList.add("spinning");
  } else {
    dot.classList.remove("pulsing");
    btn.classList.remove("spinning");
  }
}

function setTestResult(msg, kind = "info") {
  const el = document.getElementById("test-result");
  if (!el) return;
  el.textContent = msg;
  el.className = `test-result ${kind}`;
  if (!msg) el.className = "test-result hidden";
}

async function render(state) {
  const { usage, currentModel } = state;
  const hasSession = renderCard("session", usage && usage.session);
  const hasWeekly  = renderCard("weekly",  usage && usage.weekly);
  document.getElementById("weekly-lbl").textContent =
    weeklyLabelFor(usage && usage.weekly, currentModel);
  renderMessagesLeft(usage);
  document.getElementById("updated").textContent = fmtUpdated(usage && usage.updatedAt);
  document.getElementById("empty-hint").classList.toggle("hidden", hasSession || hasWeekly);
  renderError(state);
}

async function refresh({ forceFetch = false } = {}) {
  if (forceFetch) {
    setLoading(true);
    try { await chrome.runtime.sendMessage({ type: "force-refresh" }); } catch (_) {}
    setLoading(false);
  }
  const state = await chrome.runtime.sendMessage({ type: "get-state" });
  await render(state);
}

document.getElementById("refresh-btn").addEventListener("click", () => refresh({ forceFetch: true }));
document.getElementById("open-options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.getElementById("test-btn").addEventListener("click", async () => {
  setTestResult("Firing test…", "info");
  try {
    const r = await chrome.runtime.sendMessage({ type: "test-notification" });
    if (r && r.ok) {
      setTestResult("Test fired. If you don't see it, check OS notification permissions for Chrome.", "info");
    } else {
      setTestResult(`Notification failed: ${(r && r.error) || "unknown error"}`, "error");
    }
  } catch (e) {
    setTestResult(`Notification failed: ${e && e.message || e}`, "error");
  }
});

document.getElementById("reset-btn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "reset-usage" });
  setTestResult("", "");
  refresh({ forceFetch: true });
});

// ── Strip CTA: reflects whether the on-page strip is already visible ──
const STRIP_ICON_STRIP =
  '<svg class="btn-strip-cta-ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="9" x2="21" y2="9"></line><rect x="3" y="4" width="18" height="16" rx="2"></rect></svg>';
const STRIP_ICON_CHECK =
  '<svg class="btn-strip-cta-ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
const STRIP_ICON_OPEN =
  '<svg class="btn-strip-cta-ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>';

function setStripButton(state) {
  const btn = document.getElementById("show-strip-btn");
  if (!btn) return;
  btn.dataset.state = state;
  if (state === "visible") {
    btn.classList.add("is-visible");
    btn.innerHTML =
      '<span class="btn-strip-cta-glow"></span>' + STRIP_ICON_CHECK +
      '<span class="btn-strip-cta-txt">Usage strip is visible on claude.ai</span>';
  } else if (state === "open") {
    btn.classList.remove("is-visible");
    btn.innerHTML =
      '<span class="btn-strip-cta-glow"></span>' + STRIP_ICON_OPEN +
      '<span class="btn-strip-cta-txt">Open claude.ai to see the strip</span>';
  } else {
    btn.classList.remove("is-visible");
    btn.innerHTML =
      '<span class="btn-strip-cta-glow"></span>' + STRIP_ICON_STRIP +
      '<span class="btn-strip-cta-txt">Show Usage Strip above Chat</span>';
  }
}

async function getActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch (_) { return null; }
}

function isClaudeTab(tab) {
  return !!(tab && tab.url && tab.url.startsWith("https://claude.ai/"));
}

async function focusOrOpenClaude() {
  const tab = await getActiveTab();
  if (isClaudeTab(tab)) {
    // Already the active tab — just close the popup so the strip is in view.
    window.close();
    return;
  }
  try {
    const claudeTabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
    if (claudeTabs && claudeTabs.length) {
      const t = claudeTabs[0];
      await chrome.tabs.update(t.id, { active: true });
      if (t.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url: "https://claude.ai/" });
    }
  } catch (_) {
    try { await chrome.tabs.create({ url: "https://claude.ai/" }); } catch (_) {}
  }
  window.close();
}

async function refreshStripButtonState() {
  const tab = await getActiveTab();
  if (!isClaudeTab(tab)) { setStripButton("open"); return; }
  let visible = false;
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "query-strip-visible" });
    visible = !!(resp && resp.visible);
  } catch (_) {
    // Content script not ready / not responding — treat as not visible.
    visible = false;
  }
  setStripButton(visible ? "visible" : "show");
}

document.getElementById("show-strip-btn").addEventListener("click", async () => {
  const btn = document.getElementById("show-strip-btn");
  const state = btn ? btn.dataset.state : "show";

  // When the strip is already visible, or we're not on claude.ai, the action
  // is simply to take the user to claude.ai so they can see it.
  if (state === "visible" || state === "open") {
    await focusOrOpenClaude();
    return;
  }

  // Default "show" path: clear the dismissal and ask the content script to mount.
  await chrome.storage.local.set({ overlay_dismissed_until: 0 });
  try {
    const tab = await getActiveTab();
    if (isClaudeTab(tab)) {
      await chrome.tabs.sendMessage(tab.id, { type: "restore-strip" });
      setStripButton("visible");
      setTestResult("Strip is now showing on claude.ai.", "info");
      return;
    }
  } catch (_) {}
  setTestResult("Strip will appear next time you open claude.ai.", "info");
});

// ── Rate us: shown until the user clicks it once, then hidden forever ──
async function refreshRateButton() {
  const btn = document.getElementById("rate-btn");
  if (!btn) return;
  let rated = false;
  try {
    const { [RATE_KEY]: v } = await chrome.storage.local.get(RATE_KEY);
    rated = !!v;
  } catch (_) {}
  btn.classList.toggle("hidden", rated);
}

document.getElementById("rate-btn").addEventListener("click", async () => {
  const btn = document.getElementById("rate-btn");
  if (btn) btn.classList.add("hidden");
  try {
    await chrome.storage.local.set({ [RATE_KEY]: true });
    await chrome.tabs.create({ url: getReviewUrl() });
  } catch (_) {}
  window.close();
});

(async () => {
  await refresh({ forceFetch: false });
  await refreshStripButtonState();
  await refreshRateButton();
  await refresh({ forceFetch: true });
})();

setInterval(() => refresh({ forceFetch: false }), 3000);
setInterval(() => refreshStripButtonState(), 3000);
