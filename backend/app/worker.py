"""A single, pausable queue that drains captured items through the pipeline.

Previously every capture/reprocess spawned an ad-hoc `asyncio.create_task`, so
there was no central place to pause work or to resume items left mid-flight when
the backend was killed. All processing now flows through here, which lets us:

  * pause after the current item finishes (free Ollama for other work),
  * resume on demand,
  * bound concurrency so at most `max_concurrent` items hit Ollama at once, and
  * resume interrupted items on backend restart.
"""

import asyncio
import logging
from collections import deque

from .pipeline import process_item, reprocess_item
from .storage import store

logger = logging.getLogger("knowledgevault.worker")


class PipelineController:
    def __init__(self, max_concurrent: int = 1):
        self.max_concurrent = max(1, max_concurrent)
        self.pending: deque[str] = deque()
        self.paused = False
        self.active: set[str] = set()
        self._modes: dict[str, str] = {}  # item_id -> "process" | "reprocess"
        self._redownload: dict[str, bool] = {}  # item_id -> redownload flag
        self._worker = None

    # ---- enqueue ----
    def enqueue(self, item_id: str, mode: str = "process", redownload: bool = False) -> None:
        if item_id in self.pending or item_id in self.active:
            return
        self._modes[item_id] = mode
        if redownload:
            self._redownload[item_id] = True
        self.pending.append(item_id)

    def enqueue_many(self, ids, mode: str = "process", redownload: bool = False) -> None:
        for i in ids:
            self.enqueue(i, mode=mode, redownload=redownload)

    # ---- control ----
    def start(self) -> None:
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._run())

    def pause(self) -> None:
        # Let any in-flight item finish; just stop dequeuing new ones.
        self.paused = True

    def resume(self) -> None:
        self.paused = False

    def stop(self) -> None:
        self.paused = True
        if self._worker is not None:
            self._worker.cancel()

    def status(self) -> dict:
        return {
            "paused": self.paused,
            "pending": len(self.pending),
            "active": len(self.active),
            "max_concurrent": self.max_concurrent,
        }

    # ---- worker loop ----
    async def _run(self) -> None:
        while True:
            if (
                not self.paused
                and self.pending
                and len(self.active) < self.max_concurrent
            ):
                item_id = self.pending.popleft()
                self.active.add(item_id)  # reserve immediately (closes the re-enqueue race)
                mode = self._modes.pop(item_id, "process")
                redownload = self._redownload.pop(item_id, False)
                asyncio.create_task(self._run_one(item_id, mode, redownload))
            await asyncio.sleep(0.3)

    async def _run_one(self, item_id: str, mode: str, redownload: bool) -> None:
        try:
            if mode == "reprocess":
                await reprocess_item(item_id, redownload=redownload)
            else:
                item = store.get(item_id)
                if item is not None:
                    await process_item(item)
        except Exception as e:  # noqa: BLE001
            logger.warning("processing failed for %s: %s", item_id, e)
        finally:
            self.active.discard(item_id)
