@echo off
setlocal enabledelayedexpansion

echo ============================================================
echo  Freya Windows Build Script
echo ============================================================
echo.

:: ---- 1. Backend (PyInstaller) ----
echo [1/3] Building backend...
cd /d "%~dp0backend"
pip install -r requirements.txt
if errorlevel 1 ( echo ERROR: pip install failed & exit /b 1 )
pip install pyinstaller
if errorlevel 1 ( echo ERROR: pip install pyinstaller failed & exit /b 1 )
pyinstaller freya.spec
if errorlevel 1 ( echo ERROR: PyInstaller failed & exit /b 1 )
echo Backend built: backend\dist\freya-backend\freya-backend.exe
echo.

:: ---- 2. Frontend (Vite) ----
echo [2/3] Building frontend...
cd /d "%~dp0frontend"
call npm ci
if errorlevel 1 ( echo ERROR: npm ci failed & exit /b 1 )
set VITE_API_BASE=http://localhost:8000
call npm run build
if errorlevel 1 ( echo ERROR: npm run build failed & exit /b 1 )
echo Frontend built: frontend\dist\
echo.

:: ---- 3. Electron installer ----
echo [3/3] Building Electron installer...
cd /d "%~dp0electron"
call npm ci
if errorlevel 1 ( echo ERROR: npm ci failed & exit /b 1 )
call npm run dist
if errorlevel 1 ( echo ERROR: electron-builder failed & exit /b 1 )
echo.
echo ============================================================
echo  Done! Installer is in: electron\dist\Freya Setup*.exe
echo ============================================================
