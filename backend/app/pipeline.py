import logging
from typing import Optional

import asyncio
import time

from .extraction import classify, extract
from .config import settings
from .models import Category, Classification, Item, ItemStatus, RawCapture
from .ollama import OllamaError
from .proclog import ProcLog
from .storage import store
from .vectorstore import vs
from .video import process_video

logger = logging.getLogger("knowledgevault.pipeline")


def _safe_category(value: Optional[str]) -> Optional[Category]:
    if not value:
        return None
    try:
        return Category(value)
    except ValueError:
        return Category.OTHER


def _review_dict(item: Item) -> dict:
    """The consolidated AI review for an item — everything the model was asked
    to extract, plus classification and review verdict, in one self-contained
    block. Persisted to the per-item processing log as `latest`."""
    return {
        "project_name": item.project_name,
        "project_url": item.project_url,
        "description": item.description,
        "category": item.category.value if item.category else None,
        "tech_stack": item.tech_stack,
        "tags": item.tags,
        "confidence_score": item.confidence_score,
        "classification": item.classification.value if item.classification else None,
        "classification_reason": item.classification_reason,
        "human_review": item.human_review,
        "human_review_reason": item.human_review_reason,
        "transcript": item.transcript,
        "video_error": item.video_error,
        "video_urls": item.video_urls,
        "external_links": item.external_links,
        "llm_model": item.llm_model,
        "embed_model": item.embed_model,
        "status": item.status.value,
        "error": item.error,
    }


async def _index(item: Item, log: ProcLog) -> None:
    rec = {"stage": "reindex", "embed_model": settings.ollama_embed_model}
    t0 = time.monotonic()
    if item.is_indexable:
        await vs.upsert(item)
        item.status = ItemStatus.INDEXED
        rec["result"] = "indexed"
    else:
        await vs.remove(item.id)
        rec["result"] = "removed (non-indexable)"
    rec["status"] = item.status.value
    rec["duration_s"] = round(time.monotonic() - t0, 2)
    rec["pass"] = log.next_pass()
    await log.append(rec)
    await store.save(item)


async def process_item(item: Item, skip_video: bool = False) -> Item:
    store.mark_active(item.id)
    log = ProcLog(item.id)
    item.llm_model = settings.ollama_llm_model
    item.embed_model = settings.ollama_embed_model
    try:
        # Stage 0: video/audio (best effort). Done FIRST so the transcript can
        # inform classification + extraction — critical for reels.
        # skip_video=True is used by reprocessing to reuse an existing transcript.
        if item.video_urls and settings.whisper_enabled and not skip_video:
            rec = {"stage": "video", "model": settings.whisper_model}
            t0 = time.monotonic()
            try:
                transcript = await process_video(item)
                item.transcript = transcript
                rec["transcript"] = transcript
                rec["result"] = "transcribed" if transcript else "no transcript"
            except Exception as e:
                logger.warning("video processing skipped for %s: %s", item.id, e)
                if not item.video_error:
                    item.video_error = f"video processing error: {e}"[:200]
                rec["error"] = item.video_error or str(e)[:200]
            rec["video_error"] = item.video_error
            rec["duration_s"] = round(time.monotonic() - t0, 2)
            rec["pass"] = log.next_pass()
            await log.append(rec)
            await store.save(item)  # persist transcript and/or video_error

        # Stage 1: classify (with transcript context for video posts)
        item.status = ItemStatus.PROCESSING
        await store.save(item)
        rec = {"stage": "classify", "model": settings.ollama_llm_model}
        t0 = time.monotonic()
        cls, reason = await classify(item.raw_text, item.transcript, record=rec)
        item.classification = cls
        item.classification_reason = reason
        rec["duration_s"] = round(time.monotonic() - t0, 2)
        rec["pass"] = log.next_pass()
        await log.append(rec)
        await store.save(item)

        # Non-extractable text posts are done. Video posts fall through to extraction
        # (their value is the transcript), flagged for review if the verdict was negative.
        if cls != Classification.EXTRACTABLE:
            if not item.video_urls:
                item.status = ItemStatus.PROCESSED
                await _index(item, log)  # de-index if it was previously indexed
                await log.set_review(_review_dict(item))
                return item
            item.human_review = True
            item.human_review_reason = reason or "video post classified non-extractable; review needed"

        # Stage 2: structured extraction (post text + transcript + links)
        rec = {
            "stage": "extract",
            "model": settings.ollama_llm_model,
            "transcript": item.transcript,
        }
        t0 = time.monotonic()
        try:
            data = await extract(item.raw_text, item.transcript, item.external_links, record=rec)
        except OllamaError as e:
            logger.error("extraction failed for %s: %s", item.id, e)
            rec["error"] = str(e)[:300]
            rec["duration_s"] = round(time.monotonic() - t0, 2)
            rec["pass"] = log.next_pass()
            await log.append(rec)
            item.human_review = True
            item.human_review_reason = "automated extraction failed"
            item.status = ItemStatus.NEEDS_REVIEW
            await _index(item, log)
            await log.set_review(_review_dict(item))
            return item

        item.project_name = data.get("project_name")
        item.project_url = data.get("project_url")
        item.description = data.get("description")
        item.category = _safe_category(data.get("category"))
        item.tech_stack = [str(t) for t in (data.get("tech_stack") or []) if t]
        item.tags = [str(t) for t in (data.get("tags") or []) if t]
        try:
            item.confidence_score = float(data.get("confidence_score") or 0.0)
        except (TypeError, ValueError):
            item.confidence_score = 0.0
        item.human_review = bool(data.get("human_review"))
        item.human_review_reason = data.get("human_review_reason")

        if item.confidence_score < settings.extraction_confidence_threshold:
            item.human_review = True
            item.human_review_reason = item.human_review_reason or (
                f"low confidence ({item.confidence_score:.2f})"
            )

        item.status = ItemStatus.NEEDS_REVIEW if item.human_review else ItemStatus.PROCESSED
        await store.save(item)

        # Stage 4: index
        await _index(item, log)
        await log.set_review(_review_dict(item))
        return item
    except Exception as e:
        logger.exception("pipeline failed for %s", item.id)
        item.status = ItemStatus.FAILED
        item.error = str(e)[:500]
        await store.save(item)
        await log.set_review(_review_dict(item))
        return item
    finally:
        store.mark_done(item.id)


async def reprocess_item(item_id: str, redownload: bool = False) -> Optional[Item]:
    """Re-run classification + extraction + indexing on an already-stored item.

    Reuses the stored transcript unless `redownload` is set (which re-fetches and
    re-transcribes the video). Useful after changing models/prompts."""
    item = store.get(item_id)
    if not item:
        return None
    item.status = ItemStatus.PROCESSING
    await store.save(item)
    return await process_item(item, skip_video=not redownload)


async def reprocess_all(items: list[Item], redownload: bool = False) -> None:
    """Reprocess many items with bounded concurrency so Ollama isn't overwhelmed."""
    sem = asyncio.Semaphore(3)

    async def worker(it: Item) -> None:
        async with sem:
            try:
                await reprocess_item(it.id, redownload=redownload)
            except Exception as e:  # noqa: BLE001
                logger.warning("reprocess failed for %s: %s", it.id, e)

    await asyncio.gather(*[worker(it) for it in items])


async def process_capture(raw: RawCapture) -> Item:
    item = Item(
        source_id=raw.source_id,
        post_url=raw.post_url,
        raw_text=raw.post_text,
        video_urls=raw.video_urls,
        external_links=raw.external_links,
        status=ItemStatus.CAPTURED,
    )
    await store.save(item)
    return await process_item(item)
