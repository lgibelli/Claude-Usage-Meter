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
  const DONATE_KEY = "donate_clicked_at";
  const DONATE_LINK = "https://buymeacoffee.com/selectorshub";
  const DONATE_COOLDOWN = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds
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
  let donateVisible = true;
  let shared = false;
  let collapsed = false;
  const COLLAPSE_KEY = "strip_collapsed";

  function applyCollapsed(root) {
    if (!root) return;
    root.classList.toggle("cut-collapsed", collapsed);
    const btn = root.querySelector('[data-cut="collapse"]');
    const tip = root.querySelector('[data-cut="collapse-tip"]');
    if (btn) btn.setAttribute("aria-label", collapsed ? "Expand the usage strip" : "Collapse the usage strip");
    if (tip) tip.textContent = collapsed
      ? "Expand the strip back to the full view."
      : "Collapse the strip to a compact view (S = session, W = weekly). Click again anytime to expand.";
  }
  const SHARE_KEY = "share_clicked";
  const CHROME_STORE_URL = "https://chromewebstore.google.com/detail/kgpahkcgadpnklinijdojapiadnfelae?utm_source=item-share-cb";
  const EDGE_STORE_URL = "https://microsoftedge.microsoft.com/addons/detail/claude-usage-meter/anhdhmpfpgbohohjlbgnggnmcmkmmcbn";
  function storeUrl() {
    try {
      const brands = navigator.userAgentData && navigator.userAgentData.brands;
      if (Array.isArray(brands) && brands.some((b) => /edge/i.test(b.brand))) return EDGE_STORE_URL;
    } catch (_) {}
    try {
      if (/Edg(e|A|iOS)?\//i.test(navigator.userAgent || "")) return EDGE_STORE_URL;
    } catch (_) {}
    return CHROME_STORE_URL;
  }
  const SHARE_TEXT = "Claude Usage Meter - see your Claude session & weekly usage limits live above the claude chat box. Free extension:";
  const LINKEDIN_TEXT = "Claude Usage Meter - see your Claude usage above chat";
  function shareIntentUrl(net) {
    const u = encodeURIComponent(storeUrl());
    const t = encodeURIComponent(SHARE_TEXT);
    switch (net) {
      case "linkedin": return `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(LINKEDIN_TEXT + " " + storeUrl())}`;
      case "x": return `https://twitter.com/intent/tweet?text=${t}&url=${u}`;
      case "whatsapp": return `https://api.whatsapp.com/send?text=${t}%20${u}`;
      case "reddit": return `https://www.reddit.com/submit?url=${u}&title=${t}`;
      case "facebook": return `https://www.facebook.com/sharer/sharer.php?u=${u}&quote=${t}`;
      default: return storeUrl();
    }
  }
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
        <div class="cut-compact" data-cut="compact">
          <span class="cut-cwrap">
            <span class="cut-cval" tabindex="0"><span class="cut-clabel">S</span> <span class="cut-cpct" data-cut="c-session">—</span></span>
            <span class="cut-ctip" data-cut="c-session-tip" aria-hidden="true">Waiting for data</span>
          </span>
          <span class="cut-cdivider" aria-hidden="true"></span>
          <span class="cut-cwrap">
            <span class="cut-cval" tabindex="0"><span class="cut-clabel">W</span> <span class="cut-cpct" data-cut="c-weekly">—</span></span>
            <span class="cut-ctip" data-cut="c-weekly-tip" aria-hidden="true">Waiting for data</span>
          </span>
        </div>
        <div class="cut-divider cut-msgs-divider" data-cut="msgs-divider" hidden></div>
        <span class="cut-msgs" data-cut="msgs" hidden></span>
        <div class="cut-divider cut-rate-divider" data-cut="rate-divider"></div>
        <span class="cut-rate-wrap" data-cut="rate-wrap">
          <button class="cut-rate" type="button" data-cut="rate"
                  aria-label="Rate Claude Usage Meter on the Chrome Web Store">
            <span class="cut-rate-star">⭐️</span><span class="cut-rate-txt">Rate us</span>
          </button>
          <span class="cut-rate-tooltip" aria-hidden="true">Pls Rate us & this button disappears forever after you review.</span>
        </span>
        <div class="cut-divider cut-share-divider" data-cut="share-divider" style="display:none"></div>
        <span class="cut-share-wrap" data-cut="share-wrap" style="display:none">
          <button class="cut-share" type="button" data-cut="share" aria-label="Share Claude Usage Meter" title="">
            <svg class="cut-share-ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>
          </button>
          <span class="cut-share-tooltip" aria-hidden="true">Share with friends - this button disappears forever once you share.</span>
          <span class="cut-share-pop" data-cut="share-pop" style="display:none">
            <button class="cut-share-net" data-net="linkedin" title="Share on LinkedIn" aria-label="Share on LinkedIn"><svg viewBox="0 0 382 382" width="18" height="18"><path fill="#0077B7" d="M347.445,0H34.555C15.471,0,0,15.471,0,34.555v312.889C0,366.529,15.471,382,34.555,382h312.889 C366.529,382,382,366.529,382,347.444V34.555C382,15.471,366.529,0,347.445,0z M118.207,329.844c0,5.554-4.502,10.056-10.056,10.056 H65.345c-5.554,0-10.056-4.502-10.056-10.056V150.403c0-5.554,4.502-10.056,10.056-10.056h42.806 c5.554,0,10.056,4.502,10.056,10.056V329.844z M86.748,123.432c-22.459,0-40.666-18.207-40.666-40.666S64.289,42.1,86.748,42.1 s40.666,18.207,40.666,40.666S109.208,123.432,86.748,123.432z M341.91,330.654c0,5.106-4.14,9.246-9.246,9.246H286.73 c-5.106,0-9.246-4.14-9.246-9.246v-84.168c0-12.556,3.683-55.021-32.813-55.021c-28.309,0-34.051,29.066-35.204,42.11v97.079 c0,5.106-4.139,9.246-9.246,9.246h-44.426c-5.106,0-9.246-4.14-9.246-9.246V149.593c0-5.106,4.14-9.246,9.246-9.246h44.426 c5.106,0,9.246,4.14,9.246,9.246v15.655c10.497-15.753,26.097-27.912,59.312-27.912c73.552,0,73.131,68.716,73.131,106.472 L341.91,330.654L341.91,330.654z"/></svg></button>
            <button class="cut-share-net" data-net="x" title="Share on X" aria-label="Share on X"><svg viewBox="0 0 24 24" width="18" height="18"><rect width="24" height="24" rx="5" fill="#000"/><path transform="translate(4.8 4.8) scale(0.6)" fill="#fff" d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8 -7.584 -6.638 7.584H0.474l8.6 -9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/></svg></button>
            <button class="cut-share-net" data-net="whatsapp" title="Share on WhatsApp" aria-label="Share on WhatsApp"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="20.0 19.1 581.6 581.6" width="18" height="18"><defs><linearGradient x1=".5" y1="0" x2=".5" y2="1" id="cwa-a"><stop stop-color="#20B038" offset="0%"/><stop stop-color="#60D66A" offset="100%"/></linearGradient><linearGradient x1=".5" y1="0" x2=".5" y2="1" id="cwa-b"><stop stop-color="#F9F9F9" offset="0%"/><stop stop-color="#FFF" offset="100%"/></linearGradient><linearGradient xlink:href="#cwa-a" id="cwa-f" x1="270.265" y1="1.184" x2="270.265" y2="541.56" gradientTransform="scale(.99775 1.00225)" gradientUnits="userSpaceOnUse"/><linearGradient xlink:href="#cwa-b" id="cwa-g" x1="279.952" y1=".811" x2="279.952" y2="560.571" gradientTransform="scale(.99777 1.00224)" gradientUnits="userSpaceOnUse"/><filter x="-.056" y="-.062" width="1.112" height="1.11" filterUnits="objectBoundingBox" id="cwa-c"><feGaussianBlur stdDeviation="2" in="SourceGraphic"/></filter><filter x="-.082" y="-.088" width="1.164" height="1.162" filterUnits="objectBoundingBox" id="cwa-d"><feOffset dy="-4" in="SourceAlpha" result="shadowOffsetOuter1"/><feGaussianBlur stdDeviation="12.5" in="shadowOffsetOuter1" result="shadowBlurOuter1"/><feComposite in="shadowBlurOuter1" in2="SourceAlpha" operator="out" result="shadowBlurOuter1"/><feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.21 0" in="shadowBlurOuter1"/></filter><path d="M576.337 707.516c-.018-49.17 12.795-97.167 37.15-139.475L574 423.48l147.548 38.792c40.652-22.23 86.423-33.944 133.002-33.962h.12c153.395 0 278.265 125.166 278.33 278.98.025 74.548-28.9 144.642-81.446 197.373C999 957.393 929.12 986.447 854.67 986.48c-153.42 0-278.272-125.146-278.333-278.964z" id="cwa-e"/></defs><g fill="none" fill-rule="evenodd"><g transform="matrix(1 0 0 -1 -542.696 1013.504)" fill="#000" fill-rule="nonzero" filter="url(#cwa-c)"><use filter="url(#cwa-d)" xlink:href="#cwa-e" width="100%" height="100%"/><use fill-opacity=".2" xlink:href="#cwa-e" width="100%" height="100%"/></g><path transform="matrix(1 0 0 -1 41.304 577.504)" fill-rule="nonzero" fill="url(#cwa-f)" d="M2.325 274.421c-.014-47.29 12.342-93.466 35.839-134.166L.077 1.187l142.314 37.316C181.6 17.133 225.745 5.856 270.673 5.84h.12c147.95 0 268.386 120.396 268.447 268.372.03 71.707-27.87 139.132-78.559 189.858-50.68 50.726-118.084 78.676-189.898 78.708-147.968 0-268.398-120.386-268.458-268.358"/><path transform="matrix(1 0 0 -1 31.637 586.837)" fill-rule="nonzero" fill="url(#cwa-g)" d="M2.407 283.847c-.018-48.996 12.784-96.824 37.117-138.983L.072.814l147.419 38.654c40.616-22.15 86.346-33.824 132.885-33.841h.12c153.26 0 278.02 124.724 278.085 277.994.026 74.286-28.874 144.132-81.374 196.678-52.507 52.544-122.326 81.494-196.711 81.528-153.285 0-278.028-124.704-278.09-277.98zm87.789-131.724l-5.503 8.74C61.555 197.653 49.34 240.17 49.36 283.828c.049 127.399 103.73 231.044 231.224 231.044 61.74-.025 119.765-24.09 163.409-67.763 43.639-43.67 67.653-101.726 67.635-163.469-.054-127.403-103.739-231.063-231.131-231.063h-.09c-41.482.022-82.162 11.159-117.642 32.214l-8.444 5.004L66.84 66.86z"/><path d="M242.63 186.78c-5.205-11.57-10.684-11.803-15.636-12.006-4.05-.173-8.687-.162-13.316-.162-4.632 0-12.161 1.74-18.527 8.693-6.37 6.953-24.322 23.761-24.322 57.947 0 34.19 24.901 67.222 28.372 71.862 3.474 4.634 48.07 77.028 118.694 104.88 58.696 23.146 70.64 18.542 83.38 17.384 12.74-1.158 41.11-16.805 46.9-33.03 5.791-16.223 5.791-30.128 4.054-33.035-1.738-2.896-6.37-4.633-13.319-8.108-6.95-3.475-41.11-20.287-47.48-22.603-6.37-2.316-11.003-3.474-15.635 3.482-4.633 6.95-17.94 22.596-21.996 27.23-4.053 4.643-8.106 5.222-15.056 1.747-6.949-3.485-29.328-10.815-55.876-34.485-20.656-18.416-34.6-41.16-38.656-48.116-4.053-6.95-.433-10.714 3.052-14.178 3.12-3.113 6.95-8.11 10.424-12.168 3.467-4.057 4.626-6.953 6.942-11.586 2.316-4.64 1.158-8.698-.579-12.172-1.737-3.475-15.241-37.838-21.42-51.576" fill="#FFF"/></g></svg></button>
            <button class="cut-share-net" data-net="reddit" title="Share on Reddit" aria-label="Share on Reddit"><svg viewBox="0 0 24 24" width="18" height="18"><rect width="24" height="24" rx="5" fill="#FF4500"/><ellipse cx="12" cy="14.2" rx="7.2" ry="5" fill="#fff"/><circle cx="4.6" cy="12.4" r="1.9" fill="#fff"/><circle cx="19.4" cy="12.4" r="1.9" fill="#fff"/><circle cx="17.6" cy="4.8" r="1.5" fill="#fff"/><path d="M12 9.6l1.1-4.6 3.4.8" stroke="#fff" stroke-width="1" fill="none" stroke-linecap="round"/><circle cx="9.3" cy="13.4" r="1.2" fill="#FF4500"/><circle cx="14.7" cy="13.4" r="1.2" fill="#FF4500"/><path d="M9.4 16.4c1.6 1.2 3.6 1.2 5.2 0" stroke="#FF4500" stroke-width="1" fill="none" stroke-linecap="round"/></svg></button>
            <button class="cut-share-net" data-net="facebook" title="Share on Facebook" aria-label="Share on Facebook"><svg viewBox="0 0 16 16" width="18" height="18"><path fill="#1877F2" d="M15 8a7 7 0 0 0-7-7 7 7 0 0 0-1.094 13.915v-4.892H5.13V8h1.777V6.458c0-1.754 1.045-2.724 2.644-2.724.766 0 1.567.137 1.567.137v1.723h-.883c-.87 0-1.14.54-1.14 1.093V8h1.941l-.31 2.023H9.094v4.892A7 7 0 0 0 15 8"/><path fill="#fff" d="M10.725 10.023 11.035 8H9.094V6.687c0-.553.27-1.093 1.14-1.093h.883V3.87s-.801-.137-1.567-.137c-1.6 0-2.644.97-2.644 2.724V8H5.13v2.023h1.777v4.892a7 7 0 0 0 2.188 0v-4.892z"/></svg></button>
          </span>
        </span>
        <span class="cut-collapse-wrap">
          <button class="cut-collapse" type="button" data-cut="collapse" aria-label="Collapse the usage strip">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="11 17 6 12 11 7"></polyline><polyline points="18 17 13 12 18 7"></polyline></svg>
          </button>
          <span class="cut-collapse-tooltip" data-cut="collapse-tip" aria-hidden="true">Collapse the strip to a compact view (S = session, W = weekly). Click again anytime to expand.</span>
        </span>
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
        // Rate us is gone now — the Support button takes its place.
        applyDonateVisibility(root);
        // The Share button appears once the user has rated.
        applyShareVisibility(root);
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
    const donateLink = root.querySelector(".cut-donate");
    if (donateLink) {
      donateLink.addEventListener("click", (e) => {
        // Don't prevent default — let the link open normally
        // But save the timestamp for the 30-day cooldown
        try { chrome.storage.local.set({ [DONATE_KEY]: Date.now() }); } catch (_) {}
        applyDonateVisibility(root);
      });
    }
    const shareBtn = root.querySelector(".cut-share");
    if (shareBtn) {
      shareBtn.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        // Mark as shared immediately — the button never comes back after
        // this click, even if the user closes the popover without picking
        // a network.
        shared = true;
        try { chrome.storage.local.set({ [SHARE_KEY]: true }); } catch (_) {}
        openSharePop(root);
      });
    }
    root.querySelectorAll(".cut-share-net").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        const net = btn.getAttribute("data-net");
        try { window.open(shareIntentUrl(net), "_blank", "noopener"); } catch (_) {}
        closeSharePop(root);
      });
    });
    const collapseBtn = root.querySelector('[data-cut="collapse"]');
    if (collapseBtn) {
      collapseBtn.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        collapsed = !collapsed;
        try { chrome.storage.local.set({ [COLLAPSE_KEY]: collapsed }); } catch (_) {}
        applyCollapsed(root);
      });
    }
    applyRateVisibility(root);
    applyDonateVisibility(root);
    applyShareVisibility(root);
    applyCollapsed(root);
    attachTooltips(root);
    root.addEventListener("click", e => e.stopPropagation());
    return root;
  }

  // ---- Portal tooltips -------------------------------------------------
  // All hover tooltips render in a single fixed-position node under <body>.
  // CSS-only tooltips positioned inside the strip get clipped in small chat
  // windows (design/split mode) by ancestor overflow and the overlay's
  // containment, so — like the share popover — tooltips escape via a portal.
  let portalTipEl = null;

  function ensurePortalTip() {
    if (portalTipEl && portalTipEl.isConnected) return portalTipEl;
    portalTipEl = document.createElement("div");
    portalTipEl.className = "cut-portal-tip";
    portalTipEl.style.display = "none";
    document.body.appendChild(portalTipEl);
    return portalTipEl;
  }

  function showPortalTip(anchor, html) {
    if (!html) return;
    const root = document.getElementById(OVERLAY_ID);
    const tip = ensurePortalTip();
    tip.classList.toggle("cut-pop-dark", !!(root && root.classList.contains("cut-theme-dark")));
    tip.innerHTML = html;
    tip.style.display = "block";
    tip.style.visibility = "hidden";
    const ar = anchor.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    const margin = 8;
    const vw = window.innerWidth;
    let left = ar.left + ar.width / 2 - tr.width / 2;
    left = Math.max(margin, Math.min(left, vw - tr.width - margin));
    let top;
    if (ar.top >= tr.height + 14) {
      top = ar.top - tr.height - 8;
      tip.classList.remove("cut-pop-below");
    } else {
      top = ar.bottom + 8;
      tip.classList.add("cut-pop-below");
    }
    const arrowX = Math.max(10, Math.min(ar.left + ar.width / 2 - left, tr.width - 10));
    tip.style.setProperty("--cut-arrow-x", arrowX + "px");
    tip.style.left = left + "px";
    tip.style.top = top + "px";
    tip.style.visibility = "";
  }

  function hidePortalTip() {
    if (portalTipEl) portalTipEl.style.display = "none";
  }

  function attachTip(el, getHtml) {
    if (!el) return;
    el.addEventListener("mouseenter", () => showPortalTip(el, getHtml()));
    el.addEventListener("mouseleave", hidePortalTip);
    el.addEventListener("focusin", () => showPortalTip(el, getHtml()));
    el.addEventListener("focusout", hidePortalTip);
  }

  function attachTooltips(root) {
    const srcHtml = (wrapSel, tipSel) => {
      const w = root.querySelector(wrapSel);
      if (!w) return;
      attachTip(w, () => {
        // Suppress while the share popover is open on this wrap.
        if (w.classList.contains("cut-pop-open")) return "";
        const t = w.querySelector(tipSel);
        return t ? t.innerHTML : "";
      });
    };
    srcHtml(".cut-logo-wrap", ".cut-tooltip");
    srcHtml(".cut-rate-wrap", ".cut-rate-tooltip");
    srcHtml('[data-cut="share-wrap"]', ".cut-share-tooltip");
    srcHtml(".cut-collapse-wrap", ".cut-collapse-tooltip");
    srcHtml(".cut-close-wrap", ".cut-close-tooltip");
    root.querySelectorAll(".cut-cwrap").forEach((w) => {
      attachTip(w, () => {
        const t = w.querySelector(".cut-ctip");
        return t ? t.innerHTML : "";
      });
    });
    // Session / Weekly segments: dynamic "Resets in …" text kept fresh in a
    // data attribute by renderSegment. Only shown when the inline
    // "resets in …" meta is hidden by the narrow-width tiers (design/split
    // mode) — no point in a tooltip repeating what's already visible.
    root.querySelectorAll(".cut-seg").forEach((seg) => {
      attachTip(seg, () => {
        const meta = seg.querySelector("[data-cut-meta]");
        if (meta && getComputedStyle(meta).display !== "none") return "";
        return seg.dataset.cutTip || "";
      });
    });
    // Any click inside the strip may change state/text — drop the tip.
    root.addEventListener("click", hidePortalTip, true);
    // Positions go stale on scroll/resize (bind once globally).
    if (!attachTooltips._globalBound) {
      attachTooltips._globalBound = true;
      window.addEventListener("scroll", hidePortalTip, true);
      window.addEventListener("resize", hidePortalTip);
    }
  }

  function applyRateVisibility(root) {
    if (!root) return;
    const rb = root.querySelector('[data-cut="rate-wrap"]') || root.querySelector('[data-cut="rate"]');
    const rd = root.querySelector('[data-cut="rate-divider"]');
    const display = rated ? "none" : "";
    if (rb) rb.style.display = display;
    if (rd) rd.style.display = display;
  }

  let sharePopOpen = false;
  let sharePopOutsideHandler = null;
  let activeSharePop = null;   // the popover node while portaled to <body>
  let activeShareWrap = null;  // its original parent, to restore on close

  function applyShareVisibility(root) {
    if (!root) return;
    const sw = root.querySelector('[data-cut="share-wrap"]');
    const sd = root.querySelector('[data-cut="share-divider"]');
    if (!sw || !sd) return;
    // Visible only after the user has rated and before they've shared.
    // While the network popover is open, keep the wrap visible so the
    // popover stays anchored, even though the shared flag is already set.
    const show = (rated && !shared) || sharePopOpen;
    const display = show ? "" : "none";
    sw.style.display = display;
    sd.style.display = display;
  }

  function openSharePop(root) {
    const wrap = root.querySelector('[data-cut="share-wrap"]');
    const pop = root.querySelector('[data-cut="share-pop"]');
    const btn = root.querySelector('[data-cut="share"]');
    if (!wrap || !pop || !btn) return;
    sharePopOpen = true;
    wrap.classList.add("cut-pop-open");

    // Portal the popover to <body>: the overlay is a size container
    // (container-type creates layout containment) and the narrow-mode strip
    // scrolls, both of which clip/trap absolutely-positioned children in
    // small chat windows. A fixed-position node under <body> escapes both.
    activeSharePop = pop;
    activeShareWrap = wrap;
    pop.classList.add("cut-share-pop-portal");
    pop.classList.toggle("cut-pop-dark", root.classList.contains("cut-theme-dark"));
    document.body.appendChild(pop);
    pop.style.display = "flex";
    pop.style.position = "fixed";
    pop.style.visibility = "hidden";

    // Measure, then place above the button if there's room, else below.
    const br = btn.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    const margin = 8;
    const vw = window.innerWidth;
    let left = br.left + br.width / 2 - pr.width / 2;
    left = Math.max(margin, Math.min(left, vw - pr.width - margin));
    let top;
    if (br.top >= pr.height + 14) {
      top = br.top - pr.height - 10;
      pop.classList.remove("cut-pop-below");
    } else {
      top = br.bottom + 10;
      pop.classList.add("cut-pop-below");
    }
    // Keep the arrow pointing at the button even when clamped.
    const arrowX = Math.max(12, Math.min(br.left + br.width / 2 - left, pr.width - 12));
    pop.style.setProperty("--cut-arrow-x", arrowX + "px");
    pop.style.left = left + "px";
    pop.style.top = top + "px";
    pop.style.visibility = "";

    // Close when clicking anywhere outside the popover.
    sharePopOutsideHandler = (ev) => {
      if (!pop.contains(ev.target)) closeSharePop(root);
    };
    setTimeout(() => {
      document.addEventListener("click", sharePopOutsideHandler, true);
    }, 0);
  }

  function closeSharePop(root) {
    sharePopOpen = false;
    if (sharePopOutsideHandler) {
      document.removeEventListener("click", sharePopOutsideHandler, true);
      sharePopOutsideHandler = null;
    }
    const pop = activeSharePop || (root && root.querySelector('[data-cut="share-pop"]'));
    if (pop) {
      pop.style.display = "none";
      pop.style.position = "";
      pop.style.left = "";
      pop.style.top = "";
      pop.style.visibility = "";
      pop.classList.remove("cut-share-pop-portal", "cut-pop-dark", "cut-pop-below");
      // Return the node to its original wrap so the strip's lifecycle
      // (rebuilds, listeners) stays intact.
      if (activeShareWrap && activeShareWrap.isConnected) {
        activeShareWrap.appendChild(pop);
      } else if (pop.parentNode === document.body) {
        pop.remove();
      }
    }
    activeSharePop = null;
    const wrap = (activeShareWrap && activeShareWrap.isConnected)
      ? activeShareWrap
      : (root && root.querySelector('[data-cut="share-wrap"]'));
    activeShareWrap = null;
    if (wrap) wrap.classList.remove("cut-pop-open");
    applyShareVisibility(root);
  }

  async function applyDonateVisibility(root) {
    if (!root) return;
    const db = root.querySelector('[data-cut="donate-wrap"]') || root.querySelector('[data-cut="donate"]');
    const dd = root.querySelector('[data-cut="donate-divider"]');
    if (!db || !dd) return;

    // Support only appears once the Rate us button is gone (user has rated).
    // Never show both at the same time — keeps the strip compact.
    let shouldHide = !rated;

    // Also respect the 30-day cooldown after a donate click.
    if (!shouldHide) {
      try {
        const { [DONATE_KEY]: clickedAt } = await chrome.storage.local.get(DONATE_KEY);
        if (clickedAt && Date.now() - clickedAt < DONATE_COOLDOWN) {
          shouldHide = true;
        }
      } catch (_) {}
    }

    const display = shouldHide ? "none" : "";
    db.style.display = display;
    dd.style.display = display;
    donateVisible = !shouldHide;
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
      segEl.dataset.cutTip = data.resetsAt ? `Resets in ${fmtReset(data.resetsAt)}` : "No reset info";
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
      segEl.dataset.cutTip = "Waiting for data";
      dotEl.className = "cut-dot cut-color-neutral";
      segEl.classList.remove("cut-alert", "cut-alert-max");
    }
  }

  function renderCompact(root) {
    const items = [
      { valSel: '[data-cut="c-session"]', tipSel: '[data-cut="c-session-tip"]', letter: "S", name: "Session", data: latestUsage && latestUsage.session },
      { valSel: '[data-cut="c-weekly"]',  tipSel: '[data-cut="c-weekly-tip"]',  letter: "W", name: "Weekly",  data: latestUsage && latestUsage.weekly },
    ];
    for (const it of items) {
      const el = root.querySelector(it.valSel);
      const tipEl = root.querySelector(it.tipSel);
      if (!el || !tipEl) continue;
      if (it.data && it.data.percent != null) {
        const p = it.data.percent;
        el.textContent = `${p}%`;
        el.className = "cut-cpct cut-color-" + colorClass(p);
        tipEl.textContent = it.data.resetsAt
          ? `Resets in ${fmtReset(it.data.resetsAt)}`
          : "No reset info";
      } else {
        el.textContent = "—";
        el.className = "cut-cpct";
        tipEl.textContent = "Waiting for data";
      }
    }
  }

  function renderInto(root) {
    if (!root) return;
    renderSegment(root.querySelector('[data-cut="session"]'), latestUsage && latestUsage.session, "Session");
    renderSegment(root.querySelector('[data-cut="weekly"]'),  latestUsage && latestUsage.weekly,  weeklyLabel(latestUsage && latestUsage.weekly));
    renderCompact(root);
    applyRateVisibility(root);
    applyDonateVisibility(root);
    if (!sharePopOpen) applyShareVisibility(root);

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
        const { [RATE_KEY]: rv, [SHARE_KEY]: sv, [COLLAPSE_KEY]: cv } = await chrome.storage.local.get([RATE_KEY, SHARE_KEY, COLLAPSE_KEY]);
        rated = !!rv;
        shared = !!sv;
        collapsed = !!cv;
      } catch (_) {}
      ensureMounted();
    } catch (_) {}
  })();

  // React to live changes of the "rate us" marker from elsewhere.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[RATE_KEY]) {
      rated = !!changes[RATE_KEY].newValue;
      const root = document.getElementById(OVERLAY_ID);
      applyRateVisibility(root);
      // Donate and Share visibility depend on the rated flag too.
      if (root) {
        applyDonateVisibility(root);
        applyShareVisibility(root);
      }
    }
    if (changes[SHARE_KEY]) {
      shared = !!changes[SHARE_KEY].newValue;
      const root = document.getElementById(OVERLAY_ID);
      if (root && !sharePopOpen) applyShareVisibility(root);
    }
    if (changes[COLLAPSE_KEY]) {
      collapsed = !!changes[COLLAPSE_KEY].newValue;
      applyCollapsed(document.getElementById(OVERLAY_ID));
    }
    if (changes[DONATE_KEY]) {
      const root = document.getElementById(OVERLAY_ID);
      if (root) applyDonateVisibility(root);
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
