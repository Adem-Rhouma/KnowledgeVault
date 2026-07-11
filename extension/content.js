// KnowledgeVault content script — resilient scraper for saved Facebook posts/reels.
// Strategy: rely on stable semantic signals (role="article", href patterns) rather than
// obfuscated class names, so DOM/markup churn doesn't break capture.

const state = {
  seen: new Set(),
  pending: [],
  auto: false,
  captured: 0,
  found: 0,
  scanning: false,
  observer: null,
  dead: false, // true once the extension context is invalidated (e.g. after a reload)
};

// The extension was reloaded/disabled — stop all loops so we don't spam
// "Extension context invalidated" errors from an orphaned content script.
function markDead() {
  state.dead = true;
  try {
    setAuto(false);
  } catch {
    /* ignore */
  }
}

// chrome.runtime.sendMessage throws synchronously once the context is invalidated,
// so every call goes through this guard.
function kvSend(message, cb) {
  if (state.dead) return;
  try {
    chrome.runtime.sendMessage(message, (resp) => {
      if (chrome.runtime.lastError) {
        markDead();
        return;
      }
      if (cb) {
        try {
          cb(resp);
        } catch {
          /* ignore */
        }
      }
    });
  } catch {
    markDead();
  }
}

function isFacebook(href) {
  try {
    const h = new URL(href).hostname;
    return h.endsWith("facebook.com") || h.endsWith("fb.watch") || h.endsWith("instagram.com");
  } catch {
    return false;
  }
}

function decodeExternal(href) {
  try {
    const u = new URL(href);
    if (u.hostname.endsWith("l.facebook.com")) {
      const real = u.searchParams.get("u");
      if (real) return decodeURIComponent(real);
    }
  } catch {
    /* not a redirect link */
  }
  return href;
}

// A real, downloadable video needs an actual identifier — not a browsing tab like
// facebook.com/reel/?s=tab (which yt-dlp rejects as "Unsupported URL").
function isVideoUrl(href) {
  if (!href) return false;
  const lc = href.toLowerCase();
  return (
    /(^|[./])fb\.watch\/[a-z0-9_-]{4,}/i.test(lc) ||
    /\/(reel|videos)\/[a-z0-9_-]{6,}/i.test(lc) ||
    /\/watch\/?\?[^ ]*v=[a-z0-9_-]{6,}/i.test(lc) ||
    /\/watch\/[a-z0-9_-]{6,}/i.test(lc)
  );
}

function isPermalink(href) {
  if (!href) return false;
  const lc = href.toLowerCase();
  return (
    /(\/posts\/|\/permalink\/|\/story\.php)/.test(lc) ||
    /\/(reel|videos)\/[a-z0-9_-]{6,}/i.test(lc) ||
    /\/watch\/?\?[^ ]*v=[a-z0-9_-]{6,}/i.test(lc) ||
    /\/watch\/[a-z0-9_-]{6,}/i.test(lc)
  );
}

function findLinks(article) {
  const videoUrls = [];
  const external = [];
  let postUrl = null;
  let hasVideo = false;
  const anchors = article.querySelectorAll("a[href]");
  for (const a of anchors) {
    const href = a.href;
    if (!href) continue;
    const lc = href.toLowerCase();
    if (isVideoUrl(href)) {
      hasVideo = true;
      if (!videoUrls.includes(href)) videoUrls.push(href);
    }
    if (!postUrl && isPermalink(href)) {
      postUrl = href;
    }
    const real = decodeExternal(href);
    if (!isFacebook(real) && !external.includes(real)) external.push(real);
  }
  // For a reel/video post, the permalink itself is usually the watchable URL.
  if (hasVideo && postUrl && isVideoUrl(postUrl) && !videoUrls.includes(postUrl)) {
    videoUrls.push(postUrl);
  }
  return { videoUrls, external, postUrl };
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return "h" + (h >>> 0).toString(36);
}

function extractItem(article) {
  let text = "";
  try {
    text = (article.innerText || "").replace(/\s+/g, " ").trim();
  } catch {
    return null;
  }
  if (text.length < 15) return null;
  const { videoUrls, external, postUrl } = findLinks(article);
  if (!text && videoUrls.length === 0) return null;
  const key = postUrl || hash(text);
  if (state.seen.has(key)) return null;
  state.seen.add(key);
  const links = [...new Set([...external, ...videoUrls])].filter((l) => !isFacebook(l));
  return {
    source_id: key,
    post_text: text,
    video_urls: videoUrls,
    external_links: links,
    post_url: postUrl || "",
    captured_at: new Date().toISOString(),
    extra: {},
  };
}

function isPostPermalink(href) {
  if (!href) return false;
  const lc = href.toLowerCase();
  if (lc.includes("l.facebook.com")) return false; // redirect wrapper, not a permalink
  return /(\/posts\/|\/permalink\/|\/story\.php|\/reel\/|\/watch\/?\?|\/groups\/[0-9]+\/posts\/)/.test(lc);
}

// Climb up from a permalink anchor to the enclosing post block. Pick the LARGEST
// ancestor under a cap — the tiny "Reels • Saved from …" wrapper is too small, while
// the full post card (caption + media + links) is what we want. Avoid climbing to the
// whole document.
function climbToContainer(anchor) {
  const CAP = 6000;
  let best = anchor.parentElement || anchor;
  let bestLen = (best.innerText || "").trim().length;
  let el = anchor;
  for (let i = 0; i < 15; i++) {
    el = el.parentElement;
    if (!el) break;
    const len = (el.innerText || "").trim().length;
    if (len > bestLen && len <= CAP) {
      best = el;
      bestLen = len;
    }
  }
  return best;
}

// Posts may be <article>, role="article", or just cards with a permalink link
// (the Saved page falls into this last bucket). Cover all three.
function findPosts() {
  const seen = new Set();
  const out = [];
  const add = (el) => {
    if (el && !seen.has(el)) {
      seen.add(el);
      out.push(el);
    }
  };
  document.querySelectorAll('article, [role="article"]').forEach(add);
  document.querySelectorAll("a[href]").forEach((a) => {
    if (isPostPermalink(a.href)) add(climbToContainer(a));
  });
  return out;
}

function scan() {
  if (state.dead) return;
  if (state.scanning) return;
  state.scanning = true;
  try {
    const articles = findPosts();
    state.found = articles.length;
    let added = 0;
    for (const art of articles) {
      const it = extractItem(art);
      if (it) {
        state.pending.push(it);
        state.captured++;
        added++;
      }
    }
    if (added) flushPending();
  } catch (e) {
    console.warn("[KV] scan error", e);
  } finally {
    state.scanning = false;
    updateBadge();
  }
}

function flushPending() {
  if (!state.pending.length) return;
  const items = state.pending;
  state.pending = [];
  kvSend({ type: "capture", items }, () => updateBadge());
}

function setAuto(on) {
  state.auto = on;
  if (on) {
    if (!state.observer) {
      state.observer = new MutationObserver(() => scheduleScan());
      state.observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    window.addEventListener("scroll", scheduleScan, { passive: true });
    state._interval = setInterval(scan, 2500);
    scan();
  } else {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    window.removeEventListener("scroll", scheduleScan);
    clearInterval(state._interval);
  }
  updateBadge();
}

let _scanTimer = null;
function scheduleScan() {
  if (state.dead) return;
  if (_scanTimer) return;
  _scanTimer = setTimeout(() => {
    _scanTimer = null;
    scan();
  }, 400);
}

function updateBadge() {
  let badge = document.getElementById("kv-badge");
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "kv-badge";
    badge.innerHTML = `
      <div class="kv-head">KnowledgeVault</div>
      <div class="kv-stats">
        <span>captured: <b id="kv-cap">0</b></span>
        <span>found: <b id="kv-found">0</b></span>
        <span>queued: <b id="kv-q">0</b></span>
      </div>
      <div class="kv-btns">
        <button id="kv-scan">Scan now</button>
        <button id="kv-auto">Auto: off</button>
      </div>
      <div class="kv-err" id="kv-err"></div>`;
    document.body.appendChild(badge);
    badge.querySelector("#kv-scan").onclick = () => scan();
    badge.querySelector("#kv-auto").onclick = () => setAuto(!state.auto);
  }
  badge.querySelector("#kv-cap").textContent = state.captured;
  badge.querySelector("#kv-found").textContent = state.found;
  badge.querySelector("#kv-q").textContent = state.pending.length;
  const autoBtn = badge.querySelector("#kv-auto");
  autoBtn.textContent = "Auto: " + (state.auto ? "on" : "off");
  autoBtn.classList.toggle("on", state.auto);
  kvSend({ type: "getStatus" }, (resp) => {
    if (resp && resp.status) {
      const err = resp.status.error;
      badge.querySelector("#kv-err").textContent = err ? "backend: " + err : "";
    }
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "control") {
    if (msg.action === "scan") scan();
    else if (msg.action === "start") setAuto(true);
    else if (msg.action === "stop") setAuto(false);
    sendResponse({ ok: true, auto: state.auto, captured: state.captured });
    return true;
  }
});

// Expose a manual trigger from the popup even when auto is off.
setAuto(false);
updateBadge();
