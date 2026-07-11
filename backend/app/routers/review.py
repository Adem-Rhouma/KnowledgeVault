from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..models import Category, ItemStatus
from ..storage import store
from ..vectorstore import vs

router = APIRouter(prefix="/api", tags=["review"])


@router.get("/review")
async def review_queue():
    items = [
        i
        for i in store.all()
        if i.human_review or i.status == ItemStatus.NEEDS_REVIEW
    ]
    items = sorted(items, key=lambda i: i.updated_at, reverse=True)
    return {"total": len(items), "items": [i.model_dump(mode="json") for i in items]}


class ReviewEdit(BaseModel):
    project_name: str | None = None
    project_url: str | None = None
    description: str | None = None
    category: str | None = None
    tech_stack: list[str] | None = None
    tags: list[str] | None = None
    confidence_score: float | None = None
    skip: bool = False  # mark reviewed but do not index


@router.put("/review/{item_id}")
async def resolve_review(item_id: str, edit: ReviewEdit):
    item = store.get(item_id)
    if not item:
        raise HTTPException(404, "item not found")

    if not edit.skip:
        if edit.project_name is not None:
            item.project_name = edit.project_name or None
        if edit.project_url is not None:
            item.project_url = edit.project_url or None
        if edit.description is not None:
            item.description = edit.description or None
        if edit.category is not None:
            try:
                item.category = Category(edit.category)
            except ValueError:
                item.category = Category.OTHER
        if edit.tech_stack is not None:
            item.tech_stack = edit.tech_stack
        if edit.tags is not None:
            item.tags = edit.tags
        if edit.confidence_score is not None:
            item.confidence_score = float(edit.confidence_score)

    item.human_review = False
    item.human_review_reason = None
    item.status = ItemStatus.PROCESSED if edit.skip else ItemStatus.INDEXED
    await store.save(item)

    if not edit.skip:
        await vs.upsert(item)
    else:
        await vs.remove(item.id)
    return item.model_dump(mode="json")
