const BASE = "";

async function req(path, opts = {}) {
  const r = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!r.ok) {
    let detail = "";
    try {
      detail = (await r.json()).detail || "";
    } catch {
      detail = await r.text();
    }
    throw new Error(detail || `HTTP ${r.status}`);
  }
  return r.json();
}

export const api = {
  health: () => req("/api/health"),
  dashboard: () => req("/api/dashboard"),
  chat: (message, includeReview = false) =>
    req("/api/chat", { method: "POST", body: JSON.stringify({ message, include_review: includeReview }) }),
  items: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null));
    return req("/api/items?" + q.toString());
  },
  item: (id) => req("/api/items/" + id),
  itemLog: (id) => req("/api/items/" + id + "/log"),
  updateItem: (id, patch) => req("/api/items/" + id, { method: "PUT", body: JSON.stringify(patch) }),
  review: () => req("/api/review"),
  resolveReview: (id, edit) => req("/api/review/" + id, { method: "PUT", body: JSON.stringify(edit) }),

  // management
  deleteItem: (id) => req("/api/items/" + id, { method: "DELETE" }),
  reprocessItem: (id) => req("/api/items/" + id + "/reprocess", { method: "POST" }),
  reprocessAll: (opts = {}) =>
    req("/api/admin/reprocess", { method: "POST", body: JSON.stringify(opts) }),
  resetAll: () => req("/api/admin/reset", { method: "DELETE" }),

  // processing queue control
  pausePipeline: () => req("/api/admin/pause", { method: "POST" }),
  resumePipeline: () => req("/api/admin/resume", { method: "POST" }),
  pipelineStatus: () => req("/api/admin/pipeline"),
};

export function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function toast(msg) {
  let t = document.querySelector(".toast");
  if (!t) {
    t = document.createElement("div");
    t.className = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 2600);
}
