# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Freya is a local PDF read-aloud app. Users upload PDFs to a library, process them (text extraction + TTS generation per page), then read with a side-by-side PDF viewer and extracted text panel. A "Laurence" AI assistant (OpenAI GPT-4o-mini) can answer questions about the current page. The app ships as a Windows desktop installer (Electron + PyInstaller).

## Dev commands

### Backend (Python 3.10+)
```bash
cd backend
python -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### Frontend (Node 18+)
```bash
cd frontend
npm install
npm run dev        # dev server at http://localhost:5173
npm run build      # production build to frontend/dist/
```

### Windows installer (Windows only, requires Python 3.11 + Node 20)
```bat
build.bat
# Output: electron\dist\Freya Setup <version>.exe
```
The build script runs: PyInstaller (`backend/freya.spec`) → Vite build → electron-builder.

## Architecture

### Request flow
- **Dev:** Vite dev server (`localhost:5173`) proxies `/api/*` → FastAPI (`localhost:8000`). The proxy strips the `/api` prefix.
- **Electron/prod:** Frontend is loaded as `file://` from `frontend/dist/`. `VITE_API_BASE` is set to `http://localhost:8000` at build time (no `/api` prefix). Electron spawns `freya-backend.exe` on startup and polls port 8000 before showing the window.
- **`api.ts` `BASE` constant:** defaults to `/api` in dev, overridden by `VITE_API_BASE` env var in Electron builds.

### Backend (`backend/main.py`)
Single-file FastAPI app. Key responsibilities:
- **Upload:** SHA-256 deduplication via `data/hash_index.json`; stores PDFs as `data/uploads/{docId}.pdf`
- **Processing pipeline** (`process_doc`): runs in a `ThreadPoolExecutor`. Stages: `opening → extracting → tts → done`. Extracts text with PyMuPDF; falls back to Tesseract OCR (3× upscale, PSM 6) when a page has <50 chars. OCR output is quality-filtered (`_OCR_QUALITY_THRESHOLD = 0.20`). TTS uses macOS `say`/`afconvert` on macOS, `pyttsx3` + `pythoncom.CoInitialize` on Windows (COM must be init'd per thread).
- **On-demand TTS:** `/audio/{docId}/{page}` generates the WAV on the fly if missing, and prefetches the next page.
- **Job state** is in-memory (`job_status` dict); restarting the backend resets it. Persisted data lives in `data/{docId}/`.
- **AI endpoints:** `/chat` proxies to OpenAI `gpt-4o-mini` with a hardcoded system prompt for "Laurence"; `/tts` proxies to OpenAI `tts-1-hd` (shimmer voice, MP3 output). Both require the client to pass `openai_api_key`.

### Frontend (`frontend/src/`)
- **`App.tsx`** — single large component managing all state: library view vs. reader view, playback, polling, chat.
- **`PdfViewer.tsx`** — renders all pages to `<canvas>` via PDF.js. Pages load with a staggered delay (`pageNum * 80ms`); a "priority" mechanism lets the user click to load a specific page first. Uses HTTP range requests (`rangeChunkSize: 65536`).
- **`TextPanel`** — inline in `App.tsx` (not a separate file despite the name in the README); shows extracted text for the current page.
- **`api.ts`** — typed wrappers around all backend endpoints. All calls go through `apiFetch` which catches network errors and gives a helpful message.

### Data layout at runtime
```
backend/data/
  hash_index.json          # sha256 → docId
  uploads/{docId}.pdf
  {docId}/
    metadata.json          # {filename, fileHash}
    pages.json             # {pages: [{page, text}, ...]}
    cover.png              # first-page thumbnail (200px wide)
    tts/
      page-001.wav
      page-002.wav
      ...
```

### Electron (`electron/main.js`)
Spawns `freya-backend.exe` from `resources/backend/`, polls port 8000 for up to 30s, then opens a `BrowserWindow` loading `resources/frontend/index.html` via `file://`. Backend log goes to `userData/backend.log`.

## Key constraints / gotchas
- **TTS on Windows:** `pyttsx3` uses COM (SAPI5). Each worker thread must call `pythoncom.CoInitialize()` / `CoUninitialize()`. Already handled in `_run_tts_for_page`.
- **macOS TTS:** Uses `say` + `afconvert` (ships with macOS). `pyttsx3` is fallback only.
- **Tesseract is optional.** If missing, pages with <50 chars of native text will be empty; the app still works.
- **No tests** exist in the repo currently.
- **`TextPanel.tsx`** is listed in the README's repo structure but the actual component code lives inline in `App.tsx` — don't create a duplicate file.
- The `LAURENCE_BASE_PROMPT` in `backend/main.py` is intentionally opinionated and personal — it's a feature, not a bug.
