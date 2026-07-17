// KnowledgeVault content script — resilient scraper for saved Facebook posts/reels.
// Strategy: rely on stable semantic signals (role="article", href patterns) rather than
// obfuscated class names, so DOM/markup churn doesn't break capture.

const state = {
  seen: new Set(),
  auto: false, // auto-scan on scroll/mutations
  autoCapture: false, // auto-send every new post as it's found
  found: 0, // post containers detected on the page
  processed: 0, // already in the vault
  new: 0, // not yet captured
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
        if (cb) cb(null);
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
    if (cb) cb(null);
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

// Only ever capture from the Saved page — never messages, notifications,
// the home feed, etc.
function isSavedPage() {
  try {
    return /\/saved(\/|$|\?)/i.test(location.pathname);
  } catch {
    return false;
  }
}

// Skip the Messenger chat dock, notification menus/toasts, and other non-post
// UI chrome so we only capture actual saved posts/reels (never messages or
// notifications).
function inUiRegion(el) {
  let n = el;
  while (n && n.getAttribute) {
    const role = n.getAttribute("role");
    const label = (n.getAttribute("aria-label") || "").toLowerCase();
    if (role === "complementary") return true; // Messenger dock
    if (role === "alert") return true;          // toasts / popovers
    if (/messenger|conversation|notification/.test(label)) return true;
    n = n.parentElement;
  }
  return false;
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
    /(\/posts\/|\/permalink\/|\/permalink\.php|\/story\.php)/.test(lc) ||
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
  if (inUiRegion(article)) return null; // skip chat dock / notifications / toasts
  const aria = (article.getAttribute && article.getAttribute("aria-label") || "").toLowerCase();
  if (aria.startsWith("message")) return null; // Messenger bubble
  if (aria.startsWith("notification")) return null; // notification item
  let text = "";
  try {
    text = (article.innerText || "").replace(/\s+/g, " ").trim();
  } catch {
    return null;
  }
  if (text.length < 15) return null;
  if (/\bmessage sent\b/i.test(text)) return null; // chat-like text backup
  if (/\bnew notification\b/i.test(text)) return null; // notification text backup
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
  if (/\/permalink\.php/.test(lc)) return true; // story_fbid + id form
  if (lc.includes("l.facebook.com")) {
    // External redirect wrapper. Decode it: if the target is itself a Facebook
    // permalink we treat it as one; otherwise it's a saved external link post
    // (e.g. a GitHub repo) which we still want to climb to and capture.
    const real = decodeExternal(href).toLowerCase();
    if (/facebook\.com\/(posts|permalink|story\.php|reel|videos|watch|groups\/[0-9]+\/posts)/.test(real)) return true;
    return !isFacebook(real); // external link post -> climb & capture
  }
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

// Ask the backend which of these posts are already captured (by source_id or
// post_url). Returns a map of key -> status.
function checkProcessed(ids, urls) {
  return new Promise((resolve) => {
    kvSend({ type: "check", payload: { ids, urls } }, (resp) => {
      resolve((resp && resp.found) || {});
    });
  });
}

async function scan() {
  if (state.dead) return;
  if (state.scanning) return;
  if (!isSavedPage()) return; // only the Saved page has real posts
  state.scanning = true;
  try {
    const articles = findPosts();
    state.found = articles.length;
    const items = [];
    const els = [];
    for (const art of articles) {
      const flag = art.querySelector(":scope > .kv-flag");
      if (flag && flag.classList.contains("done")) continue; // already in the vault
      // Already tagged but auto-capture is off -> leave the Capture button as-is.
      if (flag && !state.autoCapture) continue;
      const it = art._kvItem || extractItem(art);
      if (!it) continue;
      art._kvItem = it; // stash for the Capture button
      items.push(it);
      els.push(art);
    }
    const found = items.length
      ? await checkProcessed(
          items.map((i) => i.source_id),
          items.map((i) => i.post_url).filter(Boolean)
        )
      : {};
    items.forEach((it, idx) => {
      const key = found[it.source_id] || (it.post_url && found[it.post_url]);
      const el = els[idx];
      if (key) {
        renderFlag(el, it, true);
      } else if (state.autoCapture) {
        captureOne(el, it); // send immediately, flip to "in vault"
      } else {
        renderFlag(el, it, false); // show a Capture button
      }
    });
  } catch (e) {
    console.warn("[KV] scan error", e);
  } finally {
    // Count from the DOM so the totals stay stable across re-scans (flags
    // persist on already-tagged posts).
    const flags = document.querySelectorAll(".kv-flag");
    let processed = 0;
    flags.forEach((f) => {
      if (f.classList.contains("done")) processed++;
    });
    state.processed = processed;
    state.new = flags.length - processed;
    state.scanning = false;
    updateBadge();
  }
}

// Render an inline indicator on the right of a post: a green "✓ in vault" chip
// if it's already captured, or a "Capture" button that sends just this post.
function renderFlag(el, item, processed) {
  el.style.position = el.style.position || "relative";
  let flag = el.querySelector(":scope > .kv-flag");
  if (!flag) {
    flag = document.createElement("div");
    flag.className = "kv-flag";
    el.appendChild(flag);
  }
  flag.innerHTML = "";
  flag.classList.toggle("done", processed);
  if (processed) {
    flag.textContent = "✓ in vault";
    flag.title = "Already captured in KnowledgeVault";
  } else {
    const btn = document.createElement("button");
    btn.className = "kv-capture";
    btn.textContent = "Capture";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      captureOne(el, item);
    });
    flag.appendChild(btn);
  }
}

function captureOne(el, item) {
  kvSend({ type: "capture", items: [item] }); // queued by background, deduped by backend
  renderFlag(el, item, true); // optimistic flip to "in vault"
  state.processed = (state.processed || 0) + 1;
  state.new = Math.max(0, (state.new || 0) - 1);
  updateBadge();
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

function setAutoCapture(on) {
  state.autoCapture = on;
  if (on) scan(); // capture currently-visible new posts immediately
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

function toggleMin(badge) {
  const min = !badge.classList.contains("kv-min");
  badge.classList.toggle("kv-min", min);
  const btn = badge.querySelector("#kv-min");
  if (btn) btn.textContent = min ? "+" : "–";
  chrome.storage.local.set({ kvBadgeMin: min });
}

// Drag the badge around by its header; position is persisted so it stays put.
function makeDraggable(badge) {
  const head = badge.querySelector(".kv-head");
  let dragging = false;
  let offX = 0;
  let offY = 0;
  head.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("#kv-min")) return; // don't drag from the minimize button
    const rect = badge.getBoundingClientRect();
    badge.style.left = rect.left + "px";
    badge.style.top = rect.top + "px";
    badge.style.right = "auto";
    badge.style.bottom = "auto";
    offX = e.clientX - rect.left;
    offY = e.clientY - rect.top;
    dragging = true;
    badge.classList.add("kv-dragging");
    e.preventDefault();
    const onMove = (ev) => {
      if (!dragging) return;
      let x = ev.clientX - offX;
      let y = ev.clientY - offY;
      x = Math.max(0, Math.min(x, window.innerWidth - badge.offsetWidth));
      y = Math.max(0, Math.min(y, window.innerHeight - badge.offsetHeight));
      badge.style.left = x + "px";
      badge.style.top = y + "px";
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      badge.classList.remove("kv-dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      chrome.storage.local.set({
        kvBadgePos: {
          left: parseInt(badge.style.left, 10),
          top: parseInt(badge.style.top, 10),
        },
      });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

function updateBadge() {
  let badge = document.getElementById("kv-badge");
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "kv-badge";
    badge.innerHTML = `
      <div class="kv-head">
        <span class="kv-title">KnowledgeVault</span>
        <button id="kv-min" class="kv-minbtn" title="Minimize">–</button>
      </div>
      <div class="kv-stats">
        <span>found: <b id="kv-found">0</b></span>
        <span>in vault: <b id="kv-proc">0</b></span>
        <span>new: <b id="kv-new">0</b></span>
      </div>
      <div class="kv-btns">
        <button id="kv-scan">Scan now</button>
        <button id="kv-auto">Auto: off</button>
        <button id="kv-autocap" title="Automatically capture every new post as it is found">Auto-cap: off</button>
      </div>
      <div class="kv-err" id="kv-err"></div>`;
    document.body.appendChild(badge);
    badge.querySelector("#kv-scan").onclick = () => scan();
    badge.querySelector("#kv-auto").onclick = () => setAuto(!state.auto);
    badge.querySelector("#kv-autocap").onclick = () => setAutoCapture(!state.autoCapture);
    badge.querySelector("#kv-min").onclick = (e) => {
      e.stopPropagation();
      toggleMin(badge);
    };
    makeDraggable(badge);
    chrome.storage.local.get({ kvBadgePos: null, kvBadgeMin: false }, (r) => {
      if (r.kvBadgePos && typeof r.kvBadgePos.left === "number") {
        badge.style.left = r.kvBadgePos.left + "px";
        badge.style.top = r.kvBadgePos.top + "px";
        badge.style.right = "auto";
        badge.style.bottom = "auto";
      }
      if (r.kvBadgeMin) {
        badge.classList.add("kv-min");
        const b = badge.querySelector("#kv-min");
        if (b) b.textContent = "+";
      }
    });
  }
  badge.querySelector("#kv-found").textContent = state.found;
  badge.querySelector("#kv-proc").textContent = state.processed;
  badge.querySelector("#kv-new").textContent = state.new;
  const autoBtn = badge.querySelector("#kv-auto");
  autoBtn.textContent = "Auto: " + (state.auto ? "on" : "off");
  autoBtn.classList.toggle("on", state.auto);
  const autoCapBtn = badge.querySelector("#kv-autocap");
  autoCapBtn.textContent = "Auto-cap: " + (state.autoCapture ? "on" : "off");
  autoCapBtn.classList.toggle("on", state.autoCapture);
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
