import { api, esc, toast } from "../api.js";

const STATUSES = ["captured", "processing", "processed", "needs_review", "indexed", "failed"];

function row(i) {
  return `<tr data-id="${i.id}">
    <td>${esc(i.project_name || "(unnamed)")}</td>
    <td>${esc(i.category || "—")}</td>
    <td><span class="badge ${i.status}">${i.status}</span></td>
    <td>${i.human_review ? '<span class="badge needs_review">yes</span>' : "—"}</td>
    <td class="small muted">${esc((i.updated_at || "").replace("T", " ").slice(0, 16))}</td>
    <td class="row" style="gap:6px;justify-content:flex-end">
      <button class="ghost" data-act="rp" data-id="${i.id}">reprocess</button>
      <button class="ghost" data-act="del" data-id="${i.id}">delete</button>
    </td>
  </tr>`;
}

function reviewBlock(r) {
  if (!r) return "";
  const url = r.project_url
    ? `<a href="${esc(r.project_url)}" target="_blank" rel="noopener">${esc(r.project_url)}</a>`
    : "—";
  const rows = [
    ["Project", esc(r.project_name || "—")],
    ["URL", url],
    ["Category", esc(r.category || "—")],
    [
      "Classification",
      esc((r.classification || "—") + (r.classification_reason ? " — " + r.classification_reason : "")),
    ],
    ["Tech stack", r.tech_stack && r.tech_stack.length ? esc(r.tech_stack.join(", ")) : "—"],
    ["Tags", r.tags && r.tags.length ? esc(r.tags.join(", ")) : "—"],
    ["Confidence", esc(String(r.confidence_score ?? "—"))],
    ["Human review", r.human_review ? esc(r.human_review_reason || "yes") : "no"],
    ["Transcript", r.transcript ? "extracted" : r.video_error ? "error: " + esc(r.video_error) : "none"],
    ["Models", `llm: ${esc(r.llm_model || "?")} · embed: ${esc(r.embed_model || "?")}`],
  ];
  const body = rows
    .map(
      ([k, v]) =>
        `<div style="color:var(--muted,#888)">${k}</div><div style="word-break:break-word">${v}</div>`
    )
    .join("");
  return `<div class="card review-summary" style="margin:8px 0;padding:10px">
    <b>AI review</b>
    <div style="display:grid;grid-template-columns:120px 1fr;gap:3px 10px;margin-top:6px">${body}</div>
  </div>`;
}

function logEntry(e) {
  const meta = [
    `<span class="badge ${esc(e.stage || "")}">${esc(e.stage || "?")}</span>`,
  ];
  if (e.pass != null) meta.push(`<span class="small muted">pass ${e.pass}</span>`);
  if (e.model) meta.push(`<span class="small muted">llm: ${esc(e.model)}</span>`);
  if (e.embed_model) meta.push(`<span class="small muted">embed: ${esc(e.embed_model)}</span>`);
  if (e.duration_s != null) meta.push(`<span class="small muted">${e.duration_s}s</span>`);
  if (e.result) meta.push(`<span class="small">${esc(e.result)}</span>`);
  const ts = e.ts ? `<div class="small muted">${esc(e.ts)}</div>` : "";
  const err = e.error ? `<div class="banner">error: ${esc(e.error)}</div>` : "";
  const extra = [];
  if (e.prompt) extra.push(`<details><summary>Prompt</summary><pre>${esc(e.prompt)}</pre></details>`);
  if (e.raw_response) extra.push(`<details><summary>Raw response</summary><pre>${esc(e.raw_response)}</pre></details>`);
  if (e.parsed) extra.push(`<details><summary>Parsed</summary><pre>${esc(JSON.stringify(e.parsed, null, 2))}</pre></details>`);
  if (e.transcript) extra.push(`<details><summary>Transcript</summary><pre>${esc(e.transcript)}</pre></details>`);
  return `<div class="log-entry" style="border-top:1px solid var(--border,#333);padding:6px 0">
    <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">${meta.join(" ")}</div>
    ${ts}${err}
    ${extra.join("")}
  </div>`;
}

async function showDetail(el, id, list) {
  const existing = el.querySelector("#detail-" + id);
  if (existing) {
    existing.remove();
    return;
  }
  el.querySelectorAll(".detail").forEach((p) => p.remove());
  const panel = document.createElement("div");
  panel.className = "card detail";
  panel.id = "detail-" + id;
  panel.innerHTML = '<div class="spinner">Loading…</div>';
  list.prepend(panel);
  try {
    const [i, lg] = await Promise.all([api.item(id), api.itemLog(id).catch(() => null)]);
    const entries = (lg && lg.entries) || [];
    const logHtml = entries.length
      ? `<details><summary>Processing log (${entries.length} stage${entries.length > 1 ? "s" : ""})</summary>${entries
          .map(logEntry)
          .join("")}</details>`
      : `<div class="small muted">no processing log recorded</div>`;
    panel.innerHTML = `
      <div class="row"><b>${esc(i.project_name || "(unnamed)")}</b> <span class="badge ${
      i.status
    }">${i.status}</span></div>
      ${i.post_url ? `<a class="small" href="${esc(i.post_url)}" target="_blank" rel="noopener">original post</a>` : ""}
      ${i.project_url ? `<a class="small" href="${esc(i.project_url)}" target="_blank" rel="noopener">project link</a>` : ""}
      ${i.llm_model || i.embed_model ? `<div class="small muted">models — llm: ${esc(i.llm_model || "?")} · embed: ${esc(i.embed_model || "?")}</div>` : ""}
      ${reviewBlock(lg && lg.latest)}
      <label>Description</label><div>${esc(i.description || "—")}</div>
      ${
        i.tags && i.tags.length
          ? `<div class="chips">${i.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>`
          : ""
      }
      ${
        i.tech_stack && i.tech_stack.length
          ? `<div class="chips">${i.tech_stack.map((t) => `<span class="chip tech">${esc(t)}</span>`).join("")}</div>`
          : ""
      }
      ${
        i.classification
          ? `<div class="small muted">classification: ${esc(i.classification)}${
              i.classification_reason ? " — " + esc(i.classification_reason) : ""
            }</div>`
          : ""
      }
      ${i.human_review_reason ? `<div class="banner">${esc(i.human_review_reason)}</div>` : ""}
      <div class="small muted">video: ${
        i.video_urls && i.video_urls.length
          ? `${i.video_urls.length} link(s)${i.transcript ? " · transcript extracted" : i.video_error ? " · " + esc(i.video_error) : " · no transcript"}`
          : "none"
      }</div>
      <label>Processing log</label>
      ${logHtml}
      <details><summary>Raw text</summary><pre>${esc(i.raw_text || "")}</pre></details>
      ${i.transcript ? `<details><summary>Transcript</summary><pre>${esc(i.transcript)}</pre></details>` : ""}
      ${i.error ? `<div class="banner">error: ${esc(i.error)}</div>` : ""}
    `;
  } catch (e) {
    panel.innerHTML = `<div class="banner">${esc(e.message)}</div>`;
  }
}

export async function renderItems(el) {
  el.innerHTML = `
    <h1>Items</h1>
    <div class="toolbar">
      <select id="status"><option value="">All statuses</option>${STATUSES.map(
        (s) => `<option value="${s}">${s}</option>`
      ).join("")}</select>
      <input id="q" placeholder="search name / tag / text" />
      <button id="go">Search</button>
      <span id="count" class="muted small"></span>
    </div>
    <div id="list"></div>
  `;
  const list = el.querySelector("#list");
  const load = async () => {
    list.innerHTML = '<div class="spinner">Loading…</div>';
    const d = await api.items({
      status: el.querySelector("#status").value,
      q: el.querySelector("#q").value,
    });
    el.querySelector("#count").textContent = `${d.total} items`;
    if (!d.items.length) {
      list.innerHTML = '<div class="empty">No items.</div>';
      return;
    }
    list.innerHTML = `<table><thead><tr><th>Project</th><th>Category</th><th>Status</th><th>Review</th><th>Updated</th><th></th></tr></thead><tbody>${d.items
      .map(row)
      .join("")}</tbody></table>`;
    list.querySelectorAll("tr[data-id]").forEach((tr) => (tr.onclick = () => showDetail(el, tr.dataset.id, list)));
    list.querySelectorAll("button[data-act]").forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        handleAct(b);
      };
    });
  };

async function handleAct(b) {
  const id = b.dataset.id;
  const act = b.dataset.act;
  if (act === "del") {
    if (!confirm("Delete this item?")) return;
    try {
      await api.deleteItem(id);
      toast("Deleted");
      b.closest("tr")?.remove();
    } catch (e) {
      toast("Error: " + e.message);
    }
  } else if (act === "rp") {
    try {
      await api.reprocessItem(id);
      toast("Queued for reprocessing");
    } catch (e) {
      toast("Error: " + e.message);
    }
  }
}
  el.querySelector("#go").onclick = load;
  el.querySelector("#q").addEventListener("keydown", (e) => {
    if (e.key === "Enter") load();
  });
  el.querySelector("#status").onchange = load;
  await load();
}
