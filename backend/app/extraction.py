from typing import Optional

from .models import Classification
from .ollama import OllamaError, client, parse_json

CLASSIFY_SCHEMA = {
    "type": "object",
    "properties": {
        "classification": {
            "type": "string",
            "enum": ["extractable", "engagement_bait", "irrelevant"],
        },
        "reason": {"type": "string"},
    },
    "required": ["classification", "reason"],
}

EXTRACT_SCHEMA = {
    "type": "object",
    "properties": {
        "project_name": {"type": ["string", "null"]},
        "project_url": {"type": ["string", "null"]},
        "description": {"type": ["string", "null"]},
        "category": {
            "type": "string",
            "enum": ["github_repo", "ai_model", "tool", "tutorial", "library", "other"],
        },
        "tech_stack": {"type": "array", "items": {"type": "string"}},
        "tags": {"type": "array", "items": {"type": "string"}},
        "confidence_score": {"type": "number"},
        "human_review": {"type": "boolean"},
        "human_review_reason": {"type": ["string", "null"]},
    },
    "required": [
        "project_name",
        "project_url",
        "description",
        "category",
        "tech_stack",
        "tags",
        "confidence_score",
        "human_review",
    ],
}

EXPAND_SCHEMA = {
    "type": "object",
    "properties": {"expanded": {"type": "array", "items": {"type": "string"}}},
    "required": ["expanded"],
}

RERANK_SCHEMA = {
    "type": "object",
    "properties": {
        "ranked": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "score": {"type": "number"},
                },
            },
        }
    },
    "required": ["ranked"],
}

CLASSIFY_SYSTEM = (
    "You triage saved social-media posts about tech. Decide if a post is worth structuring.\n"
    "- extractable: it names a concrete project/tool/repo/model/tutorial/library with usable info (links, names, described purpose).\n"
    "- engagement_bait: it withholds the link and asks the reader to 'comment', 'DM', 'follow for link', or similar. Still note if a name is visible.\n"
    "- irrelevant: no real tech content (personal post, meme, ad, off-topic, pure self-promo with no substance).\n"
    "For video/reel posts a VIDEO TRANSCRIPT may be provided — that is the spoken content; judge extractability from it too. "
    "A reel whose speech describes a real tool, model, or technique is extractable.\n"
    "Respond ONLY with the JSON schema."
)

EXTRACT_SYSTEM = (
    "Extract structured metadata from a saved social-media post about a tech resource.\n"
    "Rules:\n"
    "- project_name: the name of the tool/repo/model/tutorial. Null if none discernible.\n"
    "- project_url: ONLY a direct link to the project (github.com, docs site, hf.co, pypi, etc). "
    "NEVER use facebook.com / fb.watch / l.facebook.com URLs. Null if no direct link exists.\n"
    "- description: a clean 2-3 sentence summary in your own words from the post + transcript.\n"
    "- category: one of github_repo, ai_model, tool, tutorial, library, other.\n"
    "- tech_stack: ONLY technologies EXPLICITLY mentioned (languages, frameworks). Empty list if none.\n"
    "- tags: be GENEROUS — include synonyms, related concepts, use cases, broader and narrower terms "
    "(e.g. a post about CrewAI also gets 'multi-agent', 'agent framework', 'autonomous agents', 'LLM orchestration').\n"
    "- confidence_score: 0.0-1.0 how sure you are the extraction is correct and complete.\n"
    "- human_review: true if uncertain, low-quality, engagement_bait-ish but partially useful, or description is thin.\n"
    "- human_review_reason: short reason when human_review is true, else null.\n"
    "Use the provided external links to choose project_url. Respond ONLY with the JSON schema."
)

EXPAND_SYSTEM = (
    "You help a semantic search system. Given a user's search query about saved tech resources, "
    "produce alternative phrasings, synonyms, related concepts, and broader/narrower terms a relevant "
    "saved item might use. Aim for 4-8 short queries. Respond ONLY with the JSON schema."
)

RERANK_SYSTEM = (
    "You are a reranker. Given the user's original query and a list of candidate saved items, "
    "score each candidate's relevance to the query from 0.0 (irrelevant) to 1.0 (highly relevant). "
    "Only score items actually provided; never invent ids. Respond ONLY with the JSON schema."
)


def _truncate(text: str, n: int = 6000) -> str:
    return text if len(text) <= n else text[:n] + "\n...[truncated]"


async def classify(
    text: str, transcript: Optional[str] = None, record: Optional[dict] = None
) -> tuple[Classification, Optional[str]]:
    parts = [f"POST TEXT:\n{_truncate(text)}"]
    if transcript:
        parts.append(f"VIDEO TRANSCRIPT (spoken content of a reel/video):\n{_truncate(transcript, 4000)}")
    prompt = "\n\n".join(parts)
    if record is not None:
        record["prompt"] = prompt
    response = await client.generate(prompt, CLASSIFY_SYSTEM, CLASSIFY_SCHEMA)
    if record is not None:
        record["raw_response"] = response
    data = parse_json(response)
    if record is not None:
        record["parsed"] = data
    cls = data.get("classification", "irrelevant")
    try:
        return Classification(cls), data.get("reason")
    except ValueError:
        return Classification.IRRELEVANT, f"unparseable classification: {cls}"


async def extract(
    post_text: str,
    transcript: Optional[str],
    external_links: list[str],
    record: Optional[dict] = None,
) -> dict:
    parts = [f"POST TEXT:\n{_truncate(post_text)}"]
    if transcript:
        parts.append(f"VIDEO TRANSCRIPT:\n{_truncate(transcript, 4000)}")
    parts.append("EXTERNAL LINKS FOUND IN POST:\n" + ("\n".join(external_links) if external_links else "(none)"))
    prompt = "\n\n".join(parts)
    if record is not None:
        record["prompt"] = prompt
    response = await client.generate(prompt, EXTRACT_SYSTEM, EXTRACT_SCHEMA)
    if record is not None:
        record["raw_response"] = response
    data = parse_json(response)
    if record is not None:
        record["parsed"] = data
    return data


async def expand_query(query: str) -> list[str]:
    try:
        data = parse_json(await client.generate(f"QUERY: {query}", EXPAND_SYSTEM, EXPAND_SCHEMA))
        out = [str(q) for q in data.get("expanded", []) if q]
        return out[:8]
    except OllamaError:
        return []


async def rerank(query: str, candidates: list[dict]) -> dict[str, float]:
    if not candidates:
        return {}
    items_block = "\n".join(
        f"[{c['id']}] name={c.get('project_name')} | category={c.get('category')} | "
        f"tags={', '.join(c.get('tags', []))} | desc={c.get('description')}"
        for c in candidates
    )
    prompt = f"USER QUERY:\n{query}\n\nCANDIDATES:\n{items_block}"
    try:
        data = parse_json(await client.generate(prompt, RERANK_SYSTEM, RERANK_SCHEMA))
    except OllamaError:
        return {c["id"]: 0.5 for c in candidates}
    scores = {}
    for row in data.get("ranked", []):
        cid = row.get("id")
        if cid in {c["id"] for c in candidates}:
            try:
                scores[cid] = float(row.get("score", 0.0))
            except (TypeError, ValueError):
                scores[cid] = 0.0
    return scores
