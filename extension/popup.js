function sendToContent(action, cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !/facebook\.com/.test(tab.url || "")) {
      setErr("Open facebook.com/saved first.");
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: "control", action }, (resp) => {
      if (chrome.runtime.lastError) {
        setErr("Content script not ready. Reload the tab.");
        return;
      }
      if (cb) cb(resp);
    });
  });
}

function refreshStatus() {
  chrome.runtime.sendMessage({ type: "getStatus" }, (resp) => {
    if (!resp || !resp.status) return;
    const s = resp.status;
    document.getElementById("cap").textContent = s.captured || 0;
    document.getElementById("sent").textContent = s.sent || 0;
    setErr(s.error ? "backend: " + s.error : "");
  });
}

function setErr(msg) {
  document.getElementById("err").textContent = msg || "";
}

document.getElementById("backend").addEventListener("change", (e) => {
  const url = e.target.value.trim();
  chrome.runtime.sendMessage({ type: "setBackend", url });
});

document.getElementById("open").onclick = () => {
  chrome.tabs.create({ url: "https://www.facebook.com/saved/" });
};

document.getElementById("scan").onclick = () => sendToContent("scan");

const autoBtn = document.getElementById("auto");
autoBtn.onclick = () => {
  const turningOn = !autoBtn.classList.contains("on");
  sendToContent(turningOn ? "start" : "stop", (resp) => {
    autoBtn.classList.toggle("on", !!(resp && resp.auto));
    autoBtn.textContent = "Auto-capture: " + (autoBtn.classList.contains("on") ? "on" : "off");
  });
};

// init
chrome.storage.local.get({ backendUrl: "http://localhost:8000" }, (r) => {
  document.getElementById("backend").value = r.backendUrl || "http://localhost:8000";
});
refreshStatus();
setInterval(refreshStatus, 2000);
