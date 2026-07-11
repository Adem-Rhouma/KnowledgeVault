import asyncio
import logging
import os
from typing import Optional

from .config import settings
from .models import Item

logger = logging.getLogger("knowledgevault.video")

_whisper_model = None
_whisper_lock = asyncio.Lock()


def _get_whisper():
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel

        _whisper_model = WhisperModel(
            settings.whisper_model,
            device="cpu",
            compute_type="int8",
        )
    return _whisper_model


async def _download_audio(item_id: str, url: str) -> Optional[str]:
    def _run() -> Optional[str]:
        try:
            import yt_dlp
        except ImportError:
            logger.warning("yt-dlp not installed; skipping video download")
            return None
        out_dir = settings.media_dir
        out_tmpl = os.path.join(out_dir, f"{item_id}.%(ext)s")
        ydl_opts = {
            "format": "bestaudio/best",
            "outtmpl": out_tmpl,
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "retries": 2,
        }
        if settings.fb_cookies_path and os.path.exists(settings.fb_cookies_path):
            ydl_opts["cookiefile"] = settings.fb_cookies_path
        post = {
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "64",
        }
        if settings.ffmpeg_location:
            post["ffmpeg_location"] = settings.ffmpeg_location
        ydl_opts["postprocessors"] = [post]
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([url])
        except Exception as e:
            logger.warning("video download failed for %s: %s", url, e)
            return None
        # yt-dlp writes <id>.mp3 after audio extraction
        candidate = os.path.join(out_dir, f"{item_id}.mp3")
        return candidate if os.path.exists(candidate) else None

    try:
        return await asyncio.wait_for(asyncio.to_thread(_run), timeout=180)
    except asyncio.TimeoutError:
        logger.warning("video download timed out for item %s", item_id)
        return None


async def _transcribe(path: str) -> Optional[str]:
    def _run() -> Optional[str]:
        try:
            model = _get_whisper()
            segments, _ = model.transcribe(path, beam_size=5, language="en")
            return " ".join(s.text for s in segments).strip()
        except Exception as e:
            logger.warning("transcription failed: %s", e)
            return None

    async with _whisper_lock:  # whisper is CPU-heavy; serialize to avoid OOM
        try:
            return await asyncio.wait_for(asyncio.to_thread(_run), timeout=600)
        except asyncio.TimeoutError:
            logger.warning("transcription timed out")
            return None


async def process_video(item: Item) -> Optional[str]:
    """Download + transcribe the first usable video. Returns transcript or None.

    Any failure (download, ffmpeg, transcription) is recorded on item.video_error and
    degrades gracefully to None so the pipeline falls back to the post description only.
    """
    if not settings.whisper_enabled or not item.video_urls:
        return None
    audio_path = None
    for url in item.video_urls:
        audio_path = await _download_audio(item.id, url)
        if audio_path:
            break
    if not audio_path:
        item.video_error = (
            "download failed"
            + (" (try setting FB_COOKIES_PATH for saved/private videos)" if not settings.fb_cookies_path else "")
        )
        return None
    try:
        transcript = await _transcribe(audio_path)
        item.video_error = None
        return transcript
    except Exception as e:
        item.video_error = f"transcription failed: {e}"[:200]
        return None
    finally:
        try:
            os.remove(audio_path)
        except OSError:
            pass
