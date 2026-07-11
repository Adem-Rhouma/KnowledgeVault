import asyncio
import json
import re
from typing import Optional

import httpx

from .config import settings


class OllamaError(Exception):
    pass


_JSON_RE = re.compile(r"\{.*\}", re.DOTALL)


def parse_json(text: str) -> dict:
    """Extract the first JSON object from an LLM response, tolerating prose/fences."""
    if text is None:
        raise OllamaError("empty model response")
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.IGNORECASE)
    match = _JSON_RE.search(text)
    if not match:
        raise OllamaError(f"no JSON object found in response: {text[:200]}")
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError as e:
        raise OllamaError(f"invalid JSON from model: {e}") from e


class OllamaClient:
    """Async client for a single local Ollama instance. Retries LLM calls once."""

    def __init__(self) -> None:
        self.base = settings.ollama_base_url.rstrip("/")
        self.embed_model = settings.ollama_embed_model
        self.llm_model = settings.ollama_llm_model
        self._dim: Optional[int] = None
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=10.0))

    async def _post(self, path: str, payload: dict, retries: int = 1) -> dict:
        last: Optional[Exception] = None
        for attempt in range(retries + 1):
            try:
                r = await self._client.post(f"{self.base}{path}", json=payload)
                r.raise_for_status()
                return r.json()
            except Exception as e:  # network/HTTP/timeout
                last = e
                if attempt < retries:
                    await asyncio.sleep(1.5 * (attempt + 1))
        raise OllamaError(f"ollama {path} failed after {retries + 1} tries: {last}") from last

    async def embed(self, texts):
        if isinstance(texts, str):
            texts = [texts]
        data = await self._post("/api/embed", {"model": self.embed_model, "input": texts})
        embeddings = data.get("embeddings")
        if not embeddings:
            raise OllamaError("ollama /api/embed returned no embeddings")
        return embeddings

    async def embed_dim(self) -> int:
        if self._dim is None:
            self._dim = len((await self.embed(["dimension probe"]))[0])
        return self._dim

    async def generate(
        self,
        prompt: str,
        system: Optional[str] = None,
        format: Optional[dict] = None,
        temperature: float = 0.0,
    ) -> str:
        payload = {
            "model": self.llm_model,
            "prompt": prompt,
            "stream": False,
            "temperature": temperature,
        }
        if system:
            payload["system"] = system
        if format:
            payload["format"] = format
        # retry once on failure, then surface
        data = await self._post("/api/generate", payload, retries=1)
        return data.get("response", "")

    async def close(self) -> None:
        await self._client.aclose()


# module-level singleton
client = OllamaClient()
