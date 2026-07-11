from fastapi import APIRouter

from ..models import ChatRequest, ChatResponse
from ..vectorstore import vs

router = APIRouter(prefix="/api", tags=["chat"])


@router.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    message = req.message.strip()
    if not message:
        return ChatResponse(message="Please describe what you're looking for.")

    results = await vs.search(message, include_review=req.include_review)

    if not results:
        suggestions = await vs.suggestions(message)
        return ChatResponse(
            results=[],
            suggestions=suggestions,
            message=(
                "I couldn't find a saved item matching that. Try rephrasing with another term, "
                "or search one of these related ideas:"
            ),
        )

    unlinked = [r for r in results if not r.project_url]
    msg = f"Found {len(results)} match{'es' if len(results) != 1 else ''}."
    if unlinked and any(r.score < 0.6 for r in results):
        msg += " A couple are looser matches — check the scores."
    return ChatResponse(results=results, message=msg)
