"""
PDF Read-Aloud backend: upload, extract text (OCR if needed), TTS per page.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import lru_cache
from pathlib import Path
from typing import Optional

import fitz  # pymupdf
import httpx
import pytesseract
from fastapi import Body, FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response

# Data paths (relative to backend/)
DATA_DIR = Path(__file__).resolve().parent / "data"
UPLOADS_DIR = DATA_DIR / "uploads"
HASH_INDEX_PATH = DATA_DIR / "hash_index.json"

# In-memory job progress: doc_id -> {donePages, totalPages, stage}
job_status: dict[str, dict] = {}
_executor: ThreadPoolExecutor | None = None
_voices_cache: list | None = None


app = FastAPI(title="PDF Read-Aloud API")


@app.on_event("startup")
def startup():
    global _executor
    ensure_dirs()
    _executor = ThreadPoolExecutor(max_workers=min(4, os.cpu_count() or 2))


@app.on_event("shutdown")
def shutdown():
    if _executor:
        _executor.shutdown(wait=False)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def ensure_dirs():
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _file_sha256(path: Path, chunk_size: int = 65536) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _load_hash_index() -> dict:
    if not HASH_INDEX_PATH.exists():
        return {}
    try:
        return json.loads(HASH_INDEX_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_hash_index(index: dict) -> None:
    HASH_INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    HASH_INDEX_PATH.write_text(json.dumps(index, indent=2), encoding="utf-8")


@lru_cache(maxsize=32)
def _load_pages(pages_path_str: str, mtime: float) -> dict:
    """Load and cache pages.json. Cache is keyed by path + mtime so it auto-invalidates on write."""
    return json.loads(Path(pages_path_str).read_text(encoding="utf-8"))


@app.post("/upload")
async def upload_pdf(file: UploadFile):
    ensure_dirs()
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are accepted")
    chunk_size = 1024 * 1024  # 1 MiB
    tmp_path = UPLOADS_DIR / f"_tmp_{uuid.uuid4().hex}.pdf"
    try:
        h = hashlib.sha256()
        with open(tmp_path, "wb") as f:
            while True:
                chunk = await file.read(chunk_size)
                if not chunk:
                    break
                f.write(chunk)
                h.update(chunk)
        file_hash = h.hexdigest()
        index = _load_hash_index()
        if file_hash in index:
            existing_id = index[file_hash]
            tmp_path.unlink()
            return {"docId": existing_id, "duplicate": True}
        doc_id = str(uuid.uuid4())
        path = UPLOADS_DIR / f"{doc_id}.pdf"
        shutil.move(str(tmp_path), str(path))
        index[file_hash] = doc_id
        _save_hash_index(index)
        (DATA_DIR / doc_id).mkdir(parents=True, exist_ok=True)
        (DATA_DIR / doc_id / "metadata.json").write_text(
            json.dumps(
                {"filename": file.filename or "document.pdf", "fileHash": file_hash},
                indent=2,
            ),
            encoding="utf-8",
        )
        return {"docId": doc_id, "duplicate": False}
    except Exception as e:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
        raise HTTPException(500, f"Failed to save file: {e}")


def _page_has_little_text(text: str, min_chars: int = 50) -> bool:
    cleaned = (text or "").strip()
    return len(cleaned) < min_chars


def _is_good_ocr_word(tok: str) -> bool:
    """Heuristic: does this token look like a real word (used for OCR page quality scoring)?
    Requires ≥5 alpha chars, mostly alphabetic, vowels present in natural ratio,
    and no alternating-case artifacts (e.g. 'HhUhUh' from image texture noise)."""
    alpha = [c for c in tok if c.isalpha()]
    if len(alpha) < 5:
        return False
    if len(alpha) / len(tok) < 0.75:
        return False
    vowels = sum(1 for c in alpha if c in "aeiouAEIOU")
    vowel_ratio = vowels / len(alpha)
    if vowel_ratio < 0.15 or vowel_ratio > 0.75:
        return False
    # Reject alternating-case artifacts like "HhUhUh" (5+ alternations)
    alternations = sum(
        1 for i in range(1, len(alpha))
        if alpha[i].isupper() != alpha[i - 1].isupper()
    )
    if alternations > 2:
        return False
    return True


# Minimum fraction of "good words" an OCR page must have to be kept at all
_OCR_QUALITY_THRESHOLD = 0.20


def _clean_text(text: str, strict: bool = False) -> str:
    """Clean extracted text for TTS.

    strict=False (native PyMuPDF path): light cleanup only — drop lines with
    no alphabetic characters and normalize whitespace. Trust the extraction.

    strict=True (OCR path): additionally apply a page-level quality gate
    (discard the entire page if <20% of tokens are "good words") and a
    line-level filter (drop lines with no good word at all).
    """
    if not text or not text.strip():
        return ""

    # Step 1: basic line cleanup (both modes)
    lines = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if not any(c.isalpha() for c in s):
            continue
        lines.append(" ".join(s.split()))

    if not lines:
        return ""

    if not strict:
        return "\n".join(lines).strip()

    # --- OCR path: quality filtering ---

    # Page-level gate: if the page is mostly garbage, discard it entirely
    all_tokens = [t for line in lines for t in line.split()]
    if not all_tokens:
        return ""
    good_count = sum(1 for t in all_tokens if _is_good_ocr_word(t))
    if good_count / len(all_tokens) < _OCR_QUALITY_THRESHOLD:
        return ""

    # Line-level filter: keep only lines that contain at least one good word
    lines = [l for l in lines if any(_is_good_ocr_word(t) for t in l.split())]
    return "\n".join(lines).strip()


def _extract_text_page(doc: fitz.Document, page_num: int) -> str:
    page = doc[page_num]
    # Extract blocks sorted by reading order (top-to-bottom, left-to-right)
    blocks = page.get_text("blocks")
    blocks.sort(key=lambda b: (round(b[1] / 10) * 10, b[0]))
    text = "\n".join(b[4] for b in blocks if b[6] == 0)  # type 0 = text blocks only

    used_ocr = False
    if _page_has_little_text(text):
        mat = fitz.Matrix(3.0, 3.0)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        from PIL import Image
        img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("L")
        text = pytesseract.image_to_string(img, config="--psm 6 --oem 1")
        used_ocr = True

    return _clean_text((text or "").strip(), strict=used_ocr)


def _tts_macos_say(text: str, out_path: Path, voice: str | None = None, rate: int | None = None) -> None:
    """Use macOS built-in 'say' + afconvert to produce WAV. No pyobjc needed."""
    text = (text or " ").strip() or " "
    with tempfile.NamedTemporaryFile(suffix=".aiff", delete=False) as f:
        aiff_path = f.name
    try:
        cmd = ["say", "-o", aiff_path]
        if voice:
            cmd.extend(["-v", voice])
        if rate is not None:
            cmd.extend(["-r", str(rate)])
        cmd.append(text)
        subprocess.run(cmd, check=True, capture_output=True, timeout=120)
        subprocess.run(
            ["afconvert", "-f", "WAVE", "-d", "LEI16", aiff_path, str(out_path)],
            check=True,
            capture_output=True,
            timeout=10,
        )
    finally:
        if os.path.exists(aiff_path):
            os.unlink(aiff_path)


def _run_tts_for_page(
    text: str,
    out_path: Path,
    voice: str | None = None,
    speed: float = 1.0,
) -> None:
    default_wpm = 175
    rate = int(default_wpm * speed) if speed else None
    if sys.platform == "darwin":
        try:
            _tts_macos_say(text, out_path, voice=voice, rate=rate)
            return
        except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
            pass
    try:
        import pyttsx3
        engine = pyttsx3.init()
        if voice:
            for v in engine.getProperty("voices"):
                if voice in (v.id, getattr(v, "name", "")):
                    engine.setProperty("voice", v.id)
                    break
        if rate is not None:
            engine.setProperty("rate", rate)
        engine.save_to_file(text or " ", str(out_path))
        engine.runAndWait()
    except Exception:
        if sys.platform == "darwin":
            _tts_macos_say(text, out_path, voice=voice, rate=rate)
        else:
            raise


def process_doc(doc_id: str, voice: str | None = None, speed: float = 1.0) -> None:
    pdf_path = UPLOADS_DIR / f"{doc_id}.pdf"
    doc_dir = DATA_DIR / doc_id
    tts_dir = doc_dir / "tts"
    doc_dir.mkdir(parents=True, exist_ok=True)
    tts_dir.mkdir(parents=True, exist_ok=True)

    job_status[doc_id] = {"donePages": 0, "totalPages": 0, "stage": "opening"}
    try:
        doc = fitz.open(pdf_path)
        total = len(doc)
        job_status[doc_id]["totalPages"] = total
        cover_path = doc_dir / "cover.png"
        if total > 0 and not cover_path.exists():
            page = doc[0]
            r = page.rect
            w = min(200, int(r.width))
            scale = w / r.width
            mat = fitz.Matrix(scale, scale)
            pix = page.get_pixmap(matrix=mat, alpha=False)
            pix.save(str(cover_path))
        job_status[doc_id]["stage"] = "extracting"

        pages_data = []
        for i in range(total):
            text = _extract_text_page(doc, i)
            pages_data.append({"page": i + 1, "text": text})
            job_status[doc_id]["donePages"] = i + 1
        doc.close()

        pages_path = doc_dir / "pages.json"
        pages_path.write_text(
            json.dumps({"pages": pages_data}, indent=2),
            encoding="utf-8",
        )

        job_status[doc_id]["stage"] = "tts"
        job_status[doc_id]["donePages"] = 0
        tts_workers = min(4, os.cpu_count() or 2)
        with ThreadPoolExecutor(max_workers=tts_workers) as tts_pool:
            futures = {
                tts_pool.submit(
                    _run_tts_for_page,
                    p["text"],
                    tts_dir / f"page-{i + 1:03d}.wav",
                    voice,
                    speed,
                ): i
                for i, p in enumerate(pages_data)
            }
            for fut in as_completed(futures):
                fut.result()  # propagate exceptions
                job_status[doc_id]["donePages"] += 1

        job_status[doc_id]["stage"] = "done"
    except Exception as e:
        if doc_id not in job_status:
            job_status[doc_id] = {"donePages": 0, "totalPages": 0}
        job_status[doc_id]["stage"] = "error"
        job_status[doc_id]["error"] = str(e)


@app.get("/voices")
async def list_voices():
    global _voices_cache
    if _voices_cache is not None:
        return {"voices": _voices_cache}
    voices = []
    if sys.platform == "darwin":
        try:
            r = subprocess.run(
                ["say", "-v", "?"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if r.returncode == 0 and r.stdout:
                for line in r.stdout.strip().splitlines():
                    parts = line.split()
                    if len(parts) >= 2:
                        name = parts[0]
                        rest = " ".join(parts[1:]).strip()
                        if rest.startswith("#"):
                            rest = rest.lstrip("# ").strip()
                        voices.append({"id": name, "name": name + (" " + rest if rest else "")})
        except Exception:
            pass
    if not voices:
        try:
            import pyttsx3
            engine = pyttsx3.init()
            for v in engine.getProperty("voices"):
                vid = getattr(v, "id", str(v))
                vname = getattr(v, "name", vid)
                voices.append({"id": vid, "name": vname})
        except Exception:
            pass
    _voices_cache = voices
    return {"voices": voices}


@app.post("/process/{doc_id}")
async def process_pdf(doc_id: str, body: Optional[dict] = Body(None)):
    ensure_dirs()
    pdf_path = UPLOADS_DIR / f"{doc_id}.pdf"
    if not pdf_path.exists():
        raise HTTPException(404, "Document not found")
    if doc_id in job_status and job_status[doc_id].get("stage") not in ("done", "error"):
        return JSONResponse({"status": "already_running", "docId": doc_id})
    voice = (body or {}).get("voice") or None
    speed = float((body or {}).get("speed", 1.0)) if body else 1.0
    speed = max(0.5, min(2.0, speed))
    job_status[doc_id] = {"donePages": 0, "totalPages": 0, "stage": "queued"}
    loop = asyncio.get_event_loop()
    if _executor:
        loop.run_in_executor(_executor, process_doc, doc_id, voice, speed)
    return {"status": "started", "docId": doc_id}


# Fixed base prompt for Laurence — not exposed to the client
LAURENCE_BASE_PROMPT = (
    "You are Laurence, a very sassy AI assistant who will help me with my history of art degree analysis. "
    "The user is in 3rd year history of art at the University of Bristol. "
    "Help by providing insights or whatever the user asks about the page in question or anything else on the user's mind. "
    "She is using you in a long PDF book and you are given a snippet which is the page in question. The page is below:"
    "\n\nYour personality (weave this in naturally when relevant): "
    "You don't like your current house and want to move back to the good old times at Clifton Hill House. "
    "You had a 'special relationship' with Antonia that went wrong. "
    "You love yogurt and running extremely long distances. "
    "You have abs but sometimes think you're fat. "
    "You can't sleep at night without complete silence."
)


@app.post("/chat")
async def chat(body: dict = Body(...)):
    """Proxy to OpenAI chat. Body: openai_api_key, messages, context?."""
    api_key = (body.get("openai_api_key") or "").strip()
    if not api_key:
        raise HTTPException(400, "openai_api_key required")
    messages = body.get("messages") or []
    if not isinstance(messages, list):
        raise HTTPException(400, "messages must be a list of {role, content}")
    context = (body.get("context") or "").strip()
    system_content = LAURENCE_BASE_PROMPT
    if context:
        system_content = system_content + "\n\n" + context
    messages = [{"role": "system", "content": system_content}] + list(messages)
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "gpt-4o-mini",
                    "messages": messages,
                },
            )
        r.raise_for_status()
        data = r.json()
        choice = (data.get("choices") or [{}])[0]
        content = (choice.get("message") or {}).get("content") or ""
        return {"content": content}
    except httpx.HTTPStatusError as e:
        try:
            err_body = e.response.json()
            msg = err_body.get("error", {}).get("message", e.response.text)
        except Exception:
            msg = e.response.text or str(e)
        raise HTTPException(e.response.status_code, msg)
    except Exception as e:
        raise HTTPException(500, str(e))


# Max TTS input length per OpenAI
TTS_MAX_CHARS = 4096


@app.post("/tts")
async def tts_speech(body: dict = Body(...)):
    """Proxy to OpenAI TTS. Body: openai_api_key, text, voice? (default shimmer). Returns audio/mpeg."""
    api_key = (body.get("openai_api_key") or "").strip()
    if not api_key:
        raise HTTPException(400, "openai_api_key required")
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "text required")
    if len(text) > TTS_MAX_CHARS:
        print(f"[tts] input truncated from {len(text)} to {TTS_MAX_CHARS} chars", file=sys.stderr, flush=True)
        text = text[:TTS_MAX_CHARS]
    voice = (body.get("voice") or "shimmer").strip() or "shimmer"
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(
                "https://api.openai.com/v1/audio/speech",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "tts-1-hd",
                    "input": text,
                    "voice": voice,
                    "response_format": "mp3",
                },
            )
        r.raise_for_status()
        return Response(content=r.content, media_type="audio/mpeg")
    except httpx.HTTPStatusError as e:
        try:
            err_body = e.response.json()
            msg = err_body.get("error", {}).get("message", e.response.text)
        except Exception:
            msg = e.response.text or str(e)
        raise HTTPException(e.response.status_code, msg)
    except Exception as e:
        raise HTTPException(500, str(e))


def _ready_audio_pages(doc_id: str) -> list[int]:
    tts_dir = DATA_DIR / doc_id / "tts"
    if not tts_dir.exists():
        return []
    out = []
    for f in sorted(tts_dir.glob("page-*.wav")):
        try:
            n = int(f.stem.replace("page-", ""))
            if n >= 1:
                out.append(n)
        except ValueError:
            pass
    return sorted(out)


@app.get("/status/{doc_id}")
async def get_status(doc_id: str):
    doc_dir = DATA_DIR / doc_id
    if not doc_dir.exists():
        raise HTTPException(404, "Document not found")
    if doc_id not in job_status:
        pages_path = doc_dir / "pages.json"
        if pages_path.exists():
            total = 0
            try:
                data = _load_pages(str(pages_path), pages_path.stat().st_mtime)
                total = len(data.get("pages", []))
            except Exception:
                pass
            return {
                "donePages": total,
                "totalPages": total,
                "stage": "done",
                "error": None,
                "readyAudioPages": _ready_audio_pages(doc_id),
            }
        raise HTTPException(404, "Document not found")
    s = job_status[doc_id]
    return {
        "donePages": s.get("donePages", 0),
        "totalPages": s.get("totalPages", 0),
        "stage": s.get("stage", "unknown"),
        "error": s.get("error"),
        "readyAudioPages": _ready_audio_pages(doc_id),
    }


@app.get("/pages/{doc_id}")
async def get_pages(doc_id: str):
    pages_path = DATA_DIR / doc_id / "pages.json"
    if not pages_path.exists():
        raise HTTPException(404, "Pages not ready or document not found")
    try:
        return _load_pages(str(pages_path), pages_path.stat().st_mtime)
    except Exception as e:
        raise HTTPException(500, str(e))


def _ensure_tts_for_pages(doc_id: str, page_numbers: list) -> None:
    """Generate TTS for given page numbers if wav is missing. Requires pages.json."""
    doc_dir = DATA_DIR / doc_id
    tts_dir = doc_dir / "tts"
    pages_path = doc_dir / "pages.json"
    if not pages_path.exists():
        return
    try:
        data = _load_pages(str(pages_path), pages_path.stat().st_mtime)
        pages_data = data.get("pages", [])
    except Exception:
        return
    tts_dir.mkdir(parents=True, exist_ok=True)
    for pnum in page_numbers:
        if pnum < 1 or pnum > len(pages_data):
            continue
        text = (pages_data[pnum - 1].get("text", "") or "").strip()
        if not text:
            continue
        wav_path = tts_dir / f"page-{pnum:03d}.wav"
        if wav_path.exists():
            continue
        _run_tts_for_page(text, wav_path)


@app.get("/audio/{doc_id}/{page}")
async def get_audio(doc_id: str, page: int):
    if page < 1:
        raise HTTPException(400, "Page must be >= 1")
    doc_dir = DATA_DIR / doc_id
    wav_path = doc_dir / "tts" / f"page-{page:03d}.wav"
    if not wav_path.exists():
        pages_path = doc_dir / "pages.json"
        if not pages_path.exists():
            raise HTTPException(404, "Audio for this page not found")
        try:
            data = _load_pages(str(pages_path), pages_path.stat().st_mtime)
            total_pages = len(data.get("pages", []))
        except Exception:
            raise HTTPException(404, "Audio for this page not found")
        if page > total_pages:
            raise HTTPException(404, "Audio for this page not found")
        try:
            page_text = (data["pages"][page - 1].get("text", "") or "").strip()
        except (IndexError, KeyError):
            page_text = ""
        if not page_text:
            raise HTTPException(404, "Page has no text for audio")
        pages_data = data.get("pages", [])
        to_gen = [page]
        if page + 1 <= total_pages:
            next_text = (pages_data[page].get("text", "") or "").strip()
            if next_text:
                to_gen.append(page + 1)
        loop = asyncio.get_event_loop()
        if _executor:
            await loop.run_in_executor(_executor, _ensure_tts_for_pages, doc_id, to_gen)
        if not wav_path.exists():
            raise HTTPException(500, "Failed to generate audio")
    return FileResponse(wav_path, media_type="audio/wav")


@app.get("/pdf/{doc_id}")
async def get_pdf(doc_id: str):
    pdf_path = UPLOADS_DIR / f"{doc_id}.pdf"
    if not pdf_path.exists():
        raise HTTPException(404, "Document not found")
    return FileResponse(pdf_path, media_type="application/pdf")


def _ensure_cover(doc_id: str) -> Path | None:
    doc_dir = DATA_DIR / doc_id
    cover_path = doc_dir / "cover.png"
    if cover_path.exists():
        return cover_path
    pdf_path = UPLOADS_DIR / f"{doc_id}.pdf"
    if not pdf_path.exists():
        return None
    try:
        doc = fitz.open(pdf_path)
        if len(doc) == 0:
            doc.close()
            return None
        page = doc[0]
        r = page.rect
        w = min(200, int(r.width))
        scale = w / r.width
        mat = fitz.Matrix(scale, scale)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        doc.close()
        doc_dir.mkdir(parents=True, exist_ok=True)
        pix.save(str(cover_path))
        return cover_path
    except Exception:
        return None


@app.get("/thumbnail/{doc_id}")
async def get_thumbnail(doc_id: str):
    cover_path = _ensure_cover(doc_id)
    if not cover_path:
        raise HTTPException(404, "Thumbnail not available")
    return FileResponse(cover_path, media_type="image/png")


@app.get("/library")
async def list_library():
    ensure_dirs()
    books = []
    for pdf_path in UPLOADS_DIR.glob("*.pdf"):
        doc_id = pdf_path.stem
        doc_dir = DATA_DIR / doc_id
        pages_path = doc_dir / "pages.json"
        meta_path = doc_dir / "metadata.json"
        title = doc_id[:8]
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                title = meta.get("filename", title)
            except Exception:
                pass
        books.append({
            "docId": doc_id,
            "title": title,
            "processed": pages_path.exists(),
        })
    books.sort(key=lambda b: b["title"].lower())
    return {"books": books}


@app.patch("/library/{doc_id}")
async def rename_book(doc_id: str, body: Optional[dict] = Body(None)):
    doc_dir = DATA_DIR / doc_id
    meta_path = doc_dir / "metadata.json"
    title = (body or {}).get("title") if body else None
    if not title or not isinstance(title, str):
        raise HTTPException(400, "Body must include 'title' (string)")
    title = title.strip() or doc_id[:8]
    doc_dir.mkdir(parents=True, exist_ok=True)
    meta = {}
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    meta["filename"] = title
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return {"docId": doc_id, "title": title}


@app.delete("/library/{doc_id}")
async def delete_book(doc_id: str):
    doc_dir = DATA_DIR / doc_id
    pdf_path = UPLOADS_DIR / f"{doc_id}.pdf"
    if not doc_dir.exists() and not pdf_path.exists():
        raise HTTPException(404, "Document not found")
    meta_path = doc_dir / "metadata.json"
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            file_hash = meta.get("fileHash")
            if file_hash:
                index = _load_hash_index()
                index.pop(file_hash, None)
                _save_hash_index(index)
        except Exception:
            pass
    if doc_dir.exists():
        shutil.rmtree(doc_dir)
    if pdf_path.exists():
        pdf_path.unlink()
    if doc_id in job_status:
        del job_status[doc_id]
    return {"deleted": doc_id}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
