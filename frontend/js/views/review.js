import { api, esc, toast } from "../api.js";

const CATS = ["github_repo", "ai_model", "tool", "tutorial", "library", "other"];

function card(i) {
  const reason = i.human_review_reason
    ? `<div class="banner">Flagged: ${esc(i.human_review_reason)}</div>`
    : "";
  const raw = `<div class="detail"><pre>${esc(i.raw_text || "(no text)")}</pre></div>`;
  const tr = i.transcript
    ? `<details><summary>Transcript</summary><pre>${esc(i.transcript)}</pre></details>`
    : "";
  return `<div class="card" id="rev-${i.id}">
    ${reason}
    <div class="row"><b>${esc(i.project_name || "(unnamed)")}</b> <span class="badge ${i.status}">${i.status}</span></div>
    ${i.post_url ? `<a class="small" href="${esc(i.post_url)}" target="_blank" rel="noopener">original post</a>` : ""}
    ${raw}${tr}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div><label>Project name</label><input data-f="project_name" value="${esc(i.project_name || "")}" /></div>
      <div><label>Project URL</label><input data-f="project_url" value="${esc(i.project_url || "")}" /></div>
    </div>
    <label>Description</label><textarea data-f="description">${esc(i.description || "")}</textarea>
    <div class="row" style="gap:12px;align-items:flex-end">
      <div><label>Category</label><select data-f="category">${CATS.map(
        (c) => `<option ${i.category === c ? "selected" : ""}>${c}</option>`
      ).join("")}</select></div>
      <div style="flex:1"><label>Tech stack (comma separated)</label><input data-f="tech_stack" value="${esc(
        (i.tech_stack || []).join(", ")
      )}" /></div>
    </div>
    <label>Tags (comma separated)</label><input data-f="tags" value="${esc((i.tags || []).join(", "))}" />
    <div class="row" style="margin-top:12px">
      <button data-save="${i.id}">Save &amp; index</button>
      <button class="ghost" data-skip="${i.id}">Skip (don't index)</button>
    </div>
  </div>`;
}

function checkEmpty(el) {
  if (!el.querySelector(".card")) el.innerHTML = '<div class="empty">Nothing to review. 🎉</div>';
}

function collect(root) {
  const get = (f) => root.querySelector(`[data-f="${f}"]`);
  return {
    project_name: get("project_name").value,
    project_url: get("project_url").value,
    description: get("description").value,
    category: get("category").value,
    tech_stack: get("tech_stack").value.split(",").map((s) => s.trim()).filter(Boolean),
    tags: get("tags").value.split(",").map((s) => s.trim()).filter(Boolean),
  };
}

export async function renderReview(el) {
  el.innerHTML = '<h1>Review queue</h1><div class="spinner">Loading…</div>';
  const d = await api.review();
  if (d.total === 0) {
    el.innerHTML = '<h1>Review queue</h1><div class="empty">Nothing to review. 🎉</div>';
    return;
  }
  el.innerHTML = `<h1>Review queue <span class="badge needs_review">${d.total}</span></h1>${d.items
    .map(card)
    .join("")}`;
  el.querySelectorAll("[data-save]").forEach((b) => (b.onclick = () => save(el, b.dataset.save)));
  el.querySelectorAll("[data-skip]").forEach((b) => (b.onclick = () => skip(el, b.dataset.skip)));
}

async function save(el, id) {
  const root = el.querySelector("#rev-" + id);
  try {
    await api.resolveReview(id, collect(root));
    toast("Saved & indexed");
    root.remove();
    checkEmpty(el);
  } catch (e) {
    toast("Error: " + e.message);
  }
}

async function skip(el, id) {
  try {
    await api.resolveReview(id, { skip: true });
    toast("Skipped");
    el.querySelector("#rev-" + id).remove();
    checkEmpty(el);
  } catch (e) {
    toast("Error: " + e.message);
  }
}
