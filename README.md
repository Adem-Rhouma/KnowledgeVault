# KnowledgeVault

Turn hundreds of saved Facebook posts/reels full of tech content (GitHub repos, AI
models, tools, tutorials) into a **searchable, structured, chat-driven vault** — built
entirely on your **local hardware**. No paid APIs, no cloud, nothing leaves your network.

- **Browser extension** captures saved FB posts/reels as you scroll.
- **Local pipeline** classifies, extracts structured metadata (two-pass), and (optionally)
  downloads + transcribes video with local Whisper.
- **Qdrant** hybrid vector store (dense Ollama embeddings **+** lexical BM25, fused with RRF,
  with LLM query-expansion and LLM re-ranking) — built so *"CrewAI"* shows up when you search
  *"framework for building multi-agent systems"*.
- **Web app** (dashboard, chatbot, review queue, item browser) served by the backend itself.

Everything that needs an LLM or embeddings talks to **your Ollama** at
`http://192.168.1.16:11435`. Whisper runs locally. Qdrant runs in Docker on your machine.

---

## Architecture at a glance

```
Facebook (saved)  ──extension──▶  FastAPI backend  ──▶  Ollama (classify/extract/embed)
                                   │  (incremental JSON store, one file per item)
                                   ├─▶  yt-dlp + faster-whisper  (video → transcript)
                                   └─▶  Qdrant  (dense + sparse BM25, RRF fusion)
        Web SPA  ◀──  /api/*  ◀──  chatbot (expand → hybrid search → rerank)
```

**Resilience by design**
- Every item is written to its **own JSON file after each pipeline stage** — a crash mid-run
  loses at most the in-flight item, never the batch.
- Video download fails → fall back to the post description. Transcription fails → description only.
  LLM call fails → retried once, then the item is flagged for review instead of dropping.
- The extension buffers captures in its service worker and **retries** if the backend is down.

---

## 1. Prerequisites

- Python **3.11+**
- [Ollama](https://ollama.com) reachable at `http://192.168.1.16:11435`
- Docker (for Qdrant)
- `ffmpeg` on `PATH` (only needed for video/audio extraction)
- Google Chrome / Chromium (for the extension)

### Pull the Ollama models

```bash
ollama pull nomic-embed-text      # embeddings (768-dim, fast & reliable)
ollama pull qwen2.5:14b           # LLM: classify + extract + query-expand + rerank
ollama pull faster-whisper        # not needed — Whisper runs via the faster-whisper pip package
```

Your GPU (GTX 1070, 8 GB VRAM + 16 GB shared) comfortably runs `qwen2.5:14b`. For **maximum
extraction quality** and you can spare the time, bump to a 32B Q4:

```bash
ollama pull qwen2.5:32b          # then set OLLAMA_LLM_MODEL=qwen2.5:32b in .env
```

> Embedding model note: `nomic-embed-text` is the safe default. If you want richer retrieval,
> `mxbai-embed-large` or `bge-m3` work with **zero code changes** — the app auto-detects the
> embedding dimension at startup. Just change `OLLAMA_EMBED_MODEL` in `.env`.

---

## 2. Backend + vector store

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp ../.env.example .env          # then edit OLLAMA_BASE_URL / models if needed
```

Start Qdrant (from the project root):

```bash
docker compose up -d            # Qdrant on http://localhost:6333
```

Run the backend (from `backend/`):

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

The frontend is served automatically at **http://localhost:8000/**.

On startup the backend connects to Ollama, creates/verifies the Qdrant collection, and
re-indexes any items already in the JSON store (idempotent).

Health check:

```bash
curl http://localhost:8000/api/health
```

---

## 3. Browser extension

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `extension/` folder.
3. Click the extension icon, set the **Backend URL** to `http://localhost:8000`, and save.
4. Click **Open Saved** (or go to facebook.com/saved yourself).
5. Click **Auto-capture: on**, then **scroll** through your saved items. A floating badge
   shows captured / queued counts. Items are POSTed to the backend as you scroll; failed
   sends are retried automatically.

The scraper relies on **stable semantic signals** (`role="article"`, anchor `href` patterns,
`l.facebook.com` redirect decoding) rather than Facebook's obfuscated class names, so markup
churn won't easily break it. Use **Scan now** any time, or toggle **Auto-capture**.

> **Private/saved reels:** downloading them often needs authentication. Export a
> `cookies.txt` from your browser (e.g. with the "Get cookies.txt" extension) and set
> `FB_COOKIES_PATH=/absolute/path/cookies.txt` in `.env`. If download still fails, the item
> gracefully falls back to its text description.

---

## 4. Using the web app

- **Dashboard** — totals (processed / needs review / indexed), live processing count, recent items.
- **Chat** — describe what you're after in plain language. Returns matching saved items with
  project name (linked), description, tags, tech stack, and a link to the original FB post.
  If nothing matches it says so honestly and suggests alternative search terms. Toggle
  *include items pending review* to also surface flagged items.
- **Review** — items flagged (engagement bait, low confidence, thin descriptions). See what was
  captured/transcribed, fill the gaps, **Save & index** (or **Skip** to discard).
- **Items** — full browser with status filter + free-text search; click a row for the full record.

---

## 5. Retrieval design (the important part)

The goal: minimal *"I know I saved something about X but it didn't show up"*.

| Technique | Why |
|---|---|
| **Dense embeddings** (`nomic-embed-text` via Ollama) | Semantic match — "multi-agent framework" ↔ CrewAI. |
| **Lexical BM25 sparse vectors** (computed locally, no model) | Exact/keyword recall — proper nouns, version numbers, repo names that embeddings miss. |
| **Reciprocal Rank Fusion (RRF)** of dense + sparse | Best of both; neither index dominates. |
| **LLM query expansion** | Rewrites the query into synonyms + broader/narrower terms before embedding (e.g. expands "agent framework" → multi-agent, autonomous agents, LLM orchestration). |
| **LLM re-ranking** | Takes the top ~24 fused candidates and scores relevance to your *original* query, then returns the top 8. Runs entirely inside Ollama — no separate reranker service. |
| **Metadata pre-filtering** | Irrelevant + engagement-bait items are excluded from the index so they never pollute results. |
| **Generous tags** | The extractor is told to be liberal with tags (synonyms, use cases, broader/narrower terms), which dramatically widens the lexical net. |

To tune: see the knobs in `.env.example` (`RERANK_TOP_K`, `CHAT_TOP_N`, `HYBRID_LIMIT`,
`EXTRACTION_CONFIDENCE_THRESHOLD`).

---

## 6. Configuration

All knobs live in `.env` (copy from `.env.example`). Key ones:

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://192.168.1.16:11435` | Your local Ollama. |
| `OLLAMA_LLM_MODEL` | `qwen2.5:14b` | Classification + extraction + rerank. |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Embeddings (dim auto-detected). |
| `QDRANT_URL` / `QDRANT_COLLECTION` | `:6333` / `knowledgevault` | Vector store. |
| `WHISPER_ENABLED` / `WHISPER_MODEL` | `true` / `base` | Local video transcription. |
| `FB_COOKIES_PATH` | `` | Optional cookies for private reels. |
| `EXTRACTION_CONFIDENCE_THRESHOLD` | `0.45` | Below this → review queue. |

---

## 7. Troubleshooting

- **`/api/health` shows `ollama: unreachable`** — check Ollama is running and reachable from the
  backend host at the configured `OLLAMA_BASE_URL`.
- **Items stuck `processing`** — the LLM/Whisper is slow or Ollama is busy. They'll finish or
  fail into `needs_review` / `failed`; nothing is lost (each stage is saved).
- **Videos not transcribed** — ensure `ffmpeg` is installed and (for private reels) `FB_COOKIES_PATH`
  is set. Failures fall back to the description automatically.
- **Swapped embedding model → collection recreated** — if you change `OLLAMA_EMBED_MODEL` to a
  different dimension, the app detects the mismatch, recreates the collection, and re-indexes.
- **Extension not capturing** — make sure you're on `facebook.com`, the backend URL is correct,
  and reload the tab if the badge doesn't appear.

---

## Project layout

```
KnowledgeVault/
├── backend/
│   ├── app/
│   │   ├── main.py          # FastAPI app, CORS, static, startup reindex
│   │   ├── config.py        # settings from .env
│   │   ├── models.py        # data models
│   │   ├── storage.py       # incremental per-item JSON store
│   │   ├── ollama.py        # async Ollama client (LLM + embed, retry, auto-dim)
│   │   ├── bm25.py          # local BM25 sparse-vector builder
│   │   ├── extraction.py    # two-pass classify → extract + query expand + rerank
│   │   ├── video.py         # yt-dlp download + faster-whisper transcription
│   │   ├── vectorstore.py   # Qdrant hybrid search (RRF)
│   │   ├── pipeline.py      # orchestrates a capture through every stage
│   │   └── routers/         # capture, chat, dashboard, items, review
│   └── requirements.txt
├── frontend/               # no-build ES-module SPA served by the backend
├── extension/              # Chrome MV3 extension
├── docker-compose.yml      # Qdrant
└── .env.example
```
