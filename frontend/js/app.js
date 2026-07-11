import { api } from "./api.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderChat } from "./views/chat.js";
import { renderReview } from "./views/review.js";
import { renderItems } from "./views/items.js";

const routes = {
  dashboard: renderDashboard,
  chat: renderChat,
  review: renderReview,
  items: renderItems,
};

function setActive(view) {
  document
    .querySelectorAll("#nav a")
    .forEach((a) => a.classList.toggle("active", a.dataset.view === view));
}

async function navigate() {
  const view = location.hash.replace(/^#\/?/, "") || "dashboard";
  setActive(view);
  const el = document.getElementById("view");
  el.innerHTML = '<div class="spinner">Loading…</div>';
  const fn = routes[view] || renderDashboard;
  try {
    await fn(el);
  } catch (e) {
    el.innerHTML = `<div class="banner">Error: ${api.esc(e.message)}</div>`;
  }
}

async function loadModels() {
  try {
    const d = await api.dashboard();
    const m = d.models || {};
    document.getElementById("model-info").innerHTML =
      `<div>LLM: <b>${api.esc(m.llm)}</b></div>` +
      `<div>Embed: <b>${api.esc(m.embed)}</b></div>` +
      `<div>Whisper: <b>${api.esc(m.whisper)}</b></div>`;
  } catch {
    /* backend may still be starting */
  }
}

window.addEventListener("hashchange", navigate);
loadModels();
navigate();
