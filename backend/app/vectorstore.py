import logging

from qdrant_client import AsyncQdrantClient, models
from qdrant_client.models import (
    Distance,
    FieldCondition,
    Filter,
    Fusion,
    FusionQuery,
    MatchValue,
    PointStruct,
    Prefetch,
    SparseVector,
    SparseVectorParams,
    VectorParams,
)

from .bm25 import BM25Index
from .config import settings
from .extraction import expand_query, rerank
from .models import ChatResult, Classification, Item, ItemStatus
from .ollama import client

logger = logging.getLogger("knowledgevault.vectorstore")

EXCLUDE_CLASSES = [Classification.IRRELEVANT.value, Classification.ENGAGEMENT_BAIT.value]


def _payload(item: Item) -> dict:
    return {
        "id": item.id,
        "project_name": item.project_name,
        "project_url": item.project_url,
        "description": item.description,
        "category": item.category.value if item.category else None,
        "tech_stack": item.tech_stack,
        "tags": item.tags,
        "post_url": item.post_url,
        "classification": item.classification.value if item.classification else None,
        "human_review": item.human_review,
        "confidence_score": item.confidence_score,
        "source_id": item.source_id,
    }


class VectorStore:
    def __init__(self) -> None:
        self.client = AsyncQdrantClient(url=settings.qdrant_url)
        self.bm25 = BM25Index()
        self._lock = None  # set in ensure_ready
        self._ready = False

    async def ensure_ready(self) -> None:
        if self._ready:
            return
        dim = await client.embed_dim()
        name = settings.qdrant_collection
        exists = await self.client.collection_exists(name)
        if exists:
            info = await self.client.get_collection(name)
            cur = info.config.params.vectors.get("text-dense")
            if cur and getattr(cur, "size", None) != dim:
                logger.warning("Embedding dim changed (%s->%s); recreating collection", cur.size, dim)
                await self.client.delete_collection(name)
                exists = False
        if not exists:
            await self.client.create_collection(
                name,
                vectors_config={"text-dense": VectorParams(size=dim, distance=Distance.COSINE)},
                sparse_vectors_config={"text-sparse": SparseVectorParams()},
            )
        self._ready = True

    async def upsert(self, item: Item) -> None:
        await self.ensure_ready()
        text = item.search_text
        if not text:
            return
        dense = (await client.embed([text]))[0]
        s_idx, s_val = self.bm25.sparse(text)
        point = PointStruct(
            id=item.id,
            vector={
                "text-dense": dense,
                "text-sparse": SparseVector(indices=s_idx, values=s_val),
            },
            payload=_payload(item),
        )
        await self.client.upsert(settings.qdrant_collection, points=[point])
        self.bm25.add(item.id, text)

    async def remove(self, item_id: str) -> None:
        await self.ensure_ready()
        try:
            await self.client.delete(settings.qdrant_collection, points_selector=models.PointIdsList(points=[item_id]))
        except Exception:
            pass
        self.bm25.remove(item_id)

    async def reindex_all(self, items: list[Item]) -> int:
        await self.ensure_ready()
        self.bm25.reset()
        count = 0
        for item in items:
            if not item.is_indexable:
                continue
            text = item.search_text
            if not text:
                continue
            dense = (await client.embed([text]))[0]
            s_idx, s_val = self.bm25.sparse(text)
            await self.client.upsert(
                settings.qdrant_collection,
                points=[
                    PointStruct(
                        id=item.id,
                        vector={
                            "text-dense": dense,
                            "text-sparse": SparseVector(indices=s_idx, values=s_val),
                        },
                        payload=_payload(item),
                    )
                ],
            )
            self.bm25.add(item.id, text)
            count += 1
        return count

    def _exclude_filter(self) -> Filter:
        return Filter(
            must_not=[
                FieldCondition(key="classification", match=MatchValue(value=v)) for v in EXCLUDE_CLASSES
            ]
        )

    async def search(self, message: str, include_review: bool = False) -> list[ChatResult]:
        await self.ensure_ready()
        expanded = await expand_query(message)
        queries = [message] + [q for q in expanded if q]
        embeddings = await client.embed(queries)
        dim = len(embeddings[0])
        dense_q = [sum(v[i] for v in embeddings) / len(embeddings) for i in range(dim)]
        s_idx, s_val = self.bm25.sparse(" ".join(queries))

        prefetch = [
            Prefetch(query=dense_q, using="text-dense", limit=settings.hybrid_limit),
            Prefetch(
                query=SparseVector(indices=s_idx, values=s_val),
                using="text-sparse",
                limit=settings.hybrid_limit,
            ),
        ]
        filt = self._exclude_filter()
        resp = await self.client.query_points(
            settings.qdrant_collection,
            prefetch=prefetch,
            query=FusionQuery(fusion=Fusion.RRF),
            limit=settings.rerank_top_k,
            with_payload=True,
            query_filter=filt,
        )
        candidates = []
        for p in resp.points:
            pl = p.payload or {}
            candidates.append(
                {
                    "id": pl.get("id"),
                    "project_name": pl.get("project_name"),
                    "project_url": pl.get("project_url"),
                    "category": pl.get("category"),
                    "tags": pl.get("tags") or [],
                    "tech_stack": pl.get("tech_stack") or [],
                    "description": pl.get("description"),
                    "post_url": pl.get("post_url") or "",
                    "human_review": bool(pl.get("human_review")),
                }
            )
        scores = await rerank(message, candidates)
        ranked = sorted(candidates, key=lambda c: scores.get(c["id"], 0.0), reverse=True)
        if not include_review:
            ranked = [c for c in ranked if not c["human_review"]]
        out = []
        for c in ranked[: settings.chat_top_n]:
            score = scores.get(c["id"], 0.0)
            if score < 0.2 and len(out) >= 3:
                continue
            out.append(
                ChatResult(
                    id=c["id"],
                    project_name=c.get("project_name"),
                    project_url=c.get("project_url"),
                    description=c.get("description"),
                    category=c.get("category"),
                    tech_stack=c.get("tech_stack") or [],
                    tags=c.get("tags") or [],
                    post_url=c.get("post_url") or "",
                    score=round(score, 3),
                )
            )
        return out

    async def suggestions(self, message: str) -> list[str]:
        return await expand_query(message)

    async def count(self) -> int:
        await self.ensure_ready()
        try:
            return (await self.client.count(settings.qdrant_collection)).count
        except Exception:
            return 0

    async def reset(self) -> None:
        """Drop and recreate the collection, and clear the local BM25 index."""
        name = settings.qdrant_collection
        try:
            if await self.client.collection_exists(name):
                await self.client.delete_collection(name)
        except Exception as e:  # noqa: BLE001
            logging.warning("qdrant delete_collection failed: %s", e)
        self._ready = False
        self.bm25.reset()
        await self.ensure_ready()


vs = VectorStore()
