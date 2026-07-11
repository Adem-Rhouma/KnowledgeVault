import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import settings
from .ollama import client
from .routers import capture, chat, dashboard, items, management, review
from .storage import store
from .vectorstore import vs

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.tasks = []
    await vs.ensure_ready()
    # Sync Qdrant + local BM25 with everything already stored (idempotent).
    n = await vs.reindex_all([i for i in store.all() if i.is_indexable])
    logging.info("Startup reindex complete: %s items indexed", n)
    yield
    await client.close()
    await vs.client.close()


app = FastAPI(title="KnowledgeVault", version="1.0.0", lifespan=lifespan)

origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
allow_all = "*" in origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if allow_all else origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(capture.router)
app.include_router(chat.router)
app.include_router(dashboard.router)
app.include_router(items.router)
app.include_router(review.router)
app.include_router(management.router)


@app.get("/api/health")
async def health():
    try:
        await client.embed(["health"])
        ollama = "ok"
    except Exception as e:  # noqa: BLE001
        ollama = f"unreachable: {e}"
    return {"status": "ok", "ollama": ollama, "qdrant_collection": settings.qdrant_collection}


if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
else:
    logging.warning("Frontend dir not found at %s; serving API only", FRONTEND_DIR)
