# KnowledgeVault — TODO / Future Work

Tracked roadmap for post-MVP improvements. All work stays **local-only** (Ollama + Qdrant + Whisper); no paid APIs or cloud.

Legend: 🟢 quick win · 🟡 medium · 🔴 larger effort

---

## Task list (in suggested order)
- [ ] T3 · Add per-item processing logs
- [ ] T5 · Enhance UX for the items list
- [ ] T4 · Upgrade/optimize the posts/reels list (CRUD + selection)
- [ ] T1 · Enhance UX for the Facebook extension
- [ ] T9 · Auto-sync (no need to reopen facebook.com/saved)
- [ ] T2 · Enhance post/reel review
- [ ] T8 · Visual processing for video items in review
- [ ] T6 · Recall instrumentation + "why did this match"
- [ ] T7 · Upgrade/optimize the search algorithm

---

## T1 · Enhance UX for the Facebook extension 🟡
- Make the captured/queued/found badge less intrusive (collapsible, draggable, or a small toolbar icon).
- Add a "Capture all saved" button that auto-scrolls/paginates the entire `facebook.com/saved` page instead of relying on manual scroll.
- Show a per-item toast/snackbar when an item is sent + when the backend accepts/rejects it.
- Surface backend `video_error` messages in the badge so capture failures are visible without opening the dashboard.
- Touches: `extension/content.js`, `extension/popup.*`, `extension/background.js`.

## T2 · Enhance post/reel review 🟡
- Richer review card: show the original post URL, video player/preview, transcript, and classification reason inline.
- Batch actions: "Accept all", "Skip all", "Accept selected".
- Pre-fill tags/tech_stack from the model with easy chip removal; allow quick category reassignment.
- Keyboard shortcuts (e.g. `a` = accept, `s` = skip, `e` = edit).
- Touches: `backend/app/routers/review.py`, `frontend/js/views/review.js`.

## T3 · Add per-item processing logs 🟢
- Record a structured log per post/reel: capture time, classification + reason, extraction fields, video download/transcribe result (incl. `video_error`), LLM model + embed model used, reindex status, duration.
- Store as `<id>.log.json` next to each item (or a `logs/` dir) so debugging a single item is self-contained.
- Surface a "Processing log" section in the item detail panel.
- Touches: `backend/app/storage.py`, `backend/app/pipeline.py`, `frontend/js/views/items.js`.

## T4 · Upgrade/optimize the posts/reels list (CRUD + selection) 🟡
- Multi-select with checkboxes + bulk actions: delete, reprocess, add to collection, export.
- Bulk **reprocess selected** (already have per-item; extend to a selection set).
- Sortable/filterable columns (by date, status, category, confidence); persistent filters.
- Virtualized/keyset pagination for large vaults (hundreds → thousands of items).
- Touches: `backend/app/routers/items.py` (bulk endpoints), `frontend/js/views/items.js`.

## T5 · Enhance UX for the items list 🟢
- Snappy detail drawer instead of full reload; inline edit of fields.
- Status/confidence badges with color coding; "copy original link" button.
- Quick filters: "has video", "needs review", "no transcript", "low confidence".
- Empty/loading/error states polish.
- Touches: `frontend/js/views/items.js`, `frontend/css/styles.css`.

## T6 · Recall instrumentation + "why did this match" 🟡
- Thumbs up/down on each chat result; store feedback for analysis.
- Show the matched query-expansion terms and overlapping keywords/tags that drove each hit (explainability).
- Optional: use feedback to surface systematic recall gaps (e.g. "searches for X never match").
- Touches: `backend/app/routers/chat.py`, `backend/app/vectorstore.py` (return match signals), `frontend/js/views/chat.js`.

## T7 · Upgrade/optimize the search algorithm 🔴
- Tune RRF weights between dense and sparse; experiment with candidate pool size (`rerank_top_k`, `hybrid_limit`).
- Stronger query expansion (few-shot / multi-variant) and a better LLM rerank prompt; consider cross-encoder-style scoring.
- Embedding model swap (e.g. `mxbai-embed-large` / `bge-m3`) with A/B comparison against `nomic-embed-text`.
- Optional feedback-informed boosting (from T6).
- Touches: `backend/app/vectorstore.py`, `backend/app/extraction.py`, `backend/app/config.py`.

## T8 · Visual processing for video items in review 🔴
- For pending human-review items that have video, extract keyframes and run a **vision model** (e.g. `llava`, `qwen2.5-vl`) via Ollama to caption on-screen text/diagrams/tools as an extra review signal.
- Requires a local vision model (not currently installed) — gate behind a config flag + model availability check.
- Touches: `backend/app/video.py` (frame extraction), `backend/app/extraction.py` (vision prompt), `backend/app/config.py`.

## T9 · Auto-sync (no need to reopen facebook.com/saved) 🔴
- Extension/service that opens `facebook.com/saved` in a background tab, paginates, and captures incrementally on a schedule (e.g. hourly), deduplicating by post/reel URL (already supported).
- Respect rate limits; surface last-sync time + new-count in the popup.
- Touches: `extension/background.js` (scheduler + headless capture), `extension/popup.*`.

---

## Suggested order
1. T3 (logs) → T5 (items UX) → T4 (CRUD/selection) — foundation + observability.
2. T1 (extension UX) → T9 (auto-sync) — capture convenience.
3. T2 (review) → T8 (visual review) — quality of the human-in-the-loop step.
4. T6 (recall instrumentation) → T7 (search tuning) — close the "didn't show up" gap, measured.
