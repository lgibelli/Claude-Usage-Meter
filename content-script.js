// content-script.js (isolated world, v1.8)
// - v1.1.5: fix blank strip during screen recording (e.g. Screen Studio).
//   Chrome throttles / suspends the background service worker when macOS
//   screen-capture APIs mark the window as "hidden". Two mitigations:
//   (1) visibilitychange listener — fires a force-refresh whenever the tab
//       becomes visible again so data is always fresh after a recording pause.
//   (2) keepalive ping — sends a no-op message to the background every 20 s
//       to prevent service-worker suspension mid-recording so alarms keep
//       firing throughout the session.
// - v1.1.4: the % number is now colored to match its status dot, and any
//   segment at >= 90% gets a red "alert" wash. At 100% the segment turns a
//   stronger red and pulses (respects prefers-reduced-motion).
// - Adds a second segment to the overlay strip for weekly usage.
// - v1.0.8: removed the auto-scroll feature. It was hijacking the page's
//   scroll position while the overlay was mounted; closing the overlay
//   resolved it, confirming the auto-scroll logic as the cause.

(function () {
  // ===== bridge SSE events =====
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "claude-usage-meter") return;
    try {
      chrome.runtime.sendMessage({ type: "sse-message-limit", payload: data.payload });
    } catch (_) {}
  });

  // ===== model detection =====
  // v1.1.0: added Fable and Mythos (new Mythos-class tier, Jan 2026) and made
  // the "Claude" prefix optional — the model picker button sometimes shows
  // just "Fable 5" / "Sonnet 4.6" without the brand prefix. The family list
  // stays a bounded whitelist to avoid false positives on arbitrary buttons.
  const MODEL_REGEX = /(?:Claude\s+)?(Opus|Sonnet|Haiku|Fable|Mythos)(?:\s+(\d+(?:\.\d+)?))?/i;
  let lastReportedModelFull = null;

  function detectModel() {
    const candidates = [];
    for (const btn of document.querySelectorAll("button, [role='button'], [aria-haspopup]")) {
      const text = (btn.innerText || btn.textContent || "").trim();
      if (!text || text.length > 60) continue;
      const m = text.match(MODEL_REGEX);
      if (m) candidates.push({ el: btn, text, match: m });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.text.length - b.text.length);
    const best = candidates[0];
    return { full: best.match[0], family: best.match[1].toLowerCase(), version: best.match[2] || null };
  }
  function reportModelIfChanged() {
    const m = detectModel();
    if (!m || m.full === lastReportedModelFull) return;
    lastReportedModelFull = m.full;
    try { chrome.runtime.sendMessage({ type: "set-active-model", model: m }); } catch (_) {}
  }

  // ===== Claude page theme detection =====
  // The strip should follow Claude.ai's *own* theme, not the OS preference.
  // A user can set claude.ai to dark while their OS is light (or vice-versa),
  // so we detect the page's actual theme and apply a class to the overlay.
  function parseRgb(str) {
    if (!str) return null;
    const m = str.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/i);
    if (!m) return null;
    const a = m[4] === undefined ? 1 : parseFloat(m[4]);
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  function relLuminance({ r, g, b }) {
    // sRGB relative luminance (0 = black, 1 = white).
    const f = (c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function effectiveBgColor() {
    // Walk up from <body> to find the first opaque-ish background color.
    let el = document.body;
    for (let i = 0; el && i < 6; i++) {
      const c = parseRgb(getComputedStyle(el).backgroundColor);
      if (c && c.a > 0.1) return c;
      el = el.parentElement;
    }
    const html = parseRgb(getComputedStyle(document.documentElement).backgroundColor);
    return html && html.a > 0.1 ? html : null;
  }
  function detectClaudeTheme() {
    const html = document.documentElement;
    const body = document.body;

    // 1) Explicit theme attributes set by the app (most reliable). Confirmed
    //    from the live claude.ai DOM: the root <html> carries data-mode
    //    ("light"/"dark") for the theme, while data-theme ("claude") is the
    //    brand/skin name — so we match exact "dark"/"light" values only and
    //    ignore the skin name. The cds-root <div> mirrors data-mode too, so we
    //    scan it as well in case it ever diverges from <html>.
    const attrs = ["data-mode", "data-theme", "data-color-scheme", "data-color-mode"];
    const nodes = [html, body, document.querySelector(".cds-root[data-mode]")];
    for (const node of nodes) {
      if (!node) continue;
      for (const a of attrs) {
        const v = (node.getAttribute(a) || "").toLowerCase();
        if (v === "dark") return "dark";
        if (v === "light") return "light";
      }
    }

    // 2) Declared color-scheme on the root.
    const scheme = (getComputedStyle(html).colorScheme || "").toLowerCase();
    if (scheme.includes("dark") && !scheme.includes("light")) return "dark";
    if (scheme.includes("light") && !scheme.includes("dark")) return "light";

    // 3) Ground truth: luminance of the rendered page background. We run at
    //    document_idle, so the page is already painted; this reflects exactly
    //    what the user sees, regardless of how Claude implements its theme.
    const bg = effectiveBgColor();
    if (bg) return relLuminance(bg) < 0.45 ? "dark" : "light";

    // 4) Fuzzy hint: a `dark`/`light` token in the root class list (e.g.
    //    Tailwind's `dark`). Only used if the background was unreadable.
    const cls = ((html.className || "") + " " + (body ? body.className : "")).toLowerCase();
    if (/(^|\s|-)dark(\s|$|-)/.test(cls)) return "dark";
    if (/(^|\s|-)light(\s|$|-)/.test(cls)) return "light";

    // 5) Last resort: OS preference.
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  function applyTheme(root) {
    if (!root) return;
    const theme = detectClaudeTheme();
    root.classList.toggle("cut-theme-dark", theme === "dark");
    root.classList.toggle("cut-theme-light", theme === "light");
  }
  let themeRefreshScheduled = false;
  function refreshTheme() {
    // Debounced: claude.ai mutates root class/style frequently (scroll locks,
    // dialogs), and theme detection reads computed styles. Coalesce bursts.
    if (themeRefreshScheduled) return;
    themeRefreshScheduled = true;
    setTimeout(() => {
      themeRefreshScheduled = false;
      applyTheme(document.getElementById(OVERLAY_ID));
    }, 150);
  }

  // ===== overlay =====
  const OVERLAY_ID = "claude-usage-overlay";
  const DISMISS_KEY = "overlay_dismissed_until";
  const RATE_KEY = "rate_us_clicked";
  const CHROME_REVIEW_URL = "https://chromewebstore.google.com/detail/claude-usage-meter/kgpahkcgadpnklinijdojapiadnfelae/reviews";
  const EDGE_REVIEW_URL = "https://microsoftedge.microsoft.com/addons/detail/claude-usage-meter/anhdhmpfpgbohohjlbgnggnmcmkmmcbn";
  // Used only by the fallback below; the background normally opens the tab.
  function reviewUrl() {
    try {
      const brands = navigator.userAgentData && navigator.userAgentData.brands;
      if (Array.isArray(brands) && brands.some((b) => /edge/i.test(b.brand))) return EDGE_REVIEW_URL;
    } catch (_) {}
    try {
      if (/Edg(e|A|iOS)?\//i.test(navigator.userAgent || "")) return EDGE_REVIEW_URL;
    } catch (_) {}
    return CHROME_REVIEW_URL;
  }
  let rated = false;
  let latestUsage = null;
  let latestMsgsRemaining = null;

  async function isDismissed() {
    const { [DISMISS_KEY]: until } = await chrome.storage.local.get(DISMISS_KEY);
    return typeof until === "number" && until > Date.now();
  }
  async function dismissForHours(hours) {
    await chrome.storage.local.set({ [DISMISS_KEY]: Date.now() + hours * 3600 * 1000 });
  }

  function fmtReset(ts) {
    if (!ts) return "—";
    const ms = ts - Date.now();
    if (ms <= 0) return "now";
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    if (hrs < 48) return `${hrs}h ${rem}m`;
    return `${Math.floor(hrs / 24)}d`;
  }
  function colorClass(p) {
    if (p == null) return "neutral";
    if (p >= 90) return "red";
    if (p >= 75) return "orange";
    if (p >= 50) return "amber";
    return "green";
  }
  function weeklyLabel(_weekly) {
    // Always show "Weekly" regardless of which model family is active. (The
    // family-specific weekly bucket is still selected for the percentage in
    // background.js; only the displayed label is fixed here.)
    return "Weekly";
  }

  function buildOverlay() {
    const root = document.createElement("div");
    root.id = OVERLAY_ID;
    const logoUrl = chrome.runtime.getURL("icons/icon-strip.png");
    const tooltipText =
      "Claude Usage Meter — shows your Claude.ai session and weekly usage. " +
      "Click the extension icon in the toolbar for full details and settings.";
    root.innerHTML = `
      <div class="cut-strip" role="status">
        <span class="cut-logo-wrap" tabindex="0" role="img"
              aria-label="${tooltipText.replace(/"/g, '&quot;')}">
          <img class="cut-logo" src="${logoUrl}" alt="" />
          <span class="cut-tooltip" aria-hidden="true">${tooltipText}</span>
        </span>
        <div class="cut-divider"></div>
        <div class="cut-seg" data-cut="session">
          <span class="cut-dot cut-color-neutral" data-cut-dot></span>
          <span class="cut-label" data-cut-label>Session</span>
          <span class="cut-pct" data-cut-pct>—</span>
          <span class="cut-sep">·</span>
          <span class="cut-meta" data-cut-meta>waiting…</span>
        </div>
        <div class="cut-divider"></div>
        <div class="cut-seg" data-cut="weekly">
          <span class="cut-dot cut-color-neutral" data-cut-dot></span>
          <span class="cut-label" data-cut-label>Weekly</span>
          <span class="cut-pct" data-cut-pct>—</span>
          <span class="cut-sep">·</span>
          <span class="cut-meta" data-cut-meta>—</span>
        </div>
        <div class="cut-divider cut-msgs-divider" data-cut="msgs-divider" hidden></div>
        <span class="cut-msgs" data-cut="msgs" hidden></span>
        <div class="cut-divider cut-rate-divider" data-cut="rate-divider"></div>
        <button class="cut-rate" type="button" data-cut="rate"
                aria-label="Rate Claude Usage Meter on the Chrome Web Store" title="Rate us on the Chrome Web Store">
          <span class="cut-rate-star">⭐️</span><span class="cut-rate-txt">Rate us</span>
        </button>
        <span class="cut-close-wrap">
          <button class="cut-close" type="button" aria-label="Hide the strip for 12 hours">×</button>
          <span class="cut-close-tooltip" aria-hidden="true">Hides the strip for 12 hours.<br><strong>To bring it back sooner:</strong> click the Claude Usage Meter icon in your browser toolbar, then click <strong>"Show Usage Strip above Chat"</strong>.</span>
        </span>
      </div>
    `;
    root.querySelector(".cut-close").addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation();
      await dismissForHours(12);
      const el = document.getElementById(OVERLAY_ID);
      if (el) el.remove();
    });
    const rateBtn = root.querySelector(".cut-rate");
    if (rateBtn) {
      rateBtn.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        rated = true;
        applyRateVisibility(root);
        // Persist the flag directly so the button never returns, even if the
        // background message below fails and we take the fallback path.
        try { chrome.storage.local.set({ [RATE_KEY]: true }); } catch (_) {}
        // Background opens the review tab (and also persists the flag) so the
        // button never shows again (in the strip or the popup).
        try {
          chrome.runtime.sendMessage({ type: "open-review" });
        } catch (_) {
          try { window.open(reviewUrl(), "_blank", "noopener"); } catch (_) {}
        }
      });
    }
    applyRateVisibility(root);
    root.addEventListener("click", e => e.stopPropagation());
    return root;
  }

  function applyRateVisibility(root) {
    if (!root) return;
    const rb = root.querySelector('[data-cut="rate"]');
    const rd = root.querySelector('[data-cut="rate-divider"]');
    const display = rated ? "none" : "";
    if (rb) rb.style.display = display;
    if (rd) rd.style.display = display;
  }

  function renderSegment(segEl, data, labelOverride) {
    if (!segEl) return;
    const dotEl   = segEl.querySelector('[data-cut-dot]');
    const labelEl = segEl.querySelector('[data-cut-label]');
    const pctEl   = segEl.querySelector('[data-cut-pct]');
    const metaEl  = segEl.querySelector('[data-cut-meta]');
    if (labelOverride) labelEl.textContent = labelOverride;
    if (data && data.percent != null) {
      const p = data.percent;
      pctEl.textContent = `${p}%`;
      metaEl.textContent = data.resetsAt ? `resets in ${fmtReset(data.resetsAt)}` : "no reset info";
      const cls = colorClass(p);
      dotEl.className = "cut-dot cut-color-" + cls;
      // Also tint the % number itself, and flag alert states:
      //   >= 90%  → red text ("cut-alert")
      //   = 100%  → red text + pulsing "maxed out" emphasis ("cut-alert-max")
      pctEl.className = "cut-pct cut-color-" + cls;
      segEl.classList.toggle("cut-alert", p >= 90);
      segEl.classList.toggle("cut-alert-max", p >= 100);
    } else {
      pctEl.textContent = "—";
      pctEl.className = "cut-pct";
      metaEl.textContent = "waiting…";
      dotEl.className = "cut-dot cut-color-neutral";
      segEl.classList.remove("cut-alert", "cut-alert-max");
    }
  }

  function renderInto(root) {
    if (!root) return;
    renderSegment(root.querySelector('[data-cut="session"]'), latestUsage && latestUsage.session, "Session");
    renderSegment(root.querySelector('[data-cut="weekly"]'),  latestUsage && latestUsage.weekly,  weeklyLabel(latestUsage && latestUsage.weekly));
    applyRateVisibility(root);

    const msgsEl  = root.querySelector('[data-cut="msgs"]');
    const msgsDiv = root.querySelector('[data-cut="msgs-divider"]');
    if (latestMsgsRemaining != null) {
      msgsEl.textContent = `${latestMsgsRemaining} left`;
      msgsEl.hidden = false;
      msgsDiv.hidden = false;
    } else {
      msgsEl.hidden = true;
      msgsDiv.hidden = true;
    }
  }

  function findMountTarget() {
    const editor =
      document.querySelector('div.ProseMirror[contenteditable="true"]') ||
      document.querySelector('[contenteditable="true"][role="textbox"]') ||
      document.querySelector('[contenteditable="true"]');
    if (!editor) return null;

    let el = editor;
    let wrapper = null;
    for (let i = 0; i < 12 && el; i++) {
      el = el.parentElement;
      if (!el) break;
      if (el.tagName === "FIELDSET") { wrapper = el; break; }
      if (el.tagName === "FORM")     { wrapper = el; break; }
    }
    if (!wrapper) wrapper = editor.parentElement;
    return wrapper ? { wrapper, editor } : null;
  }

  async function ensureMounted() {
    if (await isDismissed()) {
      const existing = document.getElementById(OVERLAY_ID);
      if (existing) existing.remove();
      return;
    }
    const target = findMountTarget();
    if (!target) return;

    // Mount as a SIBLING immediately BEFORE the composer fieldset/form, so the
    // strip sits ABOVE the chatbox (left-aligned via CSS).
    const composer = target.wrapper;
    const parent = composer.parentElement;
    if (!parent) return;

    const existing = document.getElementById(OVERLAY_ID);
    // Already correctly placed (sibling immediately before composer)?
    if (existing && existing.nextElementSibling === composer) {
      applyTheme(existing);
      renderInto(existing);
      return;
    }
    if (existing) existing.remove();

    const pill = buildOverlay();
    applyTheme(pill);
    parent.insertBefore(pill, composer);
    renderInto(pill);
  }

  let bootAttempts = 0;
  const bootTimer = setInterval(() => {
    ensureMounted();
    reportModelIfChanged();
    if (++bootAttempts >= 30) clearInterval(bootTimer);
  }, 1000);

  let observerScheduled = false;
  const observer = new MutationObserver(() => {
    if (observerScheduled) return;
    observerScheduled = true;
    setTimeout(() => {
      observerScheduled = false;
      ensureMounted();
      reportModelIfChanged();
    }, 400);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // React to live theme toggles on claude.ai (no page reload needed). Claude's
  // theme switch flips classes/attributes on <html>/<body>; we also listen for
  // OS-level changes in case the app is following the system preference.
  const themeObserver = new MutationObserver(() => refreshTheme());
  const themeAttrFilter = {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme", "data-mode", "data-color-scheme", "data-color-mode"],
  };
  themeObserver.observe(document.documentElement, themeAttrFilter);
  if (document.body) themeObserver.observe(document.body, themeAttrFilter);
  if (window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onMqChange = () => refreshTheme();
    if (mq.addEventListener) mq.addEventListener("change", onMqChange);
    else if (mq.addListener) mq.addListener(onMqChange);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "query-strip-visible") {
      const el = document.getElementById(OVERLAY_ID);
      const visible = !!(el && el.isConnected && el.getClientRects().length > 0);
      sendResponse({ visible });
      return; // synchronous response
    }
    if (msg.type === "restore-strip") {
      ensureMounted();
      return;
    }
    if (msg.type !== "usage-updated") return;
    latestUsage = msg.usage;
    if (msg.usage && msg.usage.messagesRemaining != null) {
      latestMsgsRemaining = msg.usage.messagesRemaining;
    }
    const root = document.getElementById(OVERLAY_ID);
    if (root) renderInto(root);
  });

  (async () => {
    try {
      const resp = await chrome.runtime.sendMessage({ type: "get-state" });
      if (resp && resp.usage) {
        latestUsage = resp.usage;
        latestMsgsRemaining = resp.usage.messagesRemaining;
      }
      try {
        const { [RATE_KEY]: rv } = await chrome.storage.local.get(RATE_KEY);
        rated = !!rv;
      } catch (_) {}
      ensureMounted();
    } catch (_) {}
  })();

  // React to live changes of the "rate us" marker from elsewhere.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[RATE_KEY]) {
      rated = !!changes[RATE_KEY].newValue;
      applyRateVisibility(document.getElementById(OVERLAY_ID));
    }
  });

  setInterval(() => {
    const root = document.getElementById(OVERLAY_ID);
    if (root) renderInto(root);
  }, 30 * 1000);

  // ===== screen-recording / tab-visibility fix (v1.1.5) =====
  // Screen capture tools (e.g. Screen Studio on macOS) cause Chrome to mark
  // the window as "hidden" via the Page Visibility API. Chrome then throttles
  // or suspends the background service worker, stopping chrome.alarms — so
  // pollUsage() never runs and the strip shows stale "—" data for the entire
  // recording session.
  //
  // Fix 1 — visibilitychange: when the tab becomes visible again (recording
  // paused, window brought back to focus, or recording stopped) we immediately
  // request a fresh poll so the strip is up to date at once.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      try { chrome.runtime.sendMessage({ type: "force-refresh" }); } catch (_) {}
    }
  });

  // Fix 2 — keepalive ping: send a no-op message to the background service
  // worker every 20 s. The act of receiving a message prevents Chrome from
  // killing an idle service worker, so chrome.alarms keeps firing at its
  // normal 1-minute interval throughout a screen-recording session.
  setInterval(() => {
    try { chrome.runtime.sendMessage({ type: "keepalive" }); } catch (_) {}
  }, 20000);
})();
