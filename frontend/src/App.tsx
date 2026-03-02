import { useCallback, useEffect, useRef, useState } from 'react'
import { PdfViewer } from './PdfViewer'
import { api } from './api'
import aiProfileImg from '../ai_profile.png'

type PageItem = { page: number; text: string }

export default function App() {
  const [view, setView] = useState<'library' | 'reader'>('library')
  const [docId, setDocId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0, stage: '', readyAudioPages: [] as number[] })
  const [pages, setPages] = useState<PageItem[]>([])
  const [currentPage, setCurrentPage] = useState(1)
  const [playing, setPlaying] = useState(false)
  const [books, setBooks] = useState<{ docId: string; title: string; processed: boolean }[]>([])
  const [autoplay, setAutoplay] = useState(false)
  const [audioEnabled, setAudioEnabled] = useState(false)
  const [textPanelOpen, setTextPanelOpen] = useState(false)
  const [viewPage, setViewPage] = useState(1)
  const [audioLoading, setAudioLoading] = useState(false)
  const [batchProgress, setBatchProgress] = useState<{ current: string; index: number; total: number } | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const playWhenReadyRef = useRef(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const headerRef = useRef<HTMLElement>(null)
  const [headerHeight, setHeaderHeight] = useState(52)
  const [freyaTitleReveal, setFreyaTitleReveal] = useState(false)
  const [freyaEggClicks, setFreyaEggClicks] = useState(0)
  const [freyaEggRevealed, setFreyaEggRevealed] = useState(false)
  const [freyaToast, setFreyaToast] = useState(false)
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null)
  const [editingTitleValue, setEditingTitleValue] = useState('')
  const [pdfNumPages, setPdfNumPages] = useState(0)
  const [pageInputValue, setPageInputValue] = useState('1')
  const [pageInputFocused, setPageInputFocused] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMessages, setChatMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [chatLoading, setChatLoading] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [chatApiKey, setChatApiKey] = useState(() => typeof localStorage !== 'undefined' ? (localStorage.getItem('readaloud_openai_key') ?? '') : '')
  const [chatSettingsOpen, setChatSettingsOpen] = useState(false)
  const chatListRef = useRef<HTMLDivElement>(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const loadPages = useCallback(async (id: string) => {
    try {
      const data = await api.pages(id)
      setPages(data.pages)
    } catch {
      setPages([])
    }
  }, [])

  const pollStatus = useCallback(async () => {
    if (!docId) return
    try {
      const s = await api.status(docId)
      setProgress({
        done: s.donePages,
        total: s.totalPages,
        stage: s.stage,
        readyAudioPages: s.readyAudioPages ?? [],
      })
      if (s.stage === 'error') {
        stopPolling()
        setProcessing(false)
        setError(s.error ?? 'Processing failed')
      } else if (s.stage === 'done') {
        stopPolling()
        setProcessing(false)
        loadPages(docId)
      } else if (s.stage === 'tts' || s.stage === 'extracting') {
        if (s.totalPages > 0) {
          try {
            const data = await api.pages(docId)
            if (data.pages?.length) setPages(data.pages)
          } catch {
            // pages.json not ready yet
          }
        }
      }
    } catch (e) {
      console.error(e)
    }
  }, [docId, stopPolling, loadPages])

  const refreshLibrary = useCallback(async () => {
    try {
      const { books: list } = await api.library()
      setBooks(list)
    } catch (e) {
      console.error(e)
    }
  }, [])

  useEffect(() => {
    if (view === 'library') refreshLibrary()
  }, [view, refreshLibrary])

  useEffect(() => {
    const el = headerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeaderHeight(el.getBoundingClientRect().height))
    ro.observe(el)
    setHeaderHeight(el.getBoundingClientRect().height)
    return () => ro.disconnect()
  }, [view])

  const openBook = useCallback(
    async (id: string) => {
      setDocId(id)
      setCurrentPage(1)
      setViewPage(1)
      setPages([])
      setPdfNumPages(0)
      setView('reader')
      setError(null)
      try {
        const [pagesData, statusData] = await Promise.all([api.pages(id), api.status(id)])
        setPages(pagesData.pages)
        setProgress((p) => ({
          ...p,
          done: statusData.donePages,
          total: statusData.totalPages,
          stage: statusData.stage,
          readyAudioPages: statusData.readyAudioPages ?? [],
        }))
      } catch {
        await loadPages(id).catch(() => {})
      }
    },
    [loadPages]
  )

  const onUpload = useCallback(async (f: File) => {
    setError(null)
    setPages([])
    setDocId(null)
    setCurrentPage(1)
    setView('reader')
    try {
      const { docId: id, duplicate } = await api.upload(f)
      if (duplicate) {
        setError('This PDF is already in your library. Opened existing copy.')
        await openBook(id)
      } else {
        setDocId(id)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      console.error(e)
    }
  }, [openBook])

  const onProcess = useCallback(async () => {
    if (!docId) return
    setError(null)
    setProcessing(true)
    setProgress({ done: 0, total: 0, stage: 'starting', readyAudioPages: [] })
    try {
      await api.process(docId)
      pollRef.current = setInterval(pollStatus, 1500)
    } catch (e) {
      setProcessing(false)
      setError(e instanceof Error ? e.message : String(e))
      console.error(e)
    }
  }, [docId, pollStatus])

  const deleteBook = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation()
      if (!confirm('Remove this book from the library?')) return
      try {
        await api.deleteBook(id)
        if (docId === id) {
          setDocId(null)
          setPages([])
          setView('library')
        }
        refreshLibrary()
      } catch (e) {
        console.error(e)
      }
    },
    [docId, refreshLibrary]
  )

  useEffect(() => {
    return () => stopPolling()
  }, [stopPolling])

  const totalPages = pages.length > 0 ? pages.length : pdfNumPages
  const readyAudioPages = progress.readyAudioPages
  const pdfUrl = docId ? `/api/pdf/${docId}` : null
  const audioUrl =
    audioEnabled &&
    docId &&
    currentPage >= 1 &&
    totalPages >= 1 &&
    currentPage <= totalPages
      ? `/api/audio/${docId}/${currentPage}`
      : null

  const goToPage = useCallback((page: number) => {
    const p = Math.max(1, Math.min(page, totalPages || 1))
    setCurrentPage(p)
    setViewPage(p)
    setPageInputValue(String(p))
  }, [totalPages])

  const applyPageInput = useCallback(() => {
    const n = parseInt(pageInputValue, 10)
    if (!Number.isNaN(n) && n >= 1) goToPage(Math.min(n, totalPages || n))
    else setPageInputValue(String(currentPage))
    setPageInputFocused(false)
  }, [pageInputValue, currentPage, totalPages, goToPage])

  useEffect(() => {
    if (!pageInputFocused) setPageInputValue(String(currentPage))
  }, [currentPage, pageInputFocused])

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem('readaloud_openai_key', chatApiKey)
  }, [chatApiKey])

  useEffect(() => {
    const el = chatListRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chatMessages, chatLoading])

  const sendChat = useCallback(async () => {
    const text = chatInput.trim()
    if (!text || chatLoading) return
    if (!chatApiKey.trim()) {
      setChatSettingsOpen(true)
      return
    }
    const userMsg = { role: 'user' as const, content: text }
    setChatMessages((prev) => [...prev, userMsg])
    setChatInput('')
    setChatLoading(true)
    const pageForContext = playing ? currentPage : viewPage
    const context =
      pages.length > 0 && pageForContext >= 1 && pageForContext <= pages.length
        ? (pages[pageForContext - 1]?.text ?? '').trim()
        : ''
    const messages = [...chatMessages, userMsg].map((m) => ({ role: m.role, content: m.content }))
    try {
      const { content } = await api.chat({
        openai_api_key: chatApiKey.trim(),
        messages,
        context: context || undefined,
      })
      setChatMessages((prev) => [...prev, { role: 'assistant', content }])
    } catch (e) {
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', content: 'Error: ' + (e instanceof Error ? e.message : String(e)) },
      ])
    } finally {
      setChatLoading(false)
    }
  }, [chatInput, chatLoading, chatApiKey, chatMessages, pages, currentPage, viewPage, playing])

  const getNextPageWithText = useCallback((fromPage: number): number | null => {
    for (let i = fromPage; i <= totalPages; i++) {
      const p = pages[i - 1]
      if (p?.text?.trim()) return i
    }
    return null
  }, [pages, totalPages])

  const getFirstPageWithText = useCallback((): number | null => getNextPageWithText(1), [getNextPageWithText])

  const onAudioEnded = useCallback(() => {
    if (!autoplay) {
      setPlaying(false)
      return
    }
    const next = getNextPageWithText(currentPage + 1)
    if (next != null) {
      setCurrentPage(next)
      setViewPage(next)
      setTextPanelOpen(true)
    } else {
      setPlaying(false)
    }
  }, [autoplay, currentPage, getNextPageWithText])

  const onPlayPause = useCallback(() => {
    if (playing) {
      playWhenReadyRef.current = false
      const audio = audioRef.current
      if (audio) {
        audio.pause()
        audio.currentTime = 0
      }
      setPlaying(false)
      return
    }
    if (!audioEnabled) return
    const first = getFirstPageWithText()
    if (first != null && first !== currentPage) setCurrentPage(first)
    setPlaying(true)
  }, [playing, currentPage, audioEnabled, getFirstPageWithText])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !audioUrl) return
    playWhenReadyRef.current = false
    audio.pause()
    audio.src = audioUrl
    if (playing) {
      playWhenReadyRef.current = true
      setAudioLoading(true)
      const playWhenReady = () => {
        if (!playWhenReadyRef.current) return
        audio.play().catch(console.error)
      }
      if (audio.readyState >= 3) playWhenReady()
      else audio.addEventListener('canplaythrough', playWhenReady, { once: true })
    }
  }, [audioUrl, playing])

  // Prefetch TTS for nearby pages (5 ahead, 2 behind); skip empty pages
  const PREFETCH_AHEAD = 5
  const PREFETCH_BEHIND = 2
  useEffect(() => {
    if (!audioEnabled || !docId || totalPages < 1 || pages.length === 0) return
    const controller = new AbortController()
    const base = `/api/audio/${docId}`
    const center = playing ? currentPage : viewPage
    for (let i = -PREFETCH_BEHIND; i <= PREFETCH_AHEAD; i++) {
      const page = center + i
      if (page < 1 || page > totalPages) continue
      const pageData = pages[page - 1]
      if (!pageData?.text?.trim()) continue
      fetch(`${base}/${page}`, { signal: controller.signal }).catch(() => {})
    }
    return () => controller.abort()
  }, [audioEnabled, docId, currentPage, viewPage, playing, totalPages, pages])

  const onPdfPageClick = useCallback(
    (page: number) => {
      goToPage(page)
      setTextPanelOpen(true)
      if (audioEnabled && totalPages > 0 && page >= 1 && page <= totalPages) setPlaying(true)
    },
    [goToPage, totalPages, audioEnabled]
  )

  const onPdfCurrentPageChange = useCallback((pageNum: number) => {
    setViewPage(pageNum)
  }, [])

  const processBatch = useCallback(async () => {
    const toProcess = books.filter((b) => !b.processed)
    if (toProcess.length === 0) return
    setError(null)
    for (let i = 0; i < toProcess.length; i++) {
      const b = toProcess[i]
      setBatchProgress({ current: b.title, index: i + 1, total: toProcess.length })
      try {
        await api.process(b.docId)
        await new Promise<void>((resolve) => {
          const poll = async () => {
            try {
              const s = await api.status(b.docId)
              if (s.stage === 'done' || s.stage === 'error') {
                resolve()
                return
              }
            } catch {
              resolve()
              return
            }
            setTimeout(poll, 800)
          }
          poll()
        })
      } catch (e) {
        console.error(e)
      }
    }
    setBatchProgress(null)
    refreshLibrary()
  }, [books, refreshLibrary])

  const onTitleClick = useCallback(() => {
    setFreyaTitleReveal((prev) => !prev)
  }, [])

  const titleShort = useCallback((s: string, words = 4) => {
    const w = (s || '').trim().split(/\s+/)
    if (w.length <= words) return s || ''
    return w.slice(0, words).join(' ') + (w.length > words ? '…' : '')
  }, [])

  const saveRename = useCallback(
    async (docId: string) => {
      const val = editingTitleValue.trim()
      if (!val) {
        setEditingTitleId(null)
        return
      }
      try {
        await api.renameBook(docId, val)
        setBooks((prev) =>
          prev.map((b) => (b.docId === docId ? { ...b, title: val } : b))
        )
      } catch (e) {
        console.error(e)
      }
      setEditingTitleId(null)
      setEditingTitleValue('')
    },
    [editingTitleValue]
  )

  const onFreyaEggClick = useCallback(() => {
    if (freyaEggRevealed) return
    const next = freyaEggClicks + 1
    setFreyaEggClicks(next)
    if (next >= 3) {
      setFreyaEggRevealed(true)
      setFreyaToast(true)
      setTimeout(() => setFreyaToast(false), 2200)
    }
  }, [freyaEggClicks, freyaEggRevealed])

  if (view === 'library') {
    return (
      <div className="app">
        <header className="header">
          <div className="header-main-row">
            <h1
              role="button"
              tabIndex={0}
              onClick={onTitleClick}
              onKeyDown={(e) => e.key === 'Enter' && onTitleClick()}
              title={freyaTitleReveal ? '' : 'Click to reveal'}
              style={{ cursor: 'pointer' }}
            >
              Read-Aloud
              {freyaTitleReveal && <span className="app-title-subtle"> · for Freya</span>}
            </h1>
            <div className="header-actions">
              <label className="btn btn-upload">
                Upload PDF
                <input
                  type="file"
                  accept=".pdf"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) onUpload(f)
                  }}
                />
              </label>
            </div>
          </div>
        </header>
        <main className="library-main">
          {books.some((b) => !b.processed) && (
            <div className="library-batch-actions">
              <button
                type="button"
                className="btn btn-accent"
                disabled={batchProgress !== null}
                onClick={processBatch}
              >
                {batchProgress
                  ? `Processing ${batchProgress.index}/${batchProgress.total}…`
                  : 'Process unprocessed'}
              </button>
              {batchProgress && (
                <span className="library-batch-current">{batchProgress.current}</span>
              )}
            </div>
          )}
          {books.length === 0 ? (
            <p className="library-empty">No books yet. Upload a PDF to add one.</p>
          ) : (
            <ul className="library-grid">
              {books.map((b) => (
                <li key={b.docId} className="library-card-wrap">
                  <div className="library-card">
                    <button
                      type="button"
                      className="library-card-poster"
                      onClick={() => openBook(b.docId)}
                    >
                      <img
                        src={`/api/thumbnail/${b.docId}`}
                        alt=""
                        onError={(e) => {
                          e.currentTarget.style.display = 'none'
                        }}
                      />
                    </button>
                    {!b.processed && (
                      <div className="library-card-unprocessed">Not processed</div>
                    )}
                    <div className="library-card-info">
                      {editingTitleId === b.docId ? (
                        <input
                          type="text"
                          className="library-card-title-input"
                          value={editingTitleValue}
                          onChange={(e) => setEditingTitleValue(e.target.value)}
                          onBlur={() => saveRename(b.docId)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveRename(b.docId)
                            if (e.key === 'Escape') {
                              setEditingTitleId(null)
                              setEditingTitleValue('')
                            }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          autoFocus
                          aria-label="Rename title"
                        />
                      ) : (
                        <span
                          className="library-card-title"
                          onDoubleClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            setEditingTitleId(b.docId)
                            setEditingTitleValue(b.title)
                          }}
                          title={`${b.title} — Double-click to rename`}
                        >
                          {titleShort(b.title)}
                        </span>
                      )}
                      <button
                        type="button"
                        className="library-card-delete"
                        onClick={(e) => { e.stopPropagation(); deleteBook(b.docId, e) }}
                        aria-label="Delete"
                        title="Delete"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </main>
        <button
          type="button"
          className={`freya-egg ${freyaEggRevealed ? 'revealed' : ''}`}
          onClick={onFreyaEggClick}
          aria-label="Easter egg"
          title={freyaEggRevealed ? 'For Freya' : ''}
        >
          {freyaEggRevealed ? 'For Freya ♥' : '·'}
        </button>
        {freyaToast && (
          <div className="freya-toast" role="status">
            Made for you, Freya
          </div>
        )}
      </div>
    )
  }

  const textPanelPage = playing ? currentPage : viewPage
  const textPanelPageData = pages[textPanelPage - 1]

  return (
    <div className="app">
      <header ref={headerRef} className="header header-fixed">
        {/* ── Main toolbar row ── */}
        <div className="header-main-row">
          {/* Left: back + title */}
          <div className="header-left">
            <button type="button" className="btn btn-nav" onClick={() => setView('library')}>
              ← Library
            </button>
            <h1
              role="button"
              tabIndex={0}
              onClick={onTitleClick}
              onKeyDown={(e) => e.key === 'Enter' && onTitleClick()}
              title={freyaTitleReveal ? '' : 'Click to reveal'}
              style={{ cursor: 'pointer' }}
            >
              Read-Aloud
              {freyaTitleReveal && <span className="app-title-subtle"> · for Freya</span>}
            </h1>
          </div>

          {/* Center: page navigation */}
          <div className="header-center">
            <button
              className="btn btn-nav"
              disabled={!docId || currentPage <= 1}
              onClick={() => { goToPage(currentPage - 1); setTextPanelOpen(true) }}
              title="Previous page"
            >
              Prev
            </button>
            <span className="page-indicator">
              <input
                type="text"
                inputMode="numeric"
                className="page-indicator-input"
                value={pageInputValue}
                onChange={(e) => setPageInputValue(e.target.value.replace(/\D/g, '').slice(0, 5))}
                onFocus={() => setPageInputFocused(true)}
                onBlur={applyPageInput}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applyPageInput()
                  if (e.key === 'Escape') {
                    setPageInputValue(String(currentPage))
                    setPageInputFocused(false)
                    e.currentTarget.blur()
                  }
                }}
                aria-label="Page number"
                title="Type page number and press Enter"
              />
              {totalPages ? ` / ${totalPages}` : ''}
            </span>
            <button
              className="btn btn-nav"
              disabled={!docId || (totalPages > 0 && currentPage >= totalPages)}
              onClick={() => { goToPage(currentPage + 1); setTextPanelOpen(true) }}
              title="Next page"
            >
              Next
            </button>
          </div>

          {/* Right: playback + process */}
          <div className="header-right">
            {audioLoading && (
              <span className="header-loading" role="status" aria-label="Loading audio">
                <span className="header-loading-spinner" />
              </span>
            )}
            <button
              className="btn btn-play"
              disabled={!audioEnabled || totalPages === 0 || getFirstPageWithText() == null}
              onClick={onPlayPause}
            >
              {playing ? 'Pause' : '▶ Play'}
            </button>
            <label className="toggle-label" title="Enable text-to-speech audio">
              <input
                type="checkbox"
                checked={audioEnabled}
                onChange={(e) => {
                  const on = e.target.checked
                  setAudioEnabled(on)
                  if (!on) {
                    playWhenReadyRef.current = false
                    audioRef.current?.pause()
                    setPlaying(false)
                  }
                }}
                aria-label="Audio on/off"
              />
              <span className="toggle-pill">{audioEnabled ? 'Audio ON' : 'Audio OFF'}</span>
            </label>
            <label className="toggle-label" title="Advance to next page when audio ends">
              <input
                type="checkbox"
                checked={autoplay}
                onChange={(e) => setAutoplay(e.target.checked)}
                disabled={!audioEnabled}
                aria-label="Autoplay"
              />
              <span className="toggle-pill">{autoplay ? 'Autoplay ON' : 'Autoplay OFF'}</span>
            </label>
            <button
              className="btn btn-accent"
              disabled={!docId || processing}
              onClick={onProcess}
            >
              {processing ? 'Processing…' : 'Process'}
            </button>
          </div>
        </div>

        {/* ── Progress strip (below toolbar) ── */}
        {processing && (
          <>
            <div className="progress-strip">
              <div
                className="progress-strip-fill"
                style={{
                  width: progress.total
                    ? `${(100 * progress.done) / progress.total}%`
                    : '0%',
                }}
              />
            </div>
            <div className="progress-label">
              {progress.stage} — {progress.done}/{progress.total}
              {readyAudioPages.length > 0 ? ` · ${readyAudioPages.length} audio ready` : ''}
            </div>
          </>
        )}

        {/* ── Error strip ── */}
        {error && (
          <div className="error-strip" role="alert">
            {error}
          </div>
        )}
      </header>

      <audio
        ref={audioRef}
        src={audioUrl ?? undefined}
        onEnded={onAudioEnded}
        onPlay={() => {
          setPlaying(true)
          setAudioLoading(false)
        }}
        onPause={(e) => {
          if (!e.currentTarget.ended) {
            playWhenReadyRef.current = false
            setPlaying(false)
          }
        }}
        onCanPlay={() => setAudioLoading(false)}
        onError={() => setAudioLoading(false)}
      />

      <div
        className={`main ${textPanelOpen ? 'main-with-panel' : ''}`}
        style={{ paddingTop: headerHeight }}
      >
        <div className="panel pdf-panel">
          <PdfViewer
            key={docId ?? 'none'}
            url={pdfUrl}
            page={currentPage}
            onPageClick={onPdfPageClick}
            onCurrentPageChange={onPdfCurrentPageChange}
            onNumPages={setPdfNumPages}
          />
        </div>
        {textPanelOpen && (
          <div
            className="text-panel-single text-panel-fixed"
            style={{ top: headerHeight, height: `calc(100vh - ${headerHeight}px)` }}
          >
            <button
              type="button"
              className="text-panel-close"
              onClick={() => setTextPanelOpen(false)}
              aria-label="Close text panel"
            >
              ×
            </button>
            {pages.length === 0 ? (
              <p className="text-placeholder">No text yet. Process the PDF first.</p>
            ) : textPanelPageData ? (
              <>
                <div className="text-panel-single-header">Page {textPanelPage}</div>
                <div className="text-block-body text-block-body-selectable">
                  {textPanelPageData.text || '(no text)'}
                </div>
              </>
            ) : null}
          </div>
        )}

        {/* Laurence chat */}
        <button
          type="button"
          className={`chat-trigger chat-trigger-avatar ${chatOpen ? 'chat-trigger-open' : ''}`}
          style={{ top: headerHeight + 12 }}
          onClick={() => setChatOpen((o) => !o)}
          aria-label={chatOpen ? 'Close Laurence chat' : 'Open Laurence chat'}
          title="Chat with Laurence about this page"
        >
          <img src={aiProfileImg} alt="" className="chat-trigger-avatar-img" />
        </button>
        {chatOpen && (
          <div className="chat-panel" style={{ top: headerHeight }}>
            <div className="chat-panel-header">
              <img src={aiProfileImg} alt="" className="chat-panel-avatar" />
              <span className="chat-panel-title">Laurence</span>
              <button
                type="button"
                className="chat-panel-close"
                onClick={() => setChatOpen(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="chat-settings-toggle-wrap">
              <button
                type="button"
                className="chat-settings-toggle"
                onClick={() => setChatSettingsOpen((o) => !o)}
              >
                {chatSettingsOpen ? 'Hide settings' : 'API key'}
              </button>
            </div>
            {chatSettingsOpen && (
              <div className="chat-settings">
                <label className="chat-settings-label">
                  OpenAI API key
                  <input
                    type="password"
                    className="chat-settings-input"
                    placeholder="sk-…"
                    value={chatApiKey}
                    onChange={(e) => setChatApiKey(e.target.value)}
                    autoComplete="off"
                  />
                </label>
              </div>
            )}
            <div className="chat-messages" ref={chatListRef}>
              {chatMessages.length === 0 && !chatLoading && (
                <p className="chat-placeholder">
                  Ask about the current page. {pages.length > 0 ? 'Page text is included as context.' : 'Process the PDF to add page context.'}
                </p>
              )}
              {chatMessages.map((m, i) => (
                <div key={i} className={`chat-msg chat-msg-${m.role}`}>
                  {m.role === 'assistant' && (
                    <img src={aiProfileImg} alt="" className="chat-msg-avatar" />
                  )}
                  <div className="chat-msg-content">
                    <span className="chat-msg-role">{m.role === 'user' ? 'You' : 'Laurence'}</span>
                    <div className="chat-msg-body">{m.content}</div>
                  </div>
                </div>
              ))}
              {chatLoading && (
                <div className="chat-msg chat-msg-assistant">
                  <img src={aiProfileImg} alt="" className="chat-msg-avatar" />
                  <div className="chat-msg-content">
                    <span className="chat-msg-role">Laurence</span>
                    <div className="chat-msg-body chat-typing">
                      <span className="chat-typing-dot" />
                      <span className="chat-typing-dot" />
                      <span className="chat-typing-dot" />
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="chat-input-wrap">
              <input
                type="text"
                className="chat-input"
                placeholder="Ask about this page…"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    sendChat()
                  }
                }}
                disabled={chatLoading}
              />
              <button
                type="button"
                className="btn btn-accent chat-send"
                disabled={chatLoading || !chatInput.trim()}
                onClick={sendChat}
              >
                Send
              </button>
            </div>
          </div>
        )}

        <button
          type="button"
          className={`freya-egg ${freyaEggRevealed ? 'revealed' : ''}`}
          onClick={onFreyaEggClick}
          aria-label="Easter egg"
          title={freyaEggRevealed ? 'For Freya' : ''}
        >
          {freyaEggRevealed ? 'For Freya ♥' : '·'}
        </button>
        {freyaToast && (
          <div className="freya-toast" role="status">
            Made for you, Freya
          </div>
        )}
      </div>
    </div>
  )
}
