import { api, esc, toast } from "../api.js";

function stat(label, num, cls = "") {
  return `<div class="stat ${cls}"><div class="num">${num}</div><div class="label">${label}</div></div>`;
}

function recentTable(items) {
  const rows = items
    .map(
      (i) => `<tr onclick="location.hash='#/items'">
       <td>${esc(i.project_name || "—")}</td>
       <td>${esc(i.category || "—")}</td>
       <td><span class="badge ${i.status}">${i.status}</span></td>
       <td>${i.human_review ? '<span class="badge needs_review">yes</span>' : "—"}</td>
       <td class="small muted">${esc((i.updated_at || "").replace("T", " ").slice(0, 16))}</td>
     </tr>`
    )
    .join("");
  return `<table><thead><tr><th>Project</th><th>Category</th><th>Status</th><th>Review</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function reprocess(status, redownload = false) {
  try {
    const r = await api.reprocessAll({ status, redownload });
    toast(`Queued ${r.accepted} item(s) for reprocessing`);
  } catch (e) {
    toast("Error: " + e.message);
  }
}

async function resetAll() {
  if (!confirm("Delete ALL items, the Qdrant index, and the BM25 index? This cannot be undone.")) return;
  try {
    const r = await api.resetAll();
    toast(`Reset complete — deleted ${r.deleted} item(s)`);
    location.reload();
  } catch (e) {
    toast("Error: " + e.message);
  }
}

export async function renderDashboard(el) {
  const d = await api.dashboard();
  const c = d.counts;
  el.innerHTML = `
    <h1>Dashboard</h1>
    <div class="stats">
      ${stat("Total", c.total)}
      ${stat("Processed", c.processed || 0, "ok")}
      ${stat("Needs review", c.needs_review || 0, "warn")}
      ${stat("Indexed", c.indexed || 0, "ok")}
      ${stat("Processing", d.processing)}
      ${stat("Failed", c.failed || 0, "warn")}
    </div>

    <h2>Manage</h2>
    <div class="card row">
      <button id="rp-all">Reprocess all</button>
      <button class="secondary" id="rp-review">Reprocess needs-review</button>
      <button class="secondary" id="rp-redl">Reprocess all + re-download video</button>
      <button class="danger" id="reset">Reset everything</button>
    </div>

    <h2>Recent items</h2>
    ${d.recent.length ? recentTable(d.recent) : '<div class="empty">No items yet.</div>'}
  `;
  el.querySelector("#rp-all").onclick = () => reprocess(null);
  el.querySelector("#rp-review").onclick = () => reprocess("needs_review");
  el.querySelector("#rp-redl").onclick = () => reprocess(null, true);
  el.querySelector("#reset").onclick = resetAll;
}
