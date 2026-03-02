# PDF Read-Aloud

Minimal local web app: upload a PDF, extract text per page (with OCR when needed), then view the PDF and extracted text side-by-side and play TTS read-aloud with synced page jumping and text highlighting.

## Stack

- **Backend:** FastAPI (Python), pymupdf, pytesseract, pyttsx3
- **Frontend:** React, TypeScript, Vite, PDF.js

Runs fully locally; no external paid APIs.

## Requirements

- **Python 3.10+** (backend)
- **Node.js 18+** (frontend)
- **Tesseract OCR** (for PDFs with little or no extractable text)

### Installing Tesseract

OCR is used when a page has very little text from normal extraction. You must install Tesseract on your machine:

- **macOS (Homebrew):**
  ```bash
  brew install tesseract
  ```
- **Windows:**  
  Install from [UB-Mannheim/tesseract](https://github.com/UB-Mannheim/tesseract/wiki) and add the install directory (e.g. `C:\Program Files\Tesseract-OCR`) to your `PATH`.
- **Linux (Debian/Ubuntu):**
  ```bash
  sudo apt install tesseract-ocr
  ```
- **Linux (Fedora):**
  ```bash
  sudo dnf install tesseract
  ```

## Setup and run

### 1. Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Backend will create `backend/data/uploads/` and `backend/data/{docId}/` as needed.

### 2. Frontend

In another terminal:

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**. The dev server proxies `/api` to the backend at `http://127.0.0.1:8000`.

## Usage

1. **Upload PDF** — Choose a PDF file.
2. **Process** — Start processing. The app extracts text per page (using pymupdf; OCR via Tesseract if a page has little text) and generates per-page WAV files with pyttsx3.
3. **View** — Left: PDF viewer (PDF.js). Right: extracted text by page.
4. **Play** — Use Play/Pause and Prev/Next. When playing, audio advances by page; the PDF and text panel jump to the current page and the active text block is highlighted and scrolled into view.
5. **Click text** — Clicking a page’s text block jumps the PDF to that page and starts playing that page’s audio.

## API (backend)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/upload` | Upload PDF; returns `docId`. |
| POST | `/process/{docId}` | Start background job: extract text, run TTS per page. |
| GET | `/status/{docId}` | Progress: `donePages`, `totalPages`, `stage`. |
| GET | `/pages/{docId}` | Returns `pages.json` (list of `{page, text}`). |
| GET | `/audio/{docId}/{page}` | Stream WAV for the given page. |
| GET | `/pdf/{docId}` | Stream the uploaded PDF. |

## Windows Desktop App

Freya can be packaged as a single `Freya Setup.exe` installer — no Python, Node, or terminal required.

### Install from a release

1. Download `Freya Setup <version>.exe` from the [Releases](../../releases) page (or the **Actions** tab if you triggered a manual build).
2. Run the installer — it installs to your user profile by default and creates a Start Menu and Desktop shortcut.
3. Launch **Freya** from the shortcut or Start Menu.

The installer bundles the FastAPI backend (via PyInstaller) and the React frontend (static files). When you launch Freya, the backend starts automatically in the background on port 8000, and the Electron window loads the app.

### Optional: Tesseract OCR (for scanned PDFs)

Tesseract is **not** bundled. If you need OCR on image-heavy PDFs:

1. Download the Windows installer from [UB-Mannheim/tesseract](https://github.com/UB-Mannheim/tesseract/wiki).
2. Run it and note the install path (default: `C:\Program Files\Tesseract-OCR`).
3. Add that path to your system `PATH` (System Properties → Environment Variables → Path → New).

Freya works without Tesseract; pages with no extractable text will simply appear empty.

### Build the installer yourself (Windows only)

Requires: **Python 3.11**, **Node.js 20**, and a Windows machine (PyInstaller cannot cross-compile).

```bat
git clone <this-repo>
cd Freya
build.bat
```

The finished installer is written to `electron\dist\Freya Setup <version>.exe`.

### Build via GitHub Actions

Push a version tag to trigger an automated build on a `windows-latest` runner:

```bash
git tag v1.0.0
git push origin v1.0.0
```

Then download the artifact from the Actions run. You can also trigger it manually from the **Actions → Build Windows Installer → Run workflow** button.

### Troubleshooting

| Symptom | Fix |
|---------|-----|
| “Backend failed to start” dialog on launch | Another app is using port 8000 — stop it and relaunch Freya. |
| App opens but PDFs won’t process | Tesseract is missing and the PDF is scanned — install Tesseract (see above). |
| Blank white window on launch | The backend is slow to start; wait a few seconds and relaunch. |
| Installer blocked by Windows Defender SmartScreen | Click “More info” → “Run anyway” — the binary is unsigned (no code-signing cert). |

---

## Repo structure

```
Freya/
├── README.md
├── build.bat                  # Windows build script
├── .github/workflows/
│   └── build-windows.yml      # CI: builds installer on windows-latest
├── backend/
│   ├── main.py
│   ├── requirements.txt
│   ├── freya.spec             # PyInstaller spec
│   └── data/                  # created at runtime
│       ├── uploads/           # {docId}.pdf
│       └── {docId}/
│           ├── pages.json
│           └── tts/           # page-001.wav, ...
├── frontend/
│   ├── index.html
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── api.ts
│       ├── PdfViewer.tsx
│       ├── TextPanel.tsx
│       └── index.css
└── electron/
    ├── package.json           # electron-builder config
    ├── main.js                # Electron main process
    └── assets/
        └── icon.ico           # App icon (256×256, multi-size)
```

## Notes

- **OCR:** If Tesseract is not installed, pages with little or no extractable text will remain mostly empty; the app will not call external OCR APIs.
- **pyttsx3** uses the system’s built-in TTS (macOS “Samantha”, Windows SAPI). No extra install needed on Windows.
- Job progress is kept in memory; restarting the backend resets it. Processed outputs under `data/{docId}/` persist until you delete them.
