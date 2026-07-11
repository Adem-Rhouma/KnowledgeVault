import asyncio
import json
import os
from datetime import datetime, timezone
from typing import Optional

from .config import settings
from .models import Item, ItemStatus


class Store:
    """Incremental JSON storage: one file per item, written after every pipeline stage.

    Crash-safe by design — each item is an independent file, so a mid-processing
    crash loses at most the in-flight item, never the batch.
    """

    def __init__(self) -> None:
        self.items_dir = os.path.join(settings.data_dir, "items")
        os.makedirs(self.items_dir, exist_ok=True)
        os.makedirs(settings.media_dir, exist_ok=True)
        self._lock = asyncio.Lock()
        self._items: dict[str, Item] = {}
        self._active: set[str] = set()
        self.rebuild()

    def rebuild(self) -> None:
        self._items.clear()
        for name in os.listdir(self.items_dir):
            if not name.endswith(".json"):
                continue
            path = os.path.join(self.items_dir, name)
            try:
                with open(path, "r", encoding="utf-8") as f:
                    self._items[name[: -len(".json")]] = Item(**json.load(f))
            except Exception:
                continue

    async def save(self, item: Item) -> None:
        item.updated_at = datetime.now(timezone.utc).isoformat()
        async with self._lock:
            self._items[item.id] = item
            path = os.path.join(self.items_dir, f"{item.id}.json")
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(item.model_dump(mode="json"), f, ensure_ascii=False, indent=2)
            os.replace(tmp, path)  # atomic

    async def update(self, item_id: str, **fields) -> Optional[Item]:
        item = self._items.get(item_id)
        if item is None:
            return None
        for k, v in fields.items():
            setattr(item, k, v)
        await self.save(item)
        return item

    def get(self, item_id: str) -> Optional[Item]:
        return self._items.get(item_id)

    def by_source_id(self, source_id: str) -> Optional[Item]:
        for i in self._items.values():
            if i.source_id == source_id:
                return i
        return None

    def by_post_url(self, post_url: str) -> Optional[Item]:
        if not post_url:
            return None
        for i in self._items.values():
            if i.post_url and i.post_url == post_url:
                return i
        return None

    async def delete(self, item_id: str) -> bool:
        self._items.pop(item_id, None)
        self._active.discard(item_id)
        path = os.path.join(self.items_dir, f"{item_id}.json")
        if os.path.exists(path):
            os.remove(path)
            return True
        return False

    async def clear_all(self) -> int:
        count = len(self._items)
        for name in os.listdir(self.items_dir):
            if name.endswith(".json"):
                try:
                    os.remove(os.path.join(self.items_dir, name))
                except OSError:
                    pass
        self._items.clear()
        self._active.clear()
        return count

    def all(self) -> list[Item]:
        return list(self._items.values())

    def recent(self, n: int = 10) -> list[Item]:
        return sorted(self.all(), key=lambda i: i.updated_at, reverse=True)[:n]

    def by_status(self, status: ItemStatus) -> list[Item]:
        return [i for i in self.all() if i.status == status]

    def counts(self) -> dict[str, int]:
        c = {s.value: 0 for s in ItemStatus}
        c["total"] = len(self._items)
        for i in self.all():
            c[i.status.value] = c.get(i.status.value, 0) + 1
        c["needs_review"] = sum(1 for i in self.all() if i.human_review)
        c["indexed"] = sum(1 for i in self.all() if i.status == ItemStatus.INDEXED)
        return c

    def mark_active(self, item_id: str) -> None:
        self._active.add(item_id)

    def mark_done(self, item_id: str) -> None:
        self._active.discard(item_id)

    def active_count(self) -> int:
        return len(self._active)


store = Store()
