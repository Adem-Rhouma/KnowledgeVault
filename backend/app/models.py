from datetime import datetime, timezone
from enum import Enum
from typing import Optional
from uuid import uuid4

from pydantic import BaseModel, Field


class Category(str, Enum):
    GITHUB_REPO = "github_repo"
    AI_MODEL = "ai_model"
    TOOL = "tool"
    TUTORIAL = "tutorial"
    LIBRARY = "library"
    OTHER = "other"


class Classification(str, Enum):
    EXTRACTABLE = "extractable"
    ENGAGEMENT_BAIT = "engagement_bait"
    IRRELEVANT = "irrelevant"


class ItemStatus(str, Enum):
    CAPTURED = "captured"
    PROCESSING = "processing"
    PROCESSED = "processed"
    NEEDS_REVIEW = "needs_review"
    INDEXED = "indexed"
    FAILED = "failed"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class RawCapture(BaseModel):
    source_id: str
    post_text: str = ""
    video_urls: list[str] = Field(default_factory=list)
    external_links: list[str] = Field(default_factory=list)
    post_url: str = ""
    captured_at: str = Field(default_factory=_now)
    extra: dict = Field(default_factory=dict)


class Item(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    source_id: str = ""
    post_url: str = ""

    raw_text: str = ""
    transcript: Optional[str] = None
    video_error: Optional[str] = None
    external_links: list[str] = Field(default_factory=list)
    video_urls: list[str] = Field(default_factory=list)

    classification: Optional[Classification] = None
    classification_reason: Optional[str] = None

    project_name: Optional[str] = None
    project_url: Optional[str] = None
    description: Optional[str] = None
    category: Optional[Category] = None
    tech_stack: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    confidence_score: float = 0.0

    human_review: bool = False
    human_review_reason: Optional[str] = None

    status: ItemStatus = ItemStatus.CAPTURED
    error: Optional[str] = None

    embed_model: Optional[str] = None
    llm_model: Optional[str] = None

    created_at: str = Field(default_factory=_now)
    updated_at: str = Field(default_factory=_now)

    @property
    def search_text(self) -> str:
        parts = [
            self.project_name or "",
            self.description or "",
            "Tags: " + ", ".join(self.tags),
            "Tech: " + ", ".join(self.tech_stack),
            self.raw_text,
        ]
        return "\n".join(p for p in parts if p).strip()

    @property
    def is_indexable(self) -> bool:
        if self.classification in (Classification.IRRELEVANT, Classification.ENGAGEMENT_BAIT):
            return False
        return self.status in (ItemStatus.PROCESSED, ItemStatus.NEEDS_REVIEW, ItemStatus.INDEXED)


class ChatRequest(BaseModel):
    message: str
    include_review: bool = False


class ChatResult(BaseModel):
    id: str
    project_name: Optional[str]
    project_url: Optional[str]
    description: Optional[str]
    category: Optional[str]
    tech_stack: list[str]
    tags: list[str]
    post_url: str
    score: float


class ChatResponse(BaseModel):
    results: list[ChatResult] = Field(default_factory=list)
    suggestions: list[str] = Field(default_factory=list)
    message: str = ""
