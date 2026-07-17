from pydantic import BaseModel

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..models import Item, ItemStatus, RawCapture
from ..storage import store

router = APIRouter(prefix="/api", tags=["capture"])


class CaptureBatch(BaseModel):
    items: list[RawCapture]


@router.post("/capture")
async def capture(batch: CaptureBatch, request: Request):
    accepted = []
    for raw in batch.items:
        # Idempotent: the post/reel URL acts as the ID, so re-scanning the whole
        # Facebook page never re-adds the same item (also survives extension reloads
        # that reset the extension's client-side dedup).
        existing = store.by_source_id(raw.source_id) or (
            store.by_post_url(raw.post_url) if raw.post_url else None
        )
        if existing:
            accepted.append({"id": existing.id, "status": existing.status.value, "duplicate": True})
            continue
        # pre-save raw immediately so a crash before the task runs loses nothing
        item = Item(
            source_id=raw.source_id,
            post_url=raw.post_url,
            raw_text=raw.post_text,
            video_urls=raw.video_urls,
            external_links=raw.external_links,
            status=ItemStatus.CAPTURED,
        )
        await store.save(item)
        request.app.state.pipeline.enqueue(item.id, mode="process")
        accepted.append({"id": item.id, "status": "queued"})
    return JSONResponse({"accepted": len(accepted), "items": accepted})
