import { api, esc } from "../api.js";

function renderResults(r) {
  if (!r.results || r.results.length === 0) {
    const sugg = (r.suggestions || [])
      .map((s) => `<span class="chip" data-q="${esc(s)}">${esc(s)}</span>`)
      .join("");
    return `<div class="banner">${esc(r.message || "No matches.")}</div>${
      sugg ? `<div class="suggestions chips">${sugg}</div>` : ""
    }`;
  }
  const cards = r.results
    .map(
      (res) => `<div class="card result">
        <div class="title">${
          res.project_url
            ? `<a href="${esc(res.project_url)}" target="_blank" rel="noopener">${esc(res.project_name || "Untitled")}</a>`
            : esc(res.project_name || "Untitled")
        }</div>
        <div class="meta">${res.category ? esc(res.category) : ""}${
          res.score != null ? ` · relevance <span class="score">${res.score}</span>` : ""
        }${
          res.post_url
            ? ` · <a href="${esc(res.post_url)}" target="_blank" rel="noopener" class="muted">original post</a>`
            : ""
        }</div>
        <div>${esc(res.description || "")}</div>
        ${
          res.tags && res.tags.length
            ? `<div class="chips">${res.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>`
            : ""
        }
        ${
          res.tech_stack && res.tech_stack.length
            ? `<div class="chips">${res.tech_stack
                .map((t) => `<span class="chip tech">${esc(t)}</span>`)
                .join("")}</div>`
            : ""
        }
      </div>`
    )
    .join("");
  return `<p class="muted">${esc(r.message || "")}</p>${cards}`;
}

export async function renderChat(el) {
  el.innerHTML = `
    <h1>Search your vault</h1>
    <div class="chat-input">
      <input id="q" placeholder="e.g. framework for building multi-agent systems" />
      <button id="send">Search</button>
    </div>
    <label class="include-review"><input type="checkbox" id="inc" /> include items pending review</label>
    <div id="results"></div>
  `;
  const input = el.querySelector("#q");
  const out = el.querySelector("#results");
  const run = async () => {
    const msg = input.value.trim();
    if (!msg) return;
    out.innerHTML = '<div class="spinner">Searching…</div>';
    try {
      const r = await api.chat(msg, el.querySelector("#inc").checked);
      out.innerHTML = renderResults(r);
      out.querySelectorAll(".suggestions .chip").forEach((ch) => {
        ch.onclick = () => {
          input.value = ch.dataset.q;
          run();
        };
      });
    } catch (e) {
      out.innerHTML = `<div class="banner">${esc(e.message)}</div>`;
    }
  };
  el.querySelector("#send").onclick = run;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") run();
  });
  input.focus();
}
