import asyncio
import json
import os
import time
from datetime import datetime, timezone

from .config import settings


class ProcLog:
    """Audit trail of every AI review pass for one item.

    Stored as data/logs/<id>.json. The file is a JSON object with two parts:
      - "stages": an append-only array of detailed per-pass records (video,
        classify, extract, reindex). Each records the stage, the model, the
        exact prompt, the raw model response, the parsed result, the transcript
        (for video), timings, and any error — so reprocesses are all preserved.
      - "latest": the consolidated "AI review" — the final extracted fields
        (project name, url, description, tags, classification, human-review
        verdict, transcript, models) in one self-contained place, so the whole
        outcome for an item can be read without scanning the stage array.

    Atomic writes (tmp + os.replace) keep a crash from corrupting the log.
    """

    def __init__(self, item_id: str) -> None:
        self.item_id = item_id
        self.dir = os.path.join(settings.data_dir, "logs")
        os.makedirs(self.dir, exist_ok=True)
        self.path = os.path.join(self.dir, f"{item_id}.json")
        self._lock = asyncio.Lock()
        self._data = self._load()

    def _load(self) -> dict:
        if os.path.exists(self.path):
            try:
                with open(self.path, "r", encoding="utf-8") as f:
                    d = json.load(f)
            except Exception:
                return {"item_id": self.item_id, "stages": [], "latest": None}
            # Tolerate the earlier array-only format.
            if isinstance(d, list):
                return {"item_id": self.item_id, "stages": d, "latest": None}
            d.setdefault("item_id", self.item_id)
            d.setdefault("stages", [])
            d.setdefault("latest", None)
            return d
        return {"item_id": self.item_id, "stages": [], "latest": None}

    def _save(self) -> None:
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self._data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self.path)

    def entries(self) -> list:
        """Detailed per-pass stage records (backward-compatible)."""
        return self._data.get("stages", [])

    def latest(self) -> dict | None:
        """The consolidated AI review for this item, if one has been recorded."""
        return self._data.get("latest")

    def next_pass(self) -> int:
        return len(self._data.get("stages", [])) + 1

    async def append(self, entry: dict) -> None:
        entry.setdefault("ts", datetime.now(timezone.utc).isoformat())
        async with self._lock:
            self._data.setdefault("stages", []).append(entry)
            self._save()

    async def set_review(self, review: dict) -> None:
        """Record / replace the consolidated AI review for this item."""
        review["ts"] = datetime.now(timezone.utc).isoformat()
        async with self._lock:
            self._data["latest"] = review
            self._save()

    def remove(self) -> None:
        if os.path.exists(self.path):
            try:
                os.remove(self.path)
            except OSError:
                pass
