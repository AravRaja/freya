# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for Freya backend (one-dir mode).

Build:
    cd backend
    pyinstaller freya.spec

Output: backend/dist/freya-backend/freya-backend.exe
"""

import os
from pathlib import Path

block_cipher = None

# Include the data/ directory skeleton (empty dirs are fine; runtime data accumulates there)
data_dir = Path('data')
data_dir.mkdir(exist_ok=True)
(data_dir / 'uploads').mkdir(exist_ok=True)

datas = [
    ('data', 'data'),
]

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=[
        # uvicorn internals not auto-detected
        'uvicorn.loops.auto',
        'uvicorn.loops.asyncio',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.http.h11_impl',
        'uvicorn.protocols.http.httptools_impl',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan.on',
        'uvicorn.lifespan.off',
        # Windows TTS driver + COM initialisation
        'pyttsx3.drivers',
        'pyttsx3.drivers.sapi5',
        'pythoncom',
        'win32com',
        'win32com.client',
        # async runtime
        'anyio',
        'anyio._backends._asyncio',
        'starlette',
        'starlette.routing',
        # multipart form handling
        'multipart',
        'python_multipart',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='freya-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,          # no terminal window
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='freya-backend',
)
