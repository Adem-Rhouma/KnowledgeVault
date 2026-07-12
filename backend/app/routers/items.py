from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request

from ..models import Item, ItemStatus
from ..pipeline import reprocess_item
from ..proclog import ProcLog
from ..storage import store
from ..vectorstore import vs

router = APIRouter(prefix="/api", tags=["items"])

_ITEM_FIELDS = set(Item.model_fields.keys())


@router.get("/items")
async def list_items(
    status: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    limit: int = Query(50, le=500),
    offset: int = Query(0, ge=0),
):
    items = store.all()
    if status:
        items = [i for i in items if i.status.value == status]
    if q:
        ql = q.lower()
        items = [
            i
            for i in items
            if ql in (i.project_name or "").lower()
            or ql in (i.description or "").lower()
            or ql in (i.raw_text or "").lower()
            or any(ql in t.lower() for t in i.tags)
        ]
    items = sorted(items, key=lambda i: i.updated_at, reverse=True)
    page = items[offset : offset + limit]
    return {
        "total": len(items),
        "items": [i.model_dump(mode="json") for i in page],
    }


@router.get("/items/{item_id}")
async def get_item(item_id: str):
    item = store.get(item_id)
    if not item:
        raise HTTPException(404, "item not found")
    return item.model_dump(mode="json")


@router.get("/items/{item_id}/log")
async def get_item_log(item_id: str):
    """Return the structured per-item processing log (all passes) plus the
    consolidated latest AI review."""
    item = store.get(item_id)
    if not item:
        raise HTTPException(404, "item not found")
    log = ProcLog(item_id)
    return {"item_id": item_id, "entries": log.entries(), "latest": log.latest()}


@router.put("/items/{item_id}")
async def update_item(item_id: str, patch: dict):
    known = {k: v for k, v in (patch or {}).items() if k in _ITEM_FIELDS}
    if not known:
        raise HTTPException(400, "no valid fields to update")
    item = await store.update(item_id, **known)
    if not item:
        raise HTTPException(404, "item not found")
    return item.model_dump(mode="json")


@router.delete("/items/{item_id}")
async def delete_item(item_id: str):
    item = store.get(item_id)
    if not item:
        raise HTTPException(404, "item not found")
    await store.delete(item_id)
    await vs.remove(item_id)
    ProcLog(item_id).remove()
    return {"deleted": item_id}


@router.post("/items/{item_id}/reprocess")
async def reprocess_one(item_id: str, request: Request):
    if not store.get(item_id):
        raise HTTPException(404, "item not found")
    request.app.state.tasks.append(__import__("asyncio").create_task(reprocess_item(item_id)))
    return {"id": item_id, "status": "queued"}
