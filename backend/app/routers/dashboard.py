from fastapi import APIRouter

from ..config import settings
from ..storage import store
from ..vectorstore import vs

router = APIRouter(prefix="/api", tags=["dashboard"])


@router.get("/dashboard")
async def dashboard():
    counts = store.counts()
    indexed = await vs.count()
    counts["indexed"] = indexed
    recent = [
        {
            "id": i.id,
            "project_name": i.project_name,
            "category": i.category.value if i.category else None,
            "status": i.status.value,
            "human_review": i.human_review,
            "classification": i.classification.value if i.classification else None,
            "updated_at": i.updated_at,
            "post_url": i.post_url,
        }
        for i in store.recent(12)
    ]
    return {
        "counts": counts,
        "processing": store.active_count(),
        "recent": recent,
        "models": {
            "llm": settings.ollama_llm_model,
            "embed": settings.ollama_embed_model,
            "whisper": settings.whisper_model if settings.whisper_enabled else "disabled",
        },
    }
