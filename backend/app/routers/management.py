from typing import Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel

from ..storage import store
from ..vectorstore import vs

router = APIRouter(prefix="/api", tags=["admin"])


class ReprocessRequest(BaseModel):
    status: Optional[str] = None  # only reprocess items in this status
    redownload: bool = False  # re-fetch + re-transcribe video instead of reusing transcript


@router.delete("/admin/reset")
async def reset_all():
    """Delete every stored item and wipe the Qdrant collection + BM25 index."""
    deleted = await store.clear_all()
    await vs.reset()
    return {"deleted": deleted}


@router.post("/admin/reprocess")
async def reprocess(req: ReprocessRequest, request: Request):
    items = store.all()
    if req.status:
        items = [i for i in items if i.status.value == req.status]
    request.app.state.pipeline.enqueue_many(
        [i.id for i in items], mode="reprocess", redownload=req.redownload
    )
    return {"accepted": len(items), "redownload": req.redownload}


@router.post("/admin/pause")
async def pause(request: Request):
    """Stop dequeuing new items; the current in-flight item finishes first."""
    request.app.state.pipeline.pause()
    return request.app.state.pipeline.status()


@router.post("/admin/resume")
async def resume(request: Request):
    """Resume processing the queue."""
    request.app.state.pipeline.resume()
    return request.app.state.pipeline.status()


@router.get("/admin/pipeline")
async def pipeline_status(request: Request):
    return request.app.state.pipeline.status()
