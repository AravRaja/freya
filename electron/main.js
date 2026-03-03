'use strict'

const { app, BrowserWindow, dialog } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const net = require('net')

const BACKEND_PORT = 8000
const POLL_INTERVAL_MS = 250
const POLL_TIMEOUT_MS = 30000

let mainWindow = null
let backendProcess = null

function getBackendExe() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'backend', 'freya-backend.exe')
  }
  // Dev: expect PyInstaller output relative to repo root
  return path.join(__dirname, '..', 'backend', 'dist', 'freya-backend', 'freya-backend.exe')
}

function getFrontendIndex() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'frontend', 'index.html')
  }
  return path.join(__dirname, '..', 'frontend', 'dist', 'index.html')
}

function startBackend() {
  const exe = getBackendExe()
  const logDir = app.getPath('userData')
  const logPath = path.join(logDir, 'backend.log')
  const fs = require('fs')
  fs.mkdirSync(logDir, { recursive: true })
  const logStream = fs.openSync(logPath, 'w')

  backendProcess = spawn(exe, [], {
    windowsHide: true,
    stdio: ['ignore', logStream, logStream],
  })
  backendProcess.on('error', (err) => {
    fs.appendFileSync(logPath, `\n[electron] spawn error: ${err.message}\n`)
  })
  backendProcess.on('exit', (code) => {
    fs.appendFileSync(logPath, `\n[electron] backend exited with code: ${code}\n`)
  })
}

function pollPort(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    function attempt() {
      const sock = new net.Socket()
      sock.setTimeout(200)
      sock.connect(port, '127.0.0.1', () => {
        sock.destroy()
        resolve()
      })
      sock.on('error', () => {
        sock.destroy()
        if (Date.now() >= deadline) {
          reject(new Error(`Backend did not start within ${timeoutMs / 1000}s`))
        } else {
          setTimeout(attempt, POLL_INTERVAL_MS)
        }
      })
      sock.on('timeout', () => {
        sock.destroy()
        if (Date.now() >= deadline) {
          reject(new Error(`Backend did not start within ${timeoutMs / 1000}s`))
        } else {
          setTimeout(attempt, POLL_INTERVAL_MS)
        }
      })
    }
    attempt()
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  const indexPath = getFrontendIndex()
  mainWindow.loadFile(indexPath)

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  startBackend()

  try {
    await pollPort(BACKEND_PORT, POLL_TIMEOUT_MS)
  } catch (err) {
    const logPath = path.join(app.getPath('userData'), 'backend.log')
    dialog.showErrorBox(
      'Freya — Backend failed to start',
      `The backend server did not respond on port ${BACKEND_PORT}.\n\n${err.message}\n\nCheck the log for details:\n${logPath}`
    )
    app.quit()
    return
  }

  createWindow()
})

app.on('window-all-closed', () => {
  if (backendProcess) {
    backendProcess.kill()
    backendProcess = null
  }
  app.quit()
})

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow()
  }
})
