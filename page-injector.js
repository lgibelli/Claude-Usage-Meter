// page-injector.js (main world)
// Patches window.fetch so we can tee SSE response streams from Claude.ai's
// chat completion endpoints and read the `message_limit` event without
// disturbing the page's own consumption of the stream.
//
// v1.2.6: fix the strip sticking below 100% after a real lockout. When the cap
//   is hit, the completion request returns an HTTP 429 (or 403) with a JSON
//   error body — not an SSE stream — so the SSE scanner never saw it and no
//   "reached" signal fired, leaving the strip at the polled ~98% utilization.
//   We now treat that error status as the authoritative lockout: read a clone
//   of the body (page keeps the original), pull a reset time from the body or
//   the Retry-After header, and emit reached=true so the session pins to 100%.
//   Also broadened the SSE "reached" hints (rate_limit / usage_limit / too_many).

(function () {
  if (window.__claudeUsageMeterInjected) return;
  window.__claudeUsageMeterInjected = true;

  const ORIGINAL_FETCH = window.fetch.bind(window);

  function postToContent(payload) {
    window.postMessage(
      { source: "claude-usage-meter", payload },
      window.location.origin
    );
  }

  function isCompletionUrl(url) {
    if (!url || typeof url !== "string") return false;
    return /claude\.ai\/api\/.*\/(completion|retry_completion)(\?|$)/.test(url);
  }

  // Recursively look through any parsed JSON object for fields that look like
  // a remaining-message count. Claude's SSE payloads embed message-limit info
  // in a few different shapes depending on the event type, so we scan loosely.
  const REMAINING_KEYS = [
    "remaining", "messages_remaining", "messages_left",
    "remainingMessages", "remaining_messages", "n_remaining"
  ];

  function findRemaining(obj, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 6) return null;
    for (const k of Object.keys(obj)) {
      if (REMAINING_KEYS.includes(k) && typeof obj[k] === "number") return obj[k];
      const v = obj[k];
      if (v && typeof v === "object") {
        const r = findRemaining(v, depth + 1);
        if (r != null) return r;
      }
    }
    return null;
  }

  function findResetAt(obj, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 6) return null;
    for (const k of Object.keys(obj)) {
      const lower = k.toLowerCase();
      if ((lower.includes("reset") || lower.includes("resetsat")) && typeof obj[k] === "string") {
        return obj[k];
      }
      const v = obj[k];
      if (v && typeof v === "object") {
        const r = findResetAt(v, depth + 1);
        if (r != null) return r;
      }
    }
    return null;
  }

  function looksLikeMessageLimit(obj) {
    if (!obj || typeof obj !== "object") return false;
    if (obj.type && typeof obj.type === "string" &&
        obj.type.toLowerCase().includes("message_limit")) return true;
    if (obj.message_limit && typeof obj.message_limit === "object") return true;
    if (obj.event && typeof obj.event === "string" &&
        obj.event.toLowerCase().includes("limit")) return true;
    return false;
  }

  // Detect whether a message_limit payload signals the limit is actually
  // *reached* (hard lockout), as opposed to just reporting a remaining count.
  // Claude's lockout bar ("Usage limit reached") is driven by this event, not
  // by the /usage poll — which can still read ~0% for the fresh window at the
  // moment the cap is hit. Field names vary, so scan loosely for a status/type
  // string like "reached"/"exceeded"/"exhausted" or a truthy *_reached flag.
  const REACHED_HINTS = [
    "reached", "exceeded", "exhausted", "limit_hit", "out_of_messages",
    // v1.2.6: Claude's lockout error bodies phrase it differently depending on
    // plan/endpoint — free-tier session lockouts commonly surface as a
    // rate_limit_error / usage_limit_reached rather than the words above.
    "rate_limit", "usage_limit", "too_many"
  ];
  function detectReached(obj, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 6) return false;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      const lk = k.toLowerCase();
      if (typeof v === "string") {
        const lv = v.toLowerCase();
        if ((lk.includes("type") || lk.includes("status") || lk.includes("event") || lk.includes("reason")) &&
            REACHED_HINTS.some((h) => lv.includes(h))) return true;
      }
      if (v === true && (lk.includes("reached") || lk.includes("exceeded") || lk.includes("exhausted"))) {
        return true;
      }
      if (v && typeof v === "object") {
        if (detectReached(v, depth + 1)) return true;
      }
    }
    return false;
  }

  function inspectJsonChunk(jsonStr) {
    try {
      const obj = JSON.parse(jsonStr);
      // Two cases worth emitting:
      // (a) The object explicitly references message_limit
      // (b) The object has a remaining-messages-shaped number somewhere
      if (looksLikeMessageLimit(obj) || findRemaining(obj) != null) {
        const remaining = findRemaining(obj);
        const resetsAt = findResetAt(obj);
        const reached = detectReached(obj) || remaining === 0;
        if (remaining != null || resetsAt || reached) {
          postToContent({
            kind: "message_limit",
            remaining,
            resetsAt: resetsAt || null,
            reached,
            ts: Date.now()
          });
        }
      }
    } catch (_) { /* not JSON or partial */ }
  }

  async function teeAndScanSSE(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE events are separated by a blank line.
        let sep;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const eventBlock = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          // Concatenate all `data:` payload lines within the event.
          const dataLines = [];
          for (const rawLine of eventBlock.split("\n")) {
            if (rawLine.startsWith("data:")) {
              dataLines.push(rawLine.slice(5).replace(/^ /, ""));
            }
          }
          if (dataLines.length === 0) continue;
          inspectJsonChunk(dataLines.join("\n"));
        }
      }
    } catch (_) { /* stream cancelled or aborted — fine */ }
  }

  window.fetch = async function patchedFetch(input, init) {
    const response = await ORIGINAL_FETCH(input, init);
    try {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      if (!isCompletionUrl(url)) return response;

      // v1.2.6: hard-lockout via HTTP status. When the session/weekly cap is
      // hit, the completion request comes back as an ERROR (429 Too Many
      // Requests, occasionally 403) carrying a JSON body — NOT an SSE stream.
      // The scanner below only understands SSE, so this response would slip
      // through, and the polled /usage utilization can sit at ~98% at this exact
      // moment — which is why the strip could stick below 100% after a real
      // lockout. Treat this status as the authoritative "maxed out" signal.
      // We read a *clone* so the page still consumes the untouched original.
      if (response.status === 429 || response.status === 403) {
        try {
          const text = await response.clone().text();
          let parsed = null;
          try { parsed = JSON.parse(text); } catch (_) {}
          // 429 is unconditionally rate/limit related. Only treat 403 as a
          // lockout when the body actually references a limit, so we don't
          // misread generic auth/permission errors as "you're maxed out".
          const limitish = response.status === 429 ||
            /limit|exceed|exhaust|quota|too\s*many/i.test(text || "");
          if (limitish) {
            // Reset time: prefer an explicit timestamp in the body; otherwise
            // fall back to the standard Retry-After header (seconds from now).
            let resetsAt = (parsed && findResetAt(parsed)) || null;
            if (!resetsAt) {
              const ra = response.headers && response.headers.get("retry-after");
              const secs = ra != null ? parseInt(ra, 10) : NaN;
              if (!isNaN(secs) && secs > 0) {
                resetsAt = new Date(Date.now() + secs * 1000).toISOString();
              }
            }
            postToContent({
              kind: "message_limit",
              remaining: 0,
              resetsAt: resetsAt || null,
              reached: true,
              ts: Date.now()
            });
          }
        } catch (_) { /* body not readable — ignore, page is unaffected */ }
        return response;
      }

      if (!response.body) return response;

      // Tee the body so the page gets one branch and we scan the other.
      const [forPage, forScan] = response.body.tee();
      teeAndScanSSE(forScan);

      // Re-wrap with the page-bound stream. Preserve all other response metadata.
      const wrapped = new Response(forPage, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
      // Preserve URL field where possible
      try { Object.defineProperty(wrapped, "url", { value: response.url }); } catch (_) {}
      return wrapped;
    } catch (e) {
      // Never let interception break the page.
      return response;
    }
  };
})();
