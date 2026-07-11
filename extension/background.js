// KnowledgeVault background — buffers captured items and flushes to the local backend
// with retry. The browser tab may disappear; the queue lives here so nothing is lost.

let queue = [];
let timer = null;
let status = { captured: 0, sent: 0, error: null, lastSync: null };

chrome.storage.local.get({ kvStatus: null, backendUrl: "http://localhost:8000" }, (r) => {
  if (r.kvStatus) status = r.kvStatus;
});

function saveStatus() {
  chrome.storage.local.set({ kvStatus: status });
}

async function flush() {
  if (!queue.length) return;
  const items = queue;
  queue = [];
  const { backendUrl } = await chrome.storage.local.get({ backendUrl: "http://localhost:8000" });
  try {
    const r = await fetch(backendUrl + "/api/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    status.sent += data.accepted != null ? data.accepted : items.length;
    status.error = null;
    status.lastSync = new Date().toISOString();
  } catch (e) {
    queue = items.concat(queue); // requeue for next attempt
    status.error = String(e.message || e);
  }
  saveStatus();
}

function scheduleFlush() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flush();
  }, 3000);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "capture") {
    queue = queue.concat(msg.items || []);
    status.captured += (msg.items || []).length;
    saveStatus();
    scheduleFlush();
    sendResponse({ ok: true, queued: queue.length });
    return true;
  }
  if (msg.type === "getStatus") {
    sendResponse({ status });
    return true;
  }
  if (msg.type === "setBackend") {
    chrome.storage.local.set({ backendUrl: msg.url });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "flushNow") {
    flush();
    sendResponse({ ok: true });
    return true;
  }
});
