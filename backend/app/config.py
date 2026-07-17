from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Ollama (local only, no external APIs)
    ollama_base_url: str = "http://192.168.1.16:11435"
    ollama_llm_model: str = "qwen2.5:14b"
    ollama_embed_model: str = "nomic-embed-text"

    # Qdrant (local docker)
    qdrant_url: str = "http://localhost:6333"
    qdrant_collection: str = "knowledgevault"

    # Whisper (local)
    whisper_enabled: bool = True
    whisper_model: str = "base"  # base | small | medium
    # Optional absolute path to ffmpeg/ffprobe if not on PATH (needed for audio extraction).
    ffmpeg_location: str = ""

    # Facebook video download (optional cookies for private/saved reels)
    fb_cookies_path: str = ""  # path to cookies.txt exported from browser

    # Storage
    data_dir: str = "data"
    media_dir: str = "data/media"

    # Server
    backend_host: str = "0.0.0.0"
    backend_port: int = 8000
    cors_origins: str = "*"  # comma-separated; * for local dev

    # Pipeline tuning
    extraction_confidence_threshold: float = 0.45  # below -> flag for review
    rerank_top_k: int = 24  # candidates pulled from hybrid search before rerank
    chat_top_n: int = 8  # final results returned to user
    hybrid_limit: int = 40  # per-index (dense/sparse) prefetch size

    # Processing queue: how many items may be processed by Ollama at once.
    # 1 keeps Ollama free for other work and means only the item in flight
    # shows "processing".
    pipeline_concurrency: int = 1


settings = Settings()
