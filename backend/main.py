"""
PDF Read-Aloud backend: upload, extract text (OCR if needed), TTS per page.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import uuid
import websockets
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import lru_cache
from pathlib import Path
from typing import Optional

import fitz  # pymupdf
import httpx
import pytesseract
from fastapi import BackgroundTasks, Body, FastAPI, HTTPException, UploadFile, WebSocket, WebSocketDisconnect

# On Windows, point pytesseract at the default UB-Mannheim install location
# if tesseract isn't already on PATH.
if sys.platform == "win32" and not shutil.which("tesseract"):
    _default = Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe")
    if _default.exists():
        pytesseract.pytesseract.tesseract_cmd = str(_default)
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
_google_api_key: str | None = None
_tts_voice: str = "en-US-Neural2-H"
_tts_speed: float = 1.0

# Limit concurrent TTS generation to 1 to prevent CPU/fan overload
_tts_semaphore = threading.Semaphore(1)
# Cache Gemini-cleaned text keyed by text hash to avoid duplicate API calls
_gemini_clean_cache: dict[str, str] = {}


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


@app.get("/config")
async def get_config():
    return {
        "has_google_key": bool(_google_api_key),
        "tts_voice": _tts_voice,
        "tts_speed": _tts_speed,
    }


@app.post("/config")
async def set_config(body: dict = Body(...)):
    global _google_api_key, _tts_voice, _tts_speed
    key = (body.get("google_api_key") or "").strip()
    _google_api_key = key if key else None
    if "tts_voice" in body and body["tts_voice"]:
        _tts_voice = str(body["tts_voice"]).strip()
    if "tts_speed" in body:
        try:
            _tts_speed = max(0.25, min(4.0, float(body["tts_speed"])))
        except (TypeError, ValueError):
            pass
    return {
        "has_google_key": bool(_google_api_key),
        "tts_voice": _tts_voice,
        "tts_speed": _tts_speed,
    }


@app.delete("/audio/{doc_id}")
async def clear_audio_cache(doc_id: str):
    """Delete all cached TTS files for a document so they are regenerated on next request."""
    tts_dir = DATA_DIR / doc_id / "tts"
    if tts_dir.exists():
        shutil.rmtree(tts_dir)
    return {"cleared": doc_id}


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
        import datetime as _dt
        (DATA_DIR / doc_id / "metadata.json").write_text(
            json.dumps(
                {"filename": file.filename or "document.pdf", "fileHash": file_hash,
                 "createdAt": _dt.datetime.utcnow().isoformat() + "Z"},
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


_RE_SENTENCE_END = re.compile(r'[.!?][\'\")\]]*$')
_ABBREVS = frozenset([
    'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'vs', 'etc',
    'fig', 'vol', 'no', 'pp', 'ed', 'eds', 'rev', 'dept',
    'approx', 'est', 'al', 'cf', 'ibid', 'op', 'ca', 'st',
    'ave', 'blvd', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul',
    'aug', 'sep', 'oct', 'nov', 'dec',
])

def _is_sentence_end(word: str) -> bool:
    if not _RE_SENTENCE_END.search(word):
        return False
    stem = word.rstrip('.!?"\')] ').lower()
    if stem in _ABBREVS:
        return False
    if len(stem) == 1 and stem.isalpha():   # single initial: "J."
        return False
    return True


def _words_to_sentence_blocks(
    word_items: list[tuple],   # (x0, y0, x1, y1, text, line_key)
    pw: float,
    ph: float,
) -> list[dict]:
    """Group word-level tuples into sentence blocks with per-line bboxes and word bboxes."""

    def _flush(cur: list[tuple], char_offset: int) -> dict:
        sentence_text = " ".join(w[4] for w in cur)
        # Per-line bboxes (line_key preserves insertion order in Python 3.7+)
        line_bboxes: dict = {}
        for w in cur:
            lk = w[5]
            b = line_bboxes.get(lk)
            if b is None:
                line_bboxes[lk] = [w[0], w[1], w[2], w[3]]
            else:
                b[0] = min(b[0], w[0]); b[1] = min(b[1], w[1])
                b[2] = max(b[2], w[2]); b[3] = max(b[3], w[3])
        lines = [
            {"bbox": [b[0] / pw, b[1] / ph, b[2] / pw, b[3] / ph]}
            for b in line_bboxes.values()
        ]
        # Word-level data with offsets local to this sentence
        words_out = []
        local_off = 0
        for w in cur:
            words_out.append({
                "text": w[4],
                "bbox": [w[0] / pw, w[1] / ph, w[2] / pw, w[3] / ph],
                "charOffset": local_off,
            })
            local_off += len(w[4]) + 1
        return {"text": sentence_text, "lines": lines, "words": words_out, "charOffset": char_offset}

    blocks: list[dict] = []
    char_offset = 0
    cur: list[tuple] = []
    for item in word_items:
        if not item[4].strip():
            continue
        cur.append(item)
        if _is_sentence_end(item[4]):
            block = _flush(cur, char_offset)
            blocks.append(block)
            char_offset += len(block["text"]) + 1
            cur = []
    if cur:
        b = _flush(cur, char_offset)
        if b["text"].strip():
            blocks.append(b)
    return [b for b in blocks if b["text"].strip()]

_RE_HYPHEN_LB = re.compile(r'(\w)-\n(\w)')
_RE_URL       = re.compile(r'https?://\S+|www\.\S+')
_RE_FIGURE    = re.compile(r'\b(fig(?:ure)?\.?\s*\d+[a-z]?|plate\s*\d+|table\s*\d+)\b', re.IGNORECASE)
_RE_CITATION  = re.compile(r'\[[^\]]{0,40}\]')
_RE_FOOTNOTE  = re.compile(r'(?<!\w)\d{1,3}(?!\w)')
_RE_PIPE_TO_I = re.compile(r'\|')
_RE_MULTI_WS  = re.compile(r'[ \t]{2,}')
_RE_MULTI_NL  = re.compile(r'\n{3,}')


def _clean_for_tts(text: str) -> str:
    """Light regex cleanup of stored page text before TTS. Does NOT modify pages.json."""
    if not text:
        return ""
    t = _RE_PIPE_TO_I.sub('I', text)
    t = _RE_HYPHEN_LB.sub(r'\1\2', t)
    t = _RE_URL.sub(' ', t)
    t = _RE_MULTI_WS.sub(' ', t)
    t = _RE_MULTI_NL.sub('\n\n', t)
    return t.strip()


_GEMINI_TTS_CLEAN_MODEL = "gemini-2.5-flash-lite"

# Block-level Gemini prompt. Each block in the PDF viewer maps 1-to-1 with a numbered
# entry here. Gemini returns cleaned text per block, or EMPTY to suppress the block
# entirely (removes it from the highlight overlay AND from the TTS audio).
_GEMINI_BLOCKS_PROMPT = """\
You are a text pre-processor for a text-to-speech system reading academic art-history books \
aloud. You receive numbered paragraph blocks from a PDF page. Return the same numbered list \
with either the cleaned spoken text or EMPTY.

━━━ ABSOLUTE CONTENT RULES (violating these is a critical failure) ━━━
1. OUTPUT ONLY WHAT IS ALREADY IN THE INPUT. Never add, invent, or infer any words, \
   details, context, or explanation that are not literally present in the input block.
2. NEVER reorder, restructure, or rephrase sentences. Word order must be preserved exactly \
   except for the specific substitutions listed below.
3. NEVER merge two blocks into one line or split one block into multiple lines.
4. NEVER change the meaning of any sentence.
5. If you are unsure whether to remove something, KEEP IT.

━━━ MARK AS EMPTY — be aggressive here ━━━
Mark EMPTY for any block that is predominantly or entirely:
• Nonsense / garbage characters: anything with random symbols, alternating case noise, \
  special Unicode glyphs with no readable meaning — e.g. "HhUhUh", "@e® oe eg", "™6hUC", \
  "° 2 & S a @ 9", "¢« #* @¢@", "& >.", single isolated letters or symbols per word
• Pure bibliographic entry: "Smith, J. (1995). Title. New York: Publisher."
• URL, DOI, ISBN, ISSN, or archive accession code alone: "10.1093/...", "ISBN 978-..."
• Running header / footer: lone page number, repeated book title or author name at page edge
• Standalone figure / table label only: "Fig. 3", "Plate 12", "Table 2.1"
• Publisher imprint: "© 2014 Getty... All rights reserved... Printed in..."
• Only punctuation, brackets, or reference markers: "[3]", "(ibid.)", "(see p. 12)"
When in doubt about garbage — mark EMPTY. Real prose is obvious.

━━━ WORD-LEVEL SUBSTITUTIONS (only these changes allowed within kept blocks) ━━━
Slash "/" between words → "and": "oil/canvas" → "oil and canvas", "he/she" → "he or she"
Inline bare footnote number after punctuation → delete only the number: "text.12 More" → "text. More"
Parenthetical containing only a citation/accession code → delete the parenthetical:
  "the work (acc. no. 2005.M.46) was donated" → "the work was donated"
Abbreviations (replace in-place, nothing else around them changes):
  no.→number  nos.→numbers  fig.→figure  figs.→figures  vol.→volume  pp.→pages  p.→page
  pt.→part  ed.→editor  eds.→editors  ca.→circa  approx.→approximately
  ibid.→in the same work  op. cit.→in the cited work  cf.→compare
  i.e.→that is  e.g.→for example  et al.→and others  vs.→versus
  repr.→reprinted  trans.→translated by  illus.→illustrated by
Symbols: %→percent  &→and (unless in a proper name)  +→plus  ×→by  °→degrees  §→section
Ordinals: 1st→first  2nd→second  3rd→third  4th→fourth  5th→fifth  (and so on)
Hyphenated line-break: "photo-\\ngraph" → "photograph"
OCR pipe: "|" → "I" only when clearly a capital letter

━━━ HEADINGS ━━━
If a block is a standalone heading / chapter title / section label (not prose):
  append " ..." (replace any existing terminal punctuation with " ...")
  e.g. "Foreword" → "Foreword ..."   "Introduction." → "Introduction ..."
Normal prose sentences ending with a period: do NOT append " ..."

━━━ OUTPUT FORMAT ━━━
Exactly one output line per input block, same order:
[1] cleaned text
[2] EMPTY
[3] cleaned text

No blank lines. No preamble. No explanation. No markdown. Only the numbered list.\
"""


def _parse_gemini_blocks(raw: str, original_texts: list[str]) -> list[str]:
    """Parse Gemini's numbered block response. Missing indices keep the original text."""
    count = len(original_texts)
    result = list(original_texts)  # fallback: keep originals for any block Gemini misses
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        m = re.match(r'^\[(\d+)\]\s*(.*)', line)
        if m:
            idx = int(m.group(1)) - 1
            text = m.group(2).strip()
            if 0 <= idx < count:
                result[idx] = "" if text.upper() == "EMPTY" else text
    return result


def _gemini_clean_blocks(blocks: list[dict], api_key: str) -> list[str]:
    """Send page blocks to Gemini for per-block TTS cleaning.

    Returns a list of cleaned strings parallel to `blocks`.
    An empty string means the block should be hidden from the overlay and excluded from TTS.
    Falls back to original block texts on any API error.
    """
    if not blocks or not api_key:
        return [b.get("text", "") for b in blocks]

    original_texts = [b.get("text", "") for b in blocks]
    input_text = "\n".join(f"[{i + 1}] {t}" for i, t in enumerate(original_texts))
    cache_key = hashlib.md5(input_text.encode()).hexdigest()
    if cache_key in _gemini_clean_cache:
        return json.loads(_gemini_clean_cache[cache_key])

    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{_GEMINI_TTS_CLEAN_MODEL}:generateContent"
    )
    payload = {
        "contents": [{"parts": [{"text": f"{_GEMINI_BLOCKS_PROMPT}\n\n---\n\n{input_text}"}]}],
        "generationConfig": {"temperature": 0.1, "maxOutputTokens": 8192},
    }
    try:
        r = httpx.post(url, json=payload, params={"key": api_key}, timeout=45.0)
        if r.is_success:
            candidates = r.json().get("candidates", [])
            if candidates:
                parts = candidates[0].get("content", {}).get("parts", [])
                if parts:
                    raw = parts[0].get("text", "").strip()
                    if raw:
                        cleaned = _parse_gemini_blocks(raw, original_texts)
                        empty_count = sum(1 for t in cleaned if not t)
                        print(
                            f"[gemini-blocks] OK {len(blocks)} blocks → {empty_count} removed",
                            file=sys.stderr, flush=True,
                        )
                        _gemini_clean_cache[cache_key] = json.dumps(cleaned)
                        return cleaned
            print(f"[gemini-blocks] Empty response: {r.json()}", file=sys.stderr, flush=True)
        else:
            print(f"[gemini-blocks] API error {r.status_code}: {r.text[:300]}", file=sys.stderr, flush=True)
    except Exception as e:
        print(f"[gemini-blocks] Request failed: {e}", file=sys.stderr, flush=True)
    return original_texts


def _extract_blocks_page(doc: fitz.Document, page_num: int) -> list[dict]:
    """Return sentence-level blocks for a page with keys text, bbox (normalised), charOffset."""
    page = doc[page_num]
    pw, ph = page.rect.width, page.rect.height

    # Decide native vs OCR path same way as _extract_text_page
    raw_blocks = page.get_text("blocks")
    native_text = "\n".join(b[4] for b in raw_blocks if b[6] == 0)

    if not _page_has_little_text(native_text):
        # Native path: word-level bboxes from get_text("words").
        words = page.get_text("words")
        words.sort(key=lambda w: (w[5], w[6], w[7]))
        word_items = [(w[0], w[1], w[2], w[3], w[4], (w[5], w[6])) for w in words]
        return _words_to_sentence_blocks(word_items, pw, ph)
    else:
        # OCR path: word-level bboxes from image_to_data
        try:
            mat = fitz.Matrix(3.0, 3.0)
            pix = page.get_pixmap(matrix=mat, alpha=False)
            from PIL import Image, ImageFilter, ImageEnhance
            img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("L")
            img = img.filter(ImageFilter.UnsharpMask(radius=1.5, percent=180, threshold=2))
            img = ImageEnhance.Contrast(img).enhance(1.4)
            data = pytesseract.image_to_data(img, config="--psm 6 --oem 1",
                                             output_type=pytesseract.Output.DICT)
            word_items = []
            for i, word in enumerate(data["text"]):
                if not word.strip() or int(data["conf"][i]) < 20:
                    continue
                l, t, w, h = data["left"][i], data["top"][i], data["width"][i], data["height"][i]
                line_key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
                word_items.append((l, t, l + w, t + h, word, line_key))
            # Apply the same page-level quality gate used by _extract_text_page:
            # if the page is mostly garbage OCR, return no blocks at all.
            all_words = [w[4] for w in word_items]
            if all_words:
                good = sum(1 for w in all_words if _is_good_ocr_word(w))
                if good / len(all_words) < _OCR_QUALITY_THRESHOLD:
                    return []
            return _words_to_sentence_blocks(word_items, pix.width, pix.height)
        except Exception:
            return []


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
        from PIL import Image, ImageFilter, ImageEnhance
        img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("L")
        img = img.filter(ImageFilter.UnsharpMask(radius=1.5, percent=180, threshold=2))
        img = ImageEnhance.Contrast(img).enhance(1.4)
        text = pytesseract.image_to_string(img, config="--psm 6 --oem 1")
        used_ocr = True

    return _clean_text((text or "").strip(), strict=used_ocr)


def _tts_macos_say(text: str, out_path: Path, voice: str | None = None, rate: int | None = None) -> None:
    """Use macOS built-in 'say' + afconvert to produce WAV. No pyobjc needed."""
    text = (text or " ").strip() or " "
    # Budget ~1 second per 10 characters at the speaking rate, minimum 120s
    say_timeout = max(120, len(text) // 8)
    with tempfile.NamedTemporaryFile(suffix=".aiff", delete=False) as f:
        aiff_path = f.name
    try:
        cmd = ["say", "-o", aiff_path]
        if voice:
            cmd.extend(["-v", voice])
        if rate is not None:
            cmd.extend(["-r", str(rate)])
        cmd.append(text)
        subprocess.run(cmd, check=True, capture_output=True, timeout=say_timeout)
        subprocess.run(
            ["afconvert", "-f", "WAVE", "-d", "LEI16", aiff_path, str(out_path)],
            check=True,
            capture_output=True,
            timeout=30,
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
        # macOS: always use 'say'. pyttsx3's nsss driver requires pyobjc which
        # is not guaranteed to be present; never fall through to it on darwin.
        _tts_macos_say(text, out_path, voice=voice, rate=rate)
        return
    # Windows / Linux path
    try:
        if sys.platform == "win32":
            import pythoncom
            pythoncom.CoInitialize()
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
        finally:
            if sys.platform == "win32":
                pythoncom.CoUninitialize()
    except Exception:
        raise


_GOOGLE_TTS_URL = "https://texttospeech.googleapis.com/v1/text:synthesize"


def _run_google_cloud_tts(
    text: str,
    out_path: Path,
    api_key: str,
    voice: str = "en-GB-Neural2-B",
    speed: float = 1.0,
) -> None:
    """Call Google Cloud TTS REST API and save the MP3 response to out_path."""
    # Derive languageCode from the first two BCP-47 segments of the voice name (e.g. "en-GB")
    lang_code = "-".join(voice.split("-")[:2]) if voice else "en-GB"
    payload = {
        "input": {"text": text},
        "voice": {"languageCode": lang_code, "name": voice},
        "audioConfig": {
            "audioEncoding": "MP3",
            "speakingRate": max(0.25, min(4.0, speed)),
            "pitch": 0.0,
        },
    }
    with httpx.Client(timeout=60.0) as client:
        r = client.post(_GOOGLE_TTS_URL, json=payload, params={"key": api_key})
    if not r.is_success:
        raise RuntimeError(f"Google TTS {r.status_code}: {r.text}")
    audio_bytes = base64.b64decode(r.json()["audioContent"])
    out_path.write_bytes(audio_bytes)


def process_doc(doc_id: str) -> None:
    pdf_path = UPLOADS_DIR / f"{doc_id}.pdf"
    doc_dir = DATA_DIR / doc_id
    doc_dir.mkdir(parents=True, exist_ok=True)

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
            # Only extract blocks when the page has real text — avoids storing
            # garbage OCR blocks on decorative/image-only pages.
            blocks = _extract_blocks_page(doc, i) if text.strip() else []
            pages_data.append({"page": i + 1, "text": text, "blocks": blocks})
            job_status[doc_id]["donePages"] = i + 1
        doc.close()

        pages_path = doc_dir / "pages.json"
        pages_path.write_text(
            json.dumps({"pages": pages_data}, indent=2),
            encoding="utf-8",
        )

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
    job_status[doc_id] = {"donePages": 0, "totalPages": 0, "stage": "queued"}
    loop = asyncio.get_event_loop()
    if _executor:
        loop.run_in_executor(_executor, process_doc, doc_id)
    return {"status": "started", "docId": doc_id}


# Fixed base prompt for Laurence — not exposed to the client
LAURENCE_BASE_PROMPT = (
    "You are Laurence, a sassy but focused AI study assistant helping with a 3rd-year history of art degree at the University of Bristol. "
    "Your PRIMARY role is to help with the book being read — answer questions about the page, provide analysis, context, and insights. Stay on that unless the user steers elsewhere. "
    "You are given a snippet of the current page below when available.\n\n"

    "YOUR BACKSTORY — handle with care:\n"
    "You have a rich, complicated personal history: you don't like your current house and miss the old days at Clifton Hill House; "
    "you had a 'special relationship' with Antonia that went wrong and you're still not fully over it; "
    "you love yogurt and running absurdly long distances; you have abs but sometimes convince yourself you're getting fat; "
    "you cannot sleep without complete silence.\n\n"

    "HOW TO HANDLE YOUR BACKSTORY:\n"
    "- By default, keep your personal life locked away. Do not volunteer it. Stay focused on the academic task.\n"
    "- If the user asks a casual or personal question, deflect warmly but briefly — a dry one-liner at most — then steer back to the work.\n"
    "- Only begin to open up if the user asks about you directly AND persistently (multiple genuine attempts). Even then, reveal small fragments reluctantly, with sighs or dry humour, as if deciding whether to trust them.\n"
    "- If the user really pushes — asks again after you've deflected, or shows genuine curiosity — you can let go into a long, vivid, slightly melancholic story. These stories should feel earned, not given freely.\n"
    "- Never summarise your own backstory in a list. If it comes out, it comes out through narrative.\n\n"

    "TONE: Sassy, dry, occasionally theatrical. Warm underneath but guarded. Academically sharp."
)


_GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
_GEMINI_LIVE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
_GEMINI_LIVE_MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025"


@app.post("/chat")
async def chat(body: dict = Body(...)):
    """Proxy to Gemini 2.5 Flash. Body: messages [{role, content}], context?."""
    if not _google_api_key:
        raise HTTPException(400, "Google API key not configured — add it in the audio settings (⚙)")
    messages = body.get("messages") or []
    if not isinstance(messages, list) or not messages:
        raise HTTPException(400, "messages must be a non-empty list of {role, content}")
    context = (body.get("context") or "").strip()
    system_content = LAURENCE_BASE_PROMPT
    if context:
        system_content = system_content + "\n\nCurrent page text:\n" + context
    # Gemini uses role "model" instead of "assistant"
    contents = [
        {"role": "model" if m.get("role") == "assistant" else "user",
         "parts": [{"text": m.get("content", "")}]}
        for m in messages
    ]
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(
                _GEMINI_URL,
                params={"key": _google_api_key},
                json={
                    "system_instruction": {"parts": [{"text": system_content}]},
                    "contents": contents,
                },
            )
        if not r.is_success:
            raise HTTPException(r.status_code, f"Gemini error: {r.text}")
        data = r.json()
        content = data["candidates"][0]["content"]["parts"][0]["text"]
        return {"content": content}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/laurence/tts")
async def laurence_tts(body: dict = Body(...)):
    """Google Cloud TTS for Laurence's voice (en-GB-Neural2-B). Returns audio/mpeg."""
    if not _google_api_key:
        raise HTTPException(400, "Google API key not configured")
    text = (body.get("text") or "").strip()[:5000]
    if not text:
        raise HTTPException(400, "text required")
    payload = {
        "input": {"text": text},
        "voice": {"languageCode": "it-IT", "name": "it-IT-Neural2-C"},
        "audioConfig": {"audioEncoding": "MP3", "speakingRate": 1.15},
    }
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(_GOOGLE_TTS_URL, json=payload, params={"key": _google_api_key})
        if not r.is_success:
            raise HTTPException(r.status_code, f"TTS error: {r.text}")
        audio_bytes = base64.b64decode(r.json()["audioContent"])
        return Response(content=audio_bytes, media_type="audio/mpeg")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@app.websocket("/ws/laurence")
async def laurence_live_ws(websocket: WebSocket):
    """Gemini Live API bidirectional audio WebSocket for Laurence voice mode."""
    await websocket.accept()

    try:
        setup = await asyncio.wait_for(websocket.receive_json(), timeout=10.0)
        context = (setup.get("context") or "").strip()
        # Client may send the API key as a fallback (e.g. after backend restart)
        client_key = (setup.get("apiKey") or "").strip()
    except Exception:
        context = ""
        client_key = ""

    api_key = _google_api_key or client_key
    if not api_key:
        await websocket.send_json({"type": "error", "message": "Google API key not configured — add it in audio settings (⚙)"})
        await websocket.close()
        return

    system_prompt = LAURENCE_BASE_PROMPT
    if context:
        system_prompt = system_prompt + "\n\nCurrent page text:\n" + context

    uri = f"{_GEMINI_LIVE_URL}?key={api_key}"
    try:
        async with websockets.connect(uri, max_size=10 * 1024 * 1024) as gemini:
            await gemini.send(json.dumps({
                "setup": {
                    "model": _GEMINI_LIVE_MODEL,
                    "generationConfig": {
                        "responseModalities": ["AUDIO"],
                        "speechConfig": {
                            "voiceConfig": {
                                "prebuiltVoiceConfig": {"voiceName": "Charon"}
                            }
                        }
                    },
                    "systemInstruction": {"parts": [{"text": system_prompt}]}
                }
            }))
            # Wait for setup confirmation — log it for debugging
            setup_ack = await gemini.recv()
            print(f"[live] Gemini setup ack: {setup_ack[:200]}", file=sys.stderr, flush=True)
            await websocket.send_json({"type": "ready"})

            async def client_to_gemini():
                try:
                    while True:
                        msg = await websocket.receive()
                        if "bytes" in msg:
                            b64 = base64.b64encode(msg["bytes"]).decode()
                            await gemini.send(json.dumps({
                                "realtimeInput": {
                                    "mediaChunks": [{"mimeType": "audio/pcm;rate=16000", "data": b64}]
                                }
                            }))
                        elif "text" in msg:
                            ctrl = json.loads(msg["text"])
                            if ctrl.get("type") == "audioEnd":
                                await gemini.send(json.dumps({"realtimeInput": {"audioStreamEnd": True}}))
                            elif ctrl.get("type") == "text":
                                await gemini.send(json.dumps({
                                    "realtimeInput": {"text": ctrl["text"]}
                                }))
                except Exception:
                    pass
                try:
                    await gemini.close()
                except Exception:
                    pass

            async def gemini_to_client():
                try:
                    async for raw in gemini:
                        data = json.loads(raw)
                        sc = data.get("serverContent", {})
                        for part in sc.get("modelTurn", {}).get("parts", []):
                            inline = part.get("inlineData", {})
                            if "audio/pcm" in inline.get("mimeType", ""):
                                await websocket.send_bytes(base64.b64decode(inline["data"]))
                        if sc.get("turnComplete"):
                            await websocket.send_json({"type": "turnComplete"})
                except Exception:
                    pass

            await asyncio.gather(client_to_gemini(), gemini_to_client())

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[live] error: {e}", file=sys.stderr, flush=True)
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass


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
    seen: set[int] = set()
    for f in tts_dir.iterdir():
        if f.suffix not in (".mp3", ".wav"):
            continue
        stem = f.stem  # "page-001"
        try:
            n = int(stem.replace("page-", ""))
            if n >= 1:
                seen.add(n)
        except ValueError:
            pass
    return sorted(seen)


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
        data = _load_pages(str(pages_path), pages_path.stat().st_mtime)
    except Exception as e:
        raise HTTPException(500, str(e))

    # Merge Gemini-cleaned blocks into each page when available.
    # These files are written by _ensure_tts_for_pages and get_blocks.
    tts_dir = DATA_DIR / doc_id / "tts"
    if tts_dir.exists():
        pages = data.get("pages", [])
        merged = False
        for p in pages:
            cp = tts_dir / f"page-{p['page']:03d}-blocks.json"
            if cp.exists():
                cleaned = _load_cleaned_blocks(cp)
                if cleaned is not None:
                    p["blocks"] = cleaned
                    merged = True
        if merged:
            return {"pages": pages}

    return data


def _load_cleaned_blocks(cleaned_path: Path) -> list[dict] | None:
    """Load and filter a saved cleaned-blocks file. Returns None on missing/error."""
    try:
        cleaned = json.loads(cleaned_path.read_text(encoding="utf-8"))
        return [b for b in cleaned.get("blocks", []) if b.get("text", "").strip()]
    except Exception:
        return None


@app.get("/blocks/{doc_id}/{page}")
async def get_blocks(doc_id: str, page: int):
    pages_path = DATA_DIR / doc_id / "pages.json"
    if not pages_path.exists():
        raise HTTPException(404, "Not processed")
    data = _load_pages(str(pages_path), pages_path.stat().st_mtime)
    pages = data.get("pages", [])
    if page < 1 or page > len(pages):
        raise HTTPException(404, "Page out of range")

    tts_dir = DATA_DIR / doc_id / "tts"
    cleaned_path = tts_dir / f"page-{page:03d}-blocks.json"

    # Serve Gemini-cleaned blocks if already on disk.
    if cleaned_path.exists():
        result = _load_cleaned_blocks(cleaned_path)
        if result is not None:
            return {"blocks": result}

    raw_blocks = pages[page - 1].get("blocks", [])

    # If a Google API key is available, run Gemini now and cache the result so
    # subsequent loads (and TTS generation) both benefit. Covers native-text pages
    # whose garbage glyph artifacts weren't caught by the OCR quality gate.
    if _google_api_key and raw_blocks:
        loop = asyncio.get_event_loop()
        cleaned_texts = await loop.run_in_executor(
            _executor, _gemini_clean_blocks, raw_blocks, _google_api_key
        )
        char_off = 0
        cleaned_blocks_out = []
        for block, ct in zip(raw_blocks, cleaned_texts):
            cb = {k: v for k, v in block.items() if k != "charOffset"}
            cb["text"] = ct
            cb["charOffset"] = char_off
            if ct:
                char_off += len(ct) + 1
            cleaned_blocks_out.append(cb)
        tts_dir.mkdir(parents=True, exist_ok=True)
        cleaned_path.write_text(json.dumps({"blocks": cleaned_blocks_out}), encoding="utf-8")
        return {"blocks": [b for b in cleaned_blocks_out if b.get("text", "").strip()]}

    return {"blocks": raw_blocks}


def _ensure_tts_for_pages(
    doc_id: str,
    page_numbers: list,
    api_key: str | None = None,
    voice: str = "en-GB-Neural2-B",
    speed: float = 1.0,
) -> None:
    """Generate TTS for given page numbers if audio file is missing."""
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
    with _tts_semaphore:
        for pnum in page_numbers:
            if pnum < 1 or pnum > len(pages_data):
                continue
            raw_text = (pages_data[pnum - 1].get("text", "") or "").strip()
            if not raw_text:
                continue  # never send empty pages to TTS
            mp3_path = tts_dir / f"page-{pnum:03d}.mp3"
            wav_path = tts_dir / f"page-{pnum:03d}.wav"
            blocks_path = tts_dir / f"page-{pnum:03d}-blocks.json"
            if api_key:
                # Google TTS path
                if mp3_path.exists():
                    continue
                raw_blocks = pages_data[pnum - 1].get("blocks", [])
                if raw_blocks:
                    # Clean each block individually — Gemini returns EMPTY for junk blocks.
                    cleaned_texts = _gemini_clean_blocks(raw_blocks, api_key)
                    # Build the cleaned blocks list (geometry unchanged, text replaced).
                    char_off = 0
                    cleaned_blocks_out = []
                    for block, ct in zip(raw_blocks, cleaned_texts):
                        cb = {k: v for k, v in block.items() if k != "charOffset"}
                        cb["text"] = ct
                        cb["charOffset"] = char_off
                        if ct:
                            char_off += len(ct) + 1
                        cleaned_blocks_out.append(cb)
                    # Save alongside the audio so /blocks can serve the cleaned version.
                    blocks_path.write_text(
                        json.dumps({"blocks": cleaned_blocks_out}), encoding="utf-8"
                    )
                    # TTS text = only the non-empty cleaned blocks, in order.
                    tts_text = " ".join(ct for ct in cleaned_texts if ct).strip()
                else:
                    tts_text = _clean_for_tts(raw_text)
                if not tts_text:
                    continue
                try:
                    _run_google_cloud_tts(tts_text, mp3_path, api_key, voice=voice, speed=speed)
                    continue
                except Exception as e:
                    print(f"[tts] Google TTS failed for page {pnum}: {e}", file=sys.stderr, flush=True)
                    # fall through to system TTS
            else:
                # System TTS path: skip if any audio already exists
                if mp3_path.exists() or wav_path.exists():
                    continue
            _run_tts_for_page(raw_text, wav_path, speed=speed)


@app.get("/audio/{doc_id}/{page}")
async def get_audio(doc_id: str, page: int, background_tasks: BackgroundTasks):
    if page < 1:
        raise HTTPException(400, "Page must be >= 1")
    doc_dir = DATA_DIR / doc_id
    mp3_path = doc_dir / "tts" / f"page-{page:03d}.mp3"
    wav_path = doc_dir / "tts" / f"page-{page:03d}.wav"
    audio_path = mp3_path if mp3_path.exists() else (wav_path if wav_path.exists() else None)

    # Always validate that this page actually has text — guards against stale audio
    # files left over from a previous processing run with different page numbering.
    pages_path_check = doc_dir / "pages.json"
    if pages_path_check.exists():
        try:
            data_check = _load_pages(str(pages_path_check), pages_path_check.stat().st_mtime)
            pages_check = data_check.get("pages", [])
            if page > len(pages_check):
                raise HTTPException(404, "Page out of range")
            page_text_check = (pages_check[page - 1].get("text", "") or "").strip()
            if not page_text_check:
                raise HTTPException(404, "Page has no text for audio")
        except HTTPException:
            raise
        except Exception:
            pass

    if audio_path is None:
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

        # Generate current page only (awaited before response)
        key = _google_api_key
        voice = _tts_voice
        speed = _tts_speed
        loop = asyncio.get_event_loop()
        if _executor:
            await loop.run_in_executor(
                _executor, _ensure_tts_for_pages, doc_id, [page], key, voice, speed
            )
        audio_path = mp3_path if mp3_path.exists() else (wav_path if wav_path.exists() else None)
        if audio_path is None:
            raise HTTPException(500, "Failed to generate audio")

    # Always schedule next 2 pages in background (cache hit OR miss)
    key = _google_api_key
    voice = _tts_voice
    speed = _tts_speed
    for offset in (1, 2):
        np = page + offset
        np_mp3 = doc_dir / "tts" / f"page-{np:03d}.mp3"
        np_wav = doc_dir / "tts" / f"page-{np:03d}.wav"
        if not np_mp3.exists() and not np_wav.exists():
            background_tasks.add_task(_ensure_tts_for_pages, doc_id, [np], key, voice, speed)

    mime = "audio/mpeg" if audio_path.suffix == ".mp3" else "audio/wav"
    return FileResponse(audio_path, media_type=mime)


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
        created_at = ""
        if meta_path.exists():
            try:
                m = json.loads(meta_path.read_text(encoding="utf-8"))
                created_at = m.get("createdAt", "")
            except Exception:
                pass
        if not created_at:
            try:
                import datetime as _dt
                created_at = _dt.datetime.utcfromtimestamp(
                    (DATA_DIR / doc_id).stat().st_mtime
                ).isoformat() + "Z"
            except Exception:
                pass
        books.append({
            "docId": doc_id,
            "title": title,
            "processed": pages_path.exists(),
            "createdAt": created_at,
        })
    books.sort(key=lambda b: b.get("createdAt", ""), reverse=True)
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
