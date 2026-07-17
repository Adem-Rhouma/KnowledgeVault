import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import settings
from .models import ItemStatus
from .ollama import client
from .routers import capture, chat, dashboard, items, management, review
from .storage import store
from .vectorstore import vs
from .worker import PipelineController

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.tasks = []
    ctrl = PipelineController(max_concurrent=settings.pipeline_concurrency)
    app.state.pipeline = ctrl
    await vs.ensure_ready()
    # Sync Qdrant + local BM25 with everything already stored (idempotent).
    n = await vs.reindex_all([i for i in store.all() if i.is_indexable])
    logging.info("Startup reindex complete: %s items indexed", n)
    # Resume after a restart/crash: items left mid-processing were interrupted, so
    # send them back to captured, then enqueue everything still pending so nothing
    # is stuck waiting for a backend that went away.
    interrupted = 0
    for it in store.all():
        if it.status == ItemStatus.PROCESSING:
            it.status = ItemStatus.CAPTURED
            await store.save(it)
            interrupted += 1
    pending_ids = [i.id for i in store.all() if i.status == ItemStatus.CAPTURED]
    ctrl.enqueue_many(pending_ids)
    ctrl.start()
    logging.info(
        "Pipeline resumed: %s interrupted, %s pending enqueued (concurrency=%s)",
        interrupted,
        len(pending_ids),
        ctrl.max_concurrent,
    )
    yield
    ctrl.stop()
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


class NoCacheStaticFiles(StaticFiles):
    """StaticFiles that tells the browser never to cache, so frontend edits
    (CSS/JS) show up on refresh during local development instead of serving
    a stale cached stylesheet."""

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-store"
        return response


if FRONTEND_DIR.exists():
    app.mount("/", NoCacheStaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
else:
    logging.warning("Frontend dir not found at %s; serving API only", FRONTEND_DIR)
