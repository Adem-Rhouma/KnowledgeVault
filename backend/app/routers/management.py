from typing import Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel

from ..pipeline import reprocess_all
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
    request.app.state.tasks.append(
        __import__("asyncio").create_task(reprocess_all(items, redownload=req.redownload))
    )
    return {"accepted": len(items), "redownload": req.redownload}
