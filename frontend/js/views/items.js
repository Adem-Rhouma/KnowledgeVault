import { api, esc, toast } from "../api.js";

const STATUSES = ["captured", "processing", "processed", "needs_review", "indexed", "failed"];

function row(i) {
  const needsReview = i.human_review || i.status === "needs_review";
  return `<tr data-id="${i.id}">
    <td>${esc(i.project_name || "(unnamed)")}</td>
    <td>${esc(i.category || "—")}</td>
    <td><span class="badge ${i.status}">${i.status}</span></td>
    <td>${i.human_review ? '<span class="badge needs_review">yes</span>' : "—"}</td>
    <td class="small muted">${esc((i.updated_at || "").replace("T", " ").slice(0, 16))}</td>
    <td class="row" style="gap:6px;justify-content:flex-end">
      ${needsReview ? `<button class="ghost" data-act="rev" data-id="${i.id}">review</button>` : ""}
      <button class="ghost" data-act="rp" data-id="${i.id}">reprocess</button>
      <button class="ghost" data-act="del" data-id="${i.id}">delete</button>
    </td>
  </tr>`;
}

function reviewBlock(r) {
  if (!r) return "";
  const url = r.project_url
    ? `<a class="link-btn" href="${esc(r.project_url)}" target="_blank" rel="noopener">${esc(r.project_url)}</a>`
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

const CATS = ["github_repo", "ai_model", "tool", "tutorial", "library", "other"];

function editFields(i) {
  return `
    <label>Project name</label><input data-f="project_name" value="${esc(i.project_name || "")}" />
    <label>Project URL</label><input data-f="project_url" value="${esc(i.project_url || "")}" />
    <label>Description</label><textarea data-f="description">${esc(i.description || "")}</textarea>
    <label>Category</label><select data-f="category"><option value="" ${
      !i.category ? "selected" : ""
    }>(none)</option>${CATS.map((c) => `<option ${i.category === c ? "selected" : ""}>${c}</option>`).join("")}</select>
    <label>Tech stack (comma separated)</label><input data-f="tech_stack" value="${esc(
      (i.tech_stack || []).join(", ")
    )}" />
    <label>Tags (comma separated)</label><input data-f="tags" value="${esc((i.tags || []).join(", "))}" />
  `;
}

function editForm(i) {
  return `<div class="card" style="margin:10px 0;padding:12px;border:1px solid var(--accent)">
    ${editFields(i)}
    <div class="row" style="margin-top:12px">
      <button data-save="${i.id}">Save</button>
      <button class="ghost" data-cancel="1">Cancel</button>
    </div>
  </div>`;
}

function reviewForm(i) {
  return `<div class="card" style="margin:10px 0;padding:12px;border:1px solid var(--warn)">
    ${editFields(i)}
    <div class="row" style="margin-top:12px">
      <button data-review-save="${i.id}">Save &amp; index</button>
      <button class="ghost" data-review-skip="${i.id}">Skip</button>
    </div>
  </div>`;
}

function renderDetail(i, lg, editing) {
  const entries = (lg && lg.entries) || [];
  const logHtml = entries.length
    ? `<details><summary>Processing log (${entries.length} stage${entries.length > 1 ? "s" : ""})</summary>${entries
        .map(logEntry)
        .join("")}</details>`
    : `<div class="small muted">no processing log recorded</div>`;
  const editArea = editing ? editForm(i) : "";
  const tags = i.tags && i.tags.length
    ? `<div class="chips">${i.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>`
    : "";
  const tech = i.tech_stack && i.tech_stack.length
    ? `<div class="chips">${i.tech_stack.map((t) => `<span class="chip tech">${esc(t)}</span>`).join("")}</div>`
    : "";
  const classification = i.classification
    ? `<div class="small muted">classification: ${esc(i.classification)}${
        i.classification_reason ? " — " + esc(i.classification_reason) : ""
      }</div>`
    : "";
  const video = `<div class="small muted">video: ${
    i.video_urls && i.video_urls.length
      ? `${i.video_urls.length} link(s)${i.transcript ? " · transcript extracted" : i.video_error ? " · " + esc(i.video_error) : " · no transcript"}`
      : "none"
  }</div>`;
  return `
    <div class="row"><b>${esc(i.project_name || "(unnamed)")}</b> <span class="badge ${
    i.status
  }">${i.status}</span></div>
    <div class="row" style="gap:8px;margin:6px 0">
      ${i.post_url ? `<a class="link-btn" href="${esc(i.post_url)}" target="_blank" rel="noopener">original post</a>` : ""}
      ${i.project_url ? `<a class="link-btn" href="${esc(i.project_url)}" target="_blank" rel="noopener">project link</a>` : ""}
      ${editing ? "" : `<button class="secondary" data-edit="1">Edit</button>`}
    </div>
    ${editArea}
    ${i.llm_model || i.embed_model ? `<div class="small muted">models — llm: ${esc(i.llm_model || "?")} · embed: ${esc(i.embed_model || "?")}</div>` : ""}
    ${reviewBlock(lg && lg.latest)}
    ${classification}
    ${i.human_review_reason ? `<div class="banner">${esc(i.human_review_reason)}</div>` : ""}
    <label>Description</label><div>${esc(i.description || "—")}</div>
    ${tags}${tech}
    ${video}
    <label>Processing log</label>
    ${logHtml}
    <details><summary>Raw text</summary><pre>${esc(i.raw_text || "")}</pre></details>
    ${i.transcript ? `<details><summary>Transcript</summary><pre>${esc(i.transcript)}</pre></details>` : ""}
    ${i.error ? `<div class="banner">error: ${esc(i.error)}</div>` : ""}
  `;
}

function paintDetail(panel, i, lg, editing, tr) {
  panel.innerHTML = renderDetail(i, lg, editing);
  const editBtn = panel.querySelector("[data-edit]");
  if (editBtn) editBtn.onclick = () => paintDetail(panel, i, lg, true, tr);
  const cancelBtn = panel.querySelector("[data-cancel]");
  if (cancelBtn) cancelBtn.onclick = () => paintDetail(panel, i, lg, false, tr);
  const saveBtn = panel.querySelector("[data-save]");
  if (saveBtn) saveBtn.onclick = () => saveEdit(panel, i, lg, tr);
}

async function saveEdit(panel, i, lg, tr) {
  const get = (f) => panel.querySelector(`[data-f="${f}"]`);
  const patch = {
    project_name: get("project_name").value.trim() || null,
    project_url: get("project_url").value.trim() || null,
    description: get("description").value,
    category: get("category").value || null,
    tech_stack: get("tech_stack").value.split(",").map((s) => s.trim()).filter(Boolean),
    tags: get("tags").value.split(",").map((s) => s.trim()).filter(Boolean),
  };
  try {
    const updated = await api.updateItem(i.id, patch);
    toast("Saved");
    if (tr && tr.isConnected) {
      tr.children[0].innerHTML = esc(updated.project_name || "(unnamed)");
      tr.children[1].innerHTML = esc(updated.category || "—");
    }
    paintDetail(panel, updated, lg, false, tr);
  } catch (e) {
    toast("Error: " + e.message);
  }
}

async function showDetail(el, tr, list) {
  const id = tr.dataset.id;
  const existing = el.querySelector("#detail-" + id);
  if (existing) {
    existing.remove();
    return;
  }
  // Insert an in-place detail row directly under the clicked row so the view
  // doesn't jump to the top, and allow several items to be expanded at once.
  const rowEl = document.createElement("tr");
  rowEl.className = "detail-row";
  rowEl.id = "detail-" + id;
  const tdEl = document.createElement("td");
  tdEl.colSpan = 6;
  const panel = document.createElement("div");
  panel.className = "card detail";
  panel.innerHTML = '<div class="spinner">Loading…</div>';
  tdEl.appendChild(panel);
  rowEl.appendChild(tdEl);
  tr.after(rowEl);
  try {
    const [i, lg] = await Promise.all([api.item(id), api.itemLog(id).catch(() => null)]);
    paintDetail(panel, i, lg, false, tr);
  } catch (e) {
    panel.innerHTML = `<div class="banner">${esc(e.message)}</div>`;
  }
}

async function showReview(el, tr) {
  const id = tr.dataset.id;
  const existing = el.querySelector("#review-" + id);
  if (existing) {
    existing.remove();
    return;
  }
  // In-place review editor under the row, so a needs-review item can be
  // triaged right here without hunting for it in the Review page.
  const rowEl = document.createElement("tr");
  rowEl.className = "detail-row";
  rowEl.id = "review-" + id;
  const tdEl = document.createElement("td");
  tdEl.colSpan = 6;
  const panel = document.createElement("div");
  panel.className = "card detail";
  panel.innerHTML = '<div class="spinner">Loading…</div>';
  tdEl.appendChild(panel);
  rowEl.appendChild(tdEl);
  tr.after(rowEl);
  try {
    const i = await api.item(id);
    panel.innerHTML = `<div class="row"><b>Review — ${esc(i.project_name || "(unnamed)")}</b></div>${reviewForm(i)}`;
    panel.querySelector("[data-review-save]").onclick = () => resolveReviewItem(panel, tr, i, false);
    panel.querySelector("[data-review-skip]").onclick = () => resolveReviewItem(panel, tr, i, true);
  } catch (e) {
    panel.innerHTML = `<div class="banner">${esc(e.message)}</div>`;
  }
}

async function resolveReviewItem(panel, tr, i, skip) {
  const patch = skip
    ? { skip: true }
    : (() => {
        const get = (f) => panel.querySelector(`[data-f="${f}"]`);
        return {
          project_name: get("project_name").value.trim() || null,
          project_url: get("project_url").value.trim() || null,
          description: get("description").value,
          category: get("category").value || null,
          tech_stack: get("tech_stack").value.split(",").map((s) => s.trim()).filter(Boolean),
          tags: get("tags").value.split(",").map((s) => s.trim()).filter(Boolean),
        };
      })();
  try {
    const updated = await api.resolveReview(i.id, patch);
    toast(skip ? "Skipped" : "Saved & indexed");
    if (tr.isConnected) {
      tr.children[0].innerHTML = esc(updated.project_name || "(unnamed)");
      tr.children[1].innerHTML = esc(updated.category || "—");
      tr.children[2].innerHTML = `<span class="badge ${updated.status}">${updated.status}</span>`;
      tr.children[3].innerHTML = updated.human_review
        ? '<span class="badge needs_review">yes</span>'
        : "—";
      tr.querySelector('button[data-act="rev"]')?.remove();
    }
    document.getElementById("review-" + i.id)?.remove();
    document.getElementById("detail-" + i.id)?.remove();
  } catch (e) {
    toast("Error: " + e.message);
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
    list.querySelectorAll("tr[data-id]").forEach((tr) => (tr.onclick = () => showDetail(el, tr, list)));
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
      document.getElementById("detail-" + id)?.remove();
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
  } else if (act === "rev") {
    const tr = b.closest("tr");
    const view = b.closest(".view");
    showReview(view, tr, view.querySelector("#list"));
  }
}
  el.querySelector("#go").onclick = load;
  el.querySelector("#q").addEventListener("keydown", (e) => {
    if (e.key === "Enter") load();
  });
  el.querySelector("#status").onchange = load;
  await load();
}
