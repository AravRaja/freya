import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PdfViewer } from './PdfViewer'
import { api, BASE, WS_BASE } from './api'
import aiProfileImg from '../ai_profile.png'

type PageItem = { page: number; text: string; blocks?: BlockItem[] }
type WordItem  = { text: string; bbox: [number,number,number,number]; charOffset: number }
type LineItem  = { bbox: [number,number,number,number] }
type BlockItem = {
  text: string
  charOffset: number
  lines: LineItem[]
  words: WordItem[]
  bbox?: [number,number,number,number]
}

const THEMES = [
  { id: 'crimson', color: '#E50914', label: 'Crimson' },
  { id: 'ocean',   color: '#2563EB', label: 'Ocean'   },
  { id: 'forest',  color: '#059669', label: 'Forest'  },
  { id: 'violet',  color: '#7C3AED', label: 'Violet'  },
  { id: 'amber',   color: '#D97706', label: 'Amber'   },
] as const
type ColorScheme = typeof THEMES[number]['id']

export default function App() {
  const [view, setView] = useState<'library' | 'reader'>('library')
  const [docId, setDocId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0, stage: '', readyAudioPages: [] as number[] })
  const [pages, setPages] = useState<PageItem[]>([])
  const [currentPage, setCurrentPage] = useState(1)
  const [playing, setPlaying] = useState(false)
  const [books, setBooks] = useState<{ docId: string; title: string; processed: boolean; createdAt?: string }[]>([])
  const [autoplay] = useState(true)
  const [audioEnabled] = useState(true)
  const [viewPage, setViewPage] = useState(1)
  const [audioLoading, setAudioLoading] = useState(false)
  const [audioCurrentTime, setAudioCurrentTime] = useState(0)
  const [audioDuration, setAudioDuration] = useState(0)
  const [batchProgress, setBatchProgress] = useState<{ current: string; index: number; total: number } | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const playWhenReadyRef = useRef(false)
  const pendingSeekRef = useRef<number | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const headerRef = useRef<HTMLElement>(null)
  const [headerHeight, setHeaderHeight] = useState(56)
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null)
  const [editingTitleValue, setEditingTitleValue] = useState('')
  const [pdfNumPages, setPdfNumPages] = useState(0)
  const [pageInputValue, setPageInputValue] = useState('1')
  const [pageInputFocused, setPageInputFocused] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMessages, setChatMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [chatLoading, setChatLoading] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [voiceMode, setVoiceMode] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [laurenceSpeaking, setLaurenceSpeaking] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const playbackCtxRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const nextPlayTimeRef = useRef<number>(0)
  const [googleApiKey, setGoogleApiKey] = useState(() =>
    typeof localStorage !== 'undefined' ? (localStorage.getItem('readaloud_google_key') ?? '') : ''
  )
  const [audioSettingsOpen, setAudioSettingsOpen] = useState(false)
  const [ttsVoice, setTtsVoice] = useState(() =>
    typeof localStorage !== 'undefined' ? (localStorage.getItem('readaloud_tts_voice') ?? 'en-US-Neural2-H') : 'en-US-Neural2-H'
  )
  const [ttsSpeed, setTtsSpeed] = useState(() => {
    if (typeof localStorage === 'undefined') return 1.0
    const s = parseFloat(localStorage.getItem('readaloud_tts_speed') ?? '1.0')
    return isNaN(s) ? 1.0 : s
  })
  const [muted, setMuted] = useState(false)
  const [playbackSpeed, setPlaybackSpeed] = useState(() => {
    if (typeof localStorage === 'undefined') return 1
    const s = parseFloat(localStorage.getItem('readaloud_playback_speed') ?? '1')
    return isNaN(s) ? 1 : s
  })
  const playbackSpeedRef = useRef(playbackSpeed)
  const [volume, setVolume] = useState(() => {
    if (typeof localStorage === 'undefined') return 1
    const stored = parseFloat(localStorage.getItem('readaloud_volume') ?? '1')
    return isNaN(stored) ? 1 : Math.max(0, Math.min(1, stored))
  })
  const chatListRef = useRef<HTMLDivElement>(null)

  // ── Library UI state ───────────────────────────────
  const [librarySortBy, setLibrarySortBy] = useState<'date' | 'alpha'>('date')
  const [librarySortDir, setLibrarySortDir] = useState<'desc' | 'asc'>('desc')
  const [libraryViewMode, setLibraryViewMode] = useState<'grid' | 'list'>('grid')
  const [librarySearch, setLibrarySearch] = useState('')
  const [selectedBooks, setSelectedBooks] = useState<Set<string>>(new Set())
  const [contextMenu, setContextMenu] = useState<{ docId: string; x: number; y: number } | null>(null)
  const [sortDropdownOpen, setSortDropdownOpen] = useState(false)

  const [pdfZoom, setPdfZoom] = useState(0.7)
  const [searchInput, setSearchInput] = useState('')
  const [searchResults, setSearchResults] = useState<{ page: number; blockIdx: number }[]>([])
  const [searchIdx, setSearchIdx] = useState(0)

  // ── Colour scheme ──────────────────────────────────
  const [colorScheme, setColorScheme] = useState<ColorScheme>(() =>
    ((typeof localStorage !== 'undefined' ? localStorage.getItem('readaloud_theme') : null) ?? 'crimson') as ColorScheme
  )

  useEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem('readaloud_theme', colorScheme)
  }, [colorScheme])

  // ── Logic (unchanged) ──────────────────────────────
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

  // startProcessing: takes an explicit id so there's no stale-closure issue.
  const startProcessing = useCallback(async (id: string) => {
    stopPolling()
    playWhenReadyRef.current = false
    if (audioRef.current) audioRef.current.pause()
    setPlaying(false)
    setProcessing(true)
    setProgress({ done: 0, total: 0, stage: 'starting', readyAudioPages: [] })
    try {
      await api.process(id)
      pollRef.current = setInterval(async () => {
        try {
          const s = await api.status(id)
          setProgress({ done: s.donePages, total: s.totalPages, stage: s.stage, readyAudioPages: s.readyAudioPages ?? [] })
          if (s.stage === 'error') {
            stopPolling(); setProcessing(false); setError(s.error ?? 'Processing failed')
          } else if (s.stage === 'done') {
            stopPolling(); setProcessing(false); loadPages(id)
          } else if (s.totalPages > 0) {
            try {
              const data = await api.pages(id)
              if (data.pages?.length) setPages(data.pages as PageItem[])
            } catch {}
          }
        } catch (e) { console.error(e) }
      }, 1500)
    } catch (e) {
      setProcessing(false)
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [stopPolling, loadPages])

  const openBook = useCallback(
    async (id: string) => {
      setDocId(id)
      setCurrentPage(1)
      setViewPage(1)
      setPages([])
      setPdfNumPages(0)
      setView('reader')
      setError(null)
      setProgress({ done: 0, total: 0, stage: '', readyAudioPages: [] })
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
        if (!['done','extracting','tts','queued'].includes(statusData.stage)) {
          startProcessing(id)
        }
      } catch {
        await loadPages(id).catch(() => {})
        startProcessing(id)
      }
    },
    [loadPages, startProcessing]
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
        startProcessing(id)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      console.error(e)
    }
  }, [openBook, startProcessing])

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

  // All pages' blocks derived directly from pages state (no extra API calls needed —
  // blocks are already embedded in pages.json when re-processed).
  const allPageBlocks = useMemo<Record<number, BlockItem[]>>(() => {
    const map: Record<number, BlockItem[]> = {}
    for (const p of pages) {
      if (p.blocks?.length) map[p.page] = p.blocks
    }
    return map
  }, [pages])

  const pageBlocks = useMemo(() => allPageBlocks[currentPage] ?? [], [allPageBlocks, currentPage])

  const activeBlock = useMemo(() => {
    if (!audioDuration || pageBlocks.length === 0) return -1
    const totalChars = pageBlocks.reduce((s, b) => s + b.text.length + 1, 0)
    const estimatedChar = (audioCurrentTime / audioDuration) * totalChars
    let idx = 0
    for (let i = pageBlocks.length - 1; i >= 0; i--) {
      if (pageBlocks[i].charOffset <= estimatedChar) { idx = i; break }
    }
    return idx
  }, [playing, audioCurrentTime, audioDuration, pageBlocks])

  const activeWordBbox = useMemo((): [number,number,number,number] | null => {
    if (!audioDuration || activeBlock < 0) return null
    const block = pageBlocks[activeBlock]
    if (!block?.words?.length) return null
    const totalChars = pageBlocks.reduce((s, b) => s + b.text.length + 1, 0)
    const estimatedGlobalChar = (audioCurrentTime / audioDuration) * totalChars
    const estimatedLocalChar = estimatedGlobalChar - block.charOffset
    let wordIdx = 0
    for (let i = block.words.length - 1; i >= 0; i--) {
      if (block.words[i].charOffset <= estimatedLocalChar) { wordIdx = i; break }
    }
    return block.words[wordIdx]?.bbox ?? null
  }, [playing, audioCurrentTime, audioDuration, pageBlocks, activeBlock])

  const totalPages = pages.length > 0 ? pages.length : pdfNumPages
  const readyAudioPages = progress.readyAudioPages
  const pdfUrl = docId ? `${BASE}/pdf/${docId}` : null
  const audioUrl =
    audioEnabled &&
    docId &&
    currentPage >= 1 &&
    totalPages >= 1 &&
    currentPage <= totalPages
      ? `${BASE}/audio/${docId}/${currentPage}`
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
    localStorage.setItem('readaloud_google_key', googleApiKey)
    api.setConfig({
      google_api_key: googleApiKey.trim() || '',
      tts_voice: ttsVoice,
      tts_speed: ttsSpeed,
    }).catch(console.error)
  }, [googleApiKey, ttsVoice, ttsSpeed])

  useEffect(() => {
    const key = typeof localStorage !== 'undefined'
      ? localStorage.getItem('readaloud_google_key') : ''
    api.setConfig({
      google_api_key: key?.trim() || '',
      tts_voice: ttsVoice,
      tts_speed: ttsSpeed,
    }).catch(console.error)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    playbackSpeedRef.current = playbackSpeed
    if (typeof localStorage !== 'undefined') localStorage.setItem('readaloud_playback_speed', String(playbackSpeed))
    if (audioRef.current) audioRef.current.playbackRate = playbackSpeed
  }, [playbackSpeed])

  useEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem('readaloud_tts_voice', ttsVoice)
  }, [ttsVoice])

  useEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem('readaloud_tts_speed', String(ttsSpeed))
  }, [ttsSpeed])

  useEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem('readaloud_volume', String(volume))
    if (audioRef.current) audioRef.current.volume = volume
  }, [volume])

  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = muted
  }, [muted])

  useEffect(() => {
    if (!voiceMode || !chatOpen) {
      wsRef.current?.close()
      processorRef.current?.disconnect()
      streamRef.current?.getTracks().forEach((t) => t.stop())
      audioCtxRef.current?.close().catch(() => {})
      wsRef.current = null
      processorRef.current = null
      streamRef.current = null
      audioCtxRef.current = null
      setIsRecording(false)
      setLaurenceSpeaking(false)
    }
  }, [voiceMode, chatOpen])

  useEffect(() => {
    const el = chatListRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chatMessages, chatLoading])

  const playAudioChunk = useCallback((arrayBuffer: ArrayBuffer) => {
    const int16 = new Int16Array(arrayBuffer)
    if (!int16.length) return
    const float32 = new Float32Array(int16.length)
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768
    if (!playbackCtxRef.current || playbackCtxRef.current.state === 'closed') {
      playbackCtxRef.current = new AudioContext({ sampleRate: 24000 })
      nextPlayTimeRef.current = 0
    }
    const pCtx = playbackCtxRef.current
    const buf = pCtx.createBuffer(1, float32.length, 24000)
    buf.copyToChannel(float32, 0)
    const src = pCtx.createBufferSource()
    src.buffer = buf
    src.connect(pCtx.destination)
    const now = pCtx.currentTime
    const startAt = Math.max(now + 0.01, nextPlayTimeRef.current)
    src.start(startAt)
    nextPlayTimeRef.current = startAt + buf.duration
  }, [])

  const openLiveWs = useCallback((context: string): Promise<WebSocket> => {
    return new Promise((resolve, reject) => {
      wsRef.current?.close()
      const ws = new WebSocket(`${WS_BASE}/ws/laurence`)
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws
      let settled = false
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn() } }
      ws.onopen = () => ws.send(JSON.stringify({ type: 'setup', context, apiKey: googleApiKey }))
      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
          playAudioChunk(e.data)
          setLaurenceSpeaking(true)
        } else {
          try {
            const msg = JSON.parse(e.data as string)
            if (msg.type === 'ready') settle(() => resolve(ws))
            else if (msg.type === 'turnComplete') {
              setLaurenceSpeaking(false)
              setChatLoading(false)
            } else if (msg.type === 'error') {
              setChatMessages((prev) => [
                ...prev,
                { role: 'assistant' as const, content: 'Error: ' + msg.message },
              ])
              setLaurenceSpeaking(false)
              setChatLoading(false)
              settle(() => reject(new Error(msg.message)))
            }
          } catch {}
        }
      }
      ws.onerror = () => {
        setIsRecording(false)
        setLaurenceSpeaking(false)
        // don't reject here — onclose fires right after with a reason
      }
      ws.onclose = (e) => {
        setIsRecording(false)
        setLaurenceSpeaking(false)
        settle(() => reject(new Error(e.reason || `Connection closed (${e.code})`)))
      }
    })
  }, [playAudioChunk])

  const sendChat = useCallback(async (overrideText?: string, withVoice = false) => {
    const text = (overrideText ?? chatInput).trim()
    if (!text || chatLoading) return
    const userMsg = { role: 'user' as const, content: text }
    setChatMessages((prev) => [...prev, userMsg])
    if (!overrideText) setChatInput('')
    setChatLoading(true)
    const pageForContext = playing ? currentPage : viewPage
    const context =
      pages.length > 0 && pageForContext >= 1 && pageForContext <= pages.length
        ? (pages[pageForContext - 1]?.text ?? '').trim().slice(0, 2000)
        : ''

    if (withVoice) {
      try {
        const ws = await openLiveWs(context)
        nextPlayTimeRef.current = 0
        ws.send(JSON.stringify({ type: 'text', text }))
      } catch (e) {
        setChatMessages((prev) => [
          ...prev,
          { role: 'assistant' as const, content: 'Error: ' + (e instanceof Error ? e.message : String(e)) },
        ])
        setChatLoading(false)
      }
    } else {
      const messages = [...chatMessages, userMsg].map((m) => ({ role: m.role, content: m.content }))
      try {
        const { content } = await api.chat({ messages, context: context || undefined })
        setChatMessages((prev) => [...prev, { role: 'assistant', content }])
      } catch (e) {
        setChatMessages((prev) => [
          ...prev,
          { role: 'assistant', content: 'Error: ' + (e instanceof Error ? e.message : String(e)) },
        ])
      } finally {
        setChatLoading(false)
      }
    }
  }, [chatInput, chatLoading, chatMessages, pages, currentPage, viewPage, playing, openLiveWs])

  const startVoiceInput = useCallback(async () => {
    if (isRecording) {
      processorRef.current?.disconnect()
      processorRef.current = null
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      audioCtxRef.current?.close().catch(() => {})
      audioCtxRef.current = null
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'audioEnd' }))
      }
      setIsRecording(false)
      setLaurenceSpeaking(true)
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false })
      streamRef.current = stream
      const pageForContext = playing ? currentPage : viewPage
      const context =
        pages.length > 0 && pageForContext >= 1 && pageForContext <= pages.length
          ? (pages[pageForContext - 1]?.text ?? '').trim().slice(0, 2000)
          : ''
      const ws = await openLiveWs(context)
      nextPlayTimeRef.current = 0
      const captureCtx = new AudioContext({ sampleRate: 16000 })
      audioCtxRef.current = captureCtx
      const source = captureCtx.createMediaStreamSource(stream)
      const processor = captureCtx.createScriptProcessor(2048, 1, 1)
      processorRef.current = processor
      const silence = captureCtx.createGain()
      silence.gain.value = 0
      processor.onaudioprocess = (ev) => {
        if (ws.readyState !== WebSocket.OPEN) return
        const f32 = ev.inputBuffer.getChannelData(0)
        const i16 = new Int16Array(f32.length)
        for (let i = 0; i < f32.length; i++) {
          i16[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)))
        }
        ws.send(i16.buffer)
      }
      source.connect(processor)
      processor.connect(silence)
      silence.connect(captureCtx.destination)
      setIsRecording(true)
    } catch (e) {
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant' as const, content: 'Mic error: ' + (e instanceof Error ? e.message : String(e)) },
      ])
    }
  }, [isRecording, pages, currentPage, viewPage, playing, openLiveWs])

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
    } else {
      setPlaying(false)
    }
  }, [autoplay, currentPage, getNextPageWithText])

  const onPlayPause = useCallback(() => {
    if (playing) {
      playWhenReadyRef.current = false
      const audio = audioRef.current
      if (audio) audio.pause()
      setPlaying(false)
      return
    }
    if (!audioEnabled) return
    // Only seek to first page if current page has no text
    if (!pages[currentPage - 1]?.text?.trim()) {
      const first = getFirstPageWithText()
      if (first != null) setCurrentPage(first)
    }
    setPlaying(true)
  }, [playing, currentPage, audioEnabled, getFirstPageWithText])

  // Load a new audio source only when the URL changes (page turns).
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    playWhenReadyRef.current = false
    audio.pause()
    audio.src = audioUrl ?? ''
    audio.playbackRate = playbackSpeedRef.current
    if (audioUrl) setAudioLoading(true)
  }, [audioUrl])

  // Start / stop playback when playing state changes, without reloading the source.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !audioUrl) return
    if (playing) {
      playWhenReadyRef.current = true
      const tryPlay = () => {
        if (!playWhenReadyRef.current) return
        audio.play().catch(console.error)
      }
      if (audio.readyState >= 3) tryPlay()
      else audio.addEventListener('canplaythrough', tryPlay, { once: true })
    } else {
      playWhenReadyRef.current = false
      audio.pause()
    }
  }, [playing, audioUrl])

  const SPEED_PRESETS = [0.75, 1, 1.25, 1.5, 2]

  const PREFETCH_AHEAD = 2
  const PREFETCH_BEHIND = 2
  useEffect(() => {
    if (!audioEnabled || !docId || totalPages < 1 || pages.length === 0) return
    const controller = new AbortController()
    const base = `${BASE}/audio/${docId}`
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
      if (audioEnabled && totalPages > 0 && page >= 1 && page <= totalPages) setPlaying(true)
    },
    [goToPage, totalPages, audioEnabled]
  )

  const onPdfCurrentPageChange = useCallback((pageNum: number) => {
    setViewPage(pageNum)
  }, [])

  const onBlockClick = useCallback((pageNum: number, blockIdx: number) => {
    if (!audioEnabled) return
    const blocksForPage = allPageBlocks[pageNum] ?? []
    const block = blocksForPage[blockIdx]
    if (!block) return
    const totalChars = blocksForPage.reduce((s, b) => s + b.text.length + 1, 0)
    const seekFraction = block.charOffset / Math.max(totalChars, 1)
    if (pageNum !== currentPage) {
      // Store seek target — applied in onLoadedMetadata after new audio src loads
      pendingSeekRef.current = seekFraction
      setCurrentPage(pageNum)
      setViewPage(pageNum)
    } else {
      const dur = audioRef.current?.duration
      if (audioRef.current && isFinite(dur ?? NaN)) {
        audioRef.current.currentTime = seekFraction * (dur as number)
      }
    }
    setPlaying(true)
  }, [audioEnabled, currentPage, allPageBlocks])

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
              if (s.stage === 'done' || s.stage === 'error') { resolve(); return }
            } catch { resolve(); return }
            setTimeout(poll, 800)
          }
          poll()
        })
      } catch (e) { console.error(e) }
    }
    setBatchProgress(null)
    refreshLibrary()
  }, [books, refreshLibrary])


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

  const commitSearch = useCallback((q: string) => {
    if (!q.trim()) { setSearchResults([]); setSearchIdx(0); return }
    const needle = q.trim().toLowerCase()
    const results: { page: number; blockIdx: number }[] = []
    Object.entries(allPageBlocks).forEach(([pageStr, blocks]) => {
      const pageNum = parseInt(pageStr, 10)
      blocks.forEach((b, bi) => {
        if (b.text.toLowerCase().includes(needle)) {
          results.push({ page: pageNum, blockIdx: bi })
        }
      })
    })
    results.sort((a, b) => a.page !== b.page ? a.page - b.page : a.blockIdx - b.blockIdx)
    setSearchResults(results)
    setSearchIdx(0)
    if (results.length > 0) goToPage(results[0].page)
  }, [allPageBlocks, goToPage])

  const searchNav = useCallback((dir: 1 | -1) => {
    if (searchResults.length === 0) return
    const next = (searchIdx + dir + searchResults.length) % searchResults.length
    setSearchIdx(next)
    goToPage(searchResults[next].page)
  }, [searchResults, searchIdx, goToPage])

  // ── Library display helpers ─────────────────────────
  const displayedBooks = useMemo(() => {
    let result = [...books]
    if (librarySearch.trim()) {
      const q = librarySearch.toLowerCase()
      result = result.filter((b) => b.title.toLowerCase().includes(q))
    }
    result.sort((a, b) => {
      if (librarySortBy === 'alpha') {
        const cmp = a.title.localeCompare(b.title)
        return librarySortDir === 'asc' ? cmp : -cmp
      } else {
        const da = a.createdAt ?? ''
        const db = b.createdAt ?? ''
        const cmp = da.localeCompare(db)
        return librarySortDir === 'desc' ? -cmp : cmp
      }
    })
    return result
  }, [books, librarySearch, librarySortBy, librarySortDir])

  const deleteSelected = useCallback(async () => {
    if (selectedBooks.size === 0) return
    if (!confirm(`Remove ${selectedBooks.size} book(s) from your library?`)) return
    for (const id of selectedBooks) {
      try { await api.deleteBook(id) } catch (e) { console.error(e) }
    }
    setSelectedBooks(new Set())
    refreshLibrary()
  }, [selectedBooks, refreshLibrary])

  const toggleSelect = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setSelectedBooks((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])

  // ── Library view ───────────────────────────────────
  if (view === 'library') {
    return (
      <div className="app" data-theme={colorScheme} onClick={() => { setContextMenu(null); setSortDropdownOpen(false) }}>
        {/* Context menu */}
        {contextMenu && (
          <div
            className="lib-context-menu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            onClick={(e) => e.stopPropagation()}
          >
            <button className="lib-context-item" onClick={() => { openBook(contextMenu.docId); setContextMenu(null) }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="3 9 21 9"/></svg>
              Open
            </button>
            <button className="lib-context-item" onClick={() => {
              const b = books.find((x) => x.docId === contextMenu.docId)
              if (b) { setEditingTitleId(b.docId); setEditingTitleValue(b.title) }
              setContextMenu(null)
            }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              Rename
            </button>
            <div className="lib-context-separator" />
            <button className="lib-context-item lib-context-item--danger" onClick={(e) => { deleteBook(contextMenu.docId, e); setContextMenu(null) }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
              Delete
            </button>
          </div>
        )}

        <header className="header lib-header">
          <div className="lib-header-top">
            {/* Logo */}
            <div className="lib-logo">
              <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
                <circle cx="16" cy="16" r="14" fill="var(--accent)" opacity="0.15"/>
                <circle cx="16" cy="16" r="14" stroke="var(--accent)" strokeWidth="1.5"/>
                <polygon points="13,10 23,16 13,22" fill="var(--accent)"/>
              </svg>
              <span className="lib-logo-name">Laurenzo</span>
            </div>

            {/* Right actions */}
            <div className="lib-header-right">
              {selectedBooks.size > 0 && (
                <button type="button" className="lib-btn lib-btn--danger" onClick={deleteSelected}>
                  Delete {selectedBooks.size} selected
                </button>
              )}
              {books.some((b) => !b.processed) && (
                <button type="button" className="lib-btn lib-btn--ghost" disabled={batchProgress !== null} onClick={processBatch}>
                  {batchProgress ? `Processing ${batchProgress.index}/${batchProgress.total}…` : 'Process all'}
                </button>
              )}
              <label className="lib-btn lib-btn--upload">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                Upload PDF
                <input type="file" accept=".pdf" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f) }} />
              </label>
            </div>
          </div>

          {/* Toolbar row */}
          <div className="lib-toolbar">
            <h2 className="lib-title">Library</h2>
            <div className="lib-toolbar-right">
              {/* Search */}
              <div className="lib-search">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input
                  type="text"
                  placeholder="Search PDFs…"
                  value={librarySearch}
                  onChange={(e) => setLibrarySearch(e.target.value)}
                  className="lib-search-input"
                />
                {librarySearch && (
                  <button className="lib-search-clear" onClick={() => setLibrarySearch('')}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                )}
              </div>

              {/* Sort dropdown */}
              <div className="lib-sort-wrap" onClick={(e) => e.stopPropagation()}>
                <button className="lib-sort-btn" onClick={() => setSortDropdownOpen((v) => !v)}>
                  {librarySortBy === 'date' ? (
                    <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points={librarySortDir === 'desc' ? '19 12 12 19 5 12' : '5 12 12 5 19 12'}/></svg> Date Added</>
                  ) : (
                    <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points={librarySortDir === 'asc' ? '19 12 12 19 5 12' : '5 12 12 5 19 12'}/></svg> A–Z</>
                  )}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
                {sortDropdownOpen && (
                  <div className="lib-sort-dropdown">
                    <button className={`lib-sort-option ${librarySortBy === 'date' ? 'active' : ''}`} onClick={() => {
                      if (librarySortBy === 'date') setLibrarySortDir((d) => d === 'desc' ? 'asc' : 'desc')
                      else { setLibrarySortBy('date'); setLibrarySortDir('desc') }
                      setSortDropdownOpen(false)
                    }}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                      Date Added
                      {librarySortBy === 'date' && <span className="lib-sort-hint">{librarySortDir === 'desc' ? 'Newest first' : 'Oldest first'}</span>}
                    </button>
                    <button className={`lib-sort-option ${librarySortBy === 'alpha' ? 'active' : ''}`} onClick={() => {
                      if (librarySortBy === 'alpha') setLibrarySortDir((d) => d === 'asc' ? 'desc' : 'asc')
                      else { setLibrarySortBy('alpha'); setLibrarySortDir('asc') }
                      setSortDropdownOpen(false)
                    }}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7l3-3 3 3"/><path d="M6 4v16"/><path d="M13 7h8"/><path d="M13 12h6"/><path d="M13 17h4"/></svg>
                      Alphabetical
                      {librarySortBy === 'alpha' && <span className="lib-sort-hint">{librarySortDir === 'asc' ? 'A to Z' : 'Z to A'}</span>}
                    </button>
                  </div>
                )}
              </div>

              {/* View mode toggle */}
              <div className="lib-view-toggle">
                <button className={`lib-view-btn ${libraryViewMode === 'grid' ? 'active' : ''}`} onClick={() => setLibraryViewMode('grid')} title="Grid view">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
                </button>
                <button className={`lib-view-btn ${libraryViewMode === 'list' ? 'active' : ''}`} onClick={() => setLibraryViewMode('list')} title="List view">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                </button>
              </div>
            </div>
          </div>
        </header>

        <main className="library-main">
          {batchProgress && (
            <div className="library-batch-banner">
              <span className="library-batch-spinner" />
              Processing {batchProgress.index}/{batchProgress.total} — <em>{batchProgress.current}</em>
            </div>
          )}
          {displayedBooks.length === 0 ? (
            <div className="library-empty-state">
              <div className="library-empty-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
                </svg>
              </div>
              <p className="library-empty-title">{librarySearch ? 'No results found' : 'Your library is empty'}</p>
              <p className="library-empty-sub">{librarySearch ? `No PDFs matching "${librarySearch}"` : 'Upload a PDF to get started'}</p>
            </div>
          ) : libraryViewMode === 'grid' ? (
            <ul className="library-grid">
              {displayedBooks.map((b) => (
                <li key={b.docId} className={`library-card-wrap ${selectedBooks.has(b.docId) ? 'selected' : ''}`}>
                  <div className="library-card">
                    {/* Checkbox */}
                    <button
                      className={`lib-card-checkbox ${selectedBooks.has(b.docId) ? 'checked' : ''}`}
                      onClick={(e) => toggleSelect(b.docId, e)}
                      aria-label="Select"
                    >
                      {selectedBooks.has(b.docId) && (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                      )}
                    </button>

                    {/* 3-dot menu */}
                    <button
                      className="lib-card-menu-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        const rect = e.currentTarget.getBoundingClientRect()
                        setContextMenu({ docId: b.docId, x: rect.right + 8, y: rect.top })
                      }}
                      aria-label="More options"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
                    </button>

                    <button
                      type="button"
                      className="library-card-poster"
                      onClick={() => { if (selectedBooks.size > 0) toggleSelect(b.docId, { stopPropagation: () => {} } as React.MouseEvent); else openBook(b.docId) }}
                    >
                      <img
                        src={`${BASE}/thumbnail/${b.docId}`}
                        alt=""
                        onError={(e) => { e.currentTarget.style.display = 'none' }}
                      />
                      <div className="library-card-overlay">
                        <div className="library-card-play-btn">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
                        </div>
                        {!b.processed && <span className="library-card-badge">Unprocessed</span>}
                      </div>
                    </button>

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
                            if (e.key === 'Escape') { setEditingTitleId(null); setEditingTitleValue('') }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          autoFocus
                          aria-label="Rename title"
                        />
                      ) : (
                        <span className="library-card-title" title={b.title}>
                          {b.title}
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            /* List view */
            <ul className="lib-list">
              {displayedBooks.map((b) => (
                <li key={b.docId} className={`lib-list-row ${selectedBooks.has(b.docId) ? 'selected' : ''}`}>
                  <button
                    className={`lib-card-checkbox ${selectedBooks.has(b.docId) ? 'checked' : ''}`}
                    onClick={(e) => toggleSelect(b.docId, e)}
                    aria-label="Select"
                  >
                    {selectedBooks.has(b.docId) && (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                    )}
                  </button>
                  <div className="lib-list-thumb" onClick={() => openBook(b.docId)}>
                    <img src={`${BASE}/thumbnail/${b.docId}`} alt="" onError={(e) => { e.currentTarget.style.display = 'none' }} />
                    {!b.processed && <span className="lib-list-badge">Unprocessed</span>}
                  </div>
                  <div className="lib-list-info" onClick={() => openBook(b.docId)}>
                    {editingTitleId === b.docId ? (
                      <input
                        type="text"
                        className="library-card-title-input"
                        value={editingTitleValue}
                        onChange={(e) => setEditingTitleValue(e.target.value)}
                        onBlur={() => saveRename(b.docId)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveRename(b.docId)
                          if (e.key === 'Escape') { setEditingTitleId(null); setEditingTitleValue('') }
                        }}
                        onClick={(e) => e.stopPropagation()}
                        autoFocus
                      />
                    ) : (
                      <span className="lib-list-title">{b.title}</span>
                    )}
                    <span className="lib-list-meta">pdf{b.createdAt ? ` · ${new Date(b.createdAt).toLocaleDateString()}` : ''}</span>
                  </div>
                  <div className="lib-list-actions">
                    <button className="lib-list-action-btn" onClick={() => openBook(b.docId)} title="Open">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polygon points="5 3 19 12 5 21"/></svg>
                    </button>
                    <button className="lib-list-action-btn" onClick={() => { setEditingTitleId(b.docId); setEditingTitleValue(b.title) }} title="Rename">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button className="lib-list-action-btn lib-list-action-btn--danger" onClick={(e) => deleteBook(b.docId, e)} title="Delete">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </main>
      </div>
    )
  }

  return (
    <div className="app" data-theme={colorScheme}>
      <header ref={headerRef} className="header header-fixed">
        <div className="header-main-row">
          {/* Left */}
          <div className="header-left">
            <button type="button" className="btn btn-nav btn-back" onClick={() => setView('library')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
              Library
            </button>
            <h1 className="app-wordmark app-wordmark-sm">Laurenzo</h1>
          </div>

          {/* Center: playback */}
          <div className="header-center">
            {audioLoading && (
              <span className="header-loading" role="status" aria-label="Loading audio">
                <span className="header-loading-spinner" />
              </span>
            )}
            <button
              className="btn btn-nav btn-icon"
              disabled={!playing}
              onClick={() => { if (audioRef.current) audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 10) }}
              title="Skip back 10s"
              aria-label="Skip back 10 seconds"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.5"/>
                <text x="8" y="14" fontSize="6" fill="currentColor" stroke="none" fontWeight="bold">10</text>
              </svg>
            </button>
            <button
              className="btn btn-play"
              disabled={totalPages === 0 || getFirstPageWithText() == null}
              onClick={onPlayPause}
            >
              {playing ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
              )}
              {playing ? 'Pause' : 'Play'}
            </button>
            <button
              className="btn btn-nav btn-icon"
              disabled={!playing}
              onClick={() => { if (audioRef.current) audioRef.current.currentTime = audioRef.current.currentTime + 10 }}
              title="Skip forward 10s"
              aria-label="Skip forward 10 seconds"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.49-4.5"/>
                <text x="8" y="14" fontSize="6" fill="currentColor" stroke="none" fontWeight="bold">10</text>
              </svg>
            </button>
            <button
              type="button"
              className={`btn btn-speed${playbackSpeed !== 1 ? ' btn-nav-active' : ' btn-nav'}`}
              title="Playback speed (click to cycle)"
              onClick={() => {
                const idx = SPEED_PRESETS.indexOf(playbackSpeed)
                setPlaybackSpeed(SPEED_PRESETS[(idx + 1) % SPEED_PRESETS.length])
              }}
            >
              {playbackSpeed === 1 ? '1×' : `${playbackSpeed}×`}
            </button>
            <button
              type="button"
              className={`btn btn-nav btn-icon${muted ? ' btn-nav-active' : ''}`}
              onClick={() => setMuted((m) => !m)}
              title={muted ? 'Unmute' : 'Mute'}
              aria-label={muted ? 'Unmute' : 'Mute'}
            >
              {muted ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
              )}
            </button>
            <div className="volume-wrap" title={`Volume: ${Math.round(volume * 100)}%`}>
              <input
                type="range"
                className="volume-slider"
                min={0} max={1} step={0.05}
                value={volume}
                disabled={muted}
                onChange={(e) => setVolume(parseFloat(e.target.value))}
                aria-label="Volume"
              />
            </div>
            <div className="audio-settings-wrap" style={{ position: 'relative' }}>
              <button
                type="button"
                className="btn btn-nav btn-icon"
                title="Settings"
                onClick={() => setAudioSettingsOpen((o) => !o)}
                aria-label="Settings"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
              </button>
              {audioSettingsOpen && (
                <div className="audio-settings-panel">
                  <label className="chat-settings-label">
                    Google API key
                    <input
                      type="password"
                      className="chat-settings-input"
                      placeholder="AIza…"
                      value={googleApiKey}
                      onChange={(e) => setGoogleApiKey(e.target.value)}
                      autoComplete="off"
                    />
                  </label>
                  <label className="chat-settings-label" style={{ marginTop: 10 }}>
                    Voice
                    <select
                      className="chat-settings-input"
                      value={ttsVoice}
                      onChange={(e) => setTtsVoice(e.target.value)}
                    >
                      <optgroup label="── Standard  ($4 / 1M chars) ──">
                        <option value="en-GB-Standard-A">British Female — Standard</option>
                        <option value="en-US-Standard-C">US Female — Standard</option>
                        <option value="en-US-Standard-D">US Male — Standard</option>
                      </optgroup>
                      <optgroup label="── WaveNet  ($16 / 1M chars) ──">
                        <option value="en-GB-Wavenet-B">British Male — WaveNet</option>
                        <option value="en-GB-Wavenet-C">British Female — WaveNet</option>
                        <option value="en-US-Wavenet-H">US Female — WaveNet</option>
                        <option value="en-US-Wavenet-D">US Male — WaveNet</option>
                      </optgroup>
                      <optgroup label="── Neural2  ($16 / 1M chars) ──">
                        <option value="en-GB-Neural2-B">British Male — Neural2</option>
                        <option value="en-GB-Neural2-C">British Female — Neural2</option>
                        <option value="en-US-Neural2-H">US Female — Neural2 ★</option>
                        <option value="en-US-Neural2-D">US Male — Neural2</option>
                      </optgroup>

                      <optgroup label="── Studio  ($160 / 1M chars) ──">
                        <option value="en-GB-Studio-B">British Male — Studio</option>
                        <option value="en-GB-Studio-C">British Female — Studio</option>
                        <option value="en-US-Studio-O">US Female — Studio</option>
                        <option value="en-US-Studio-Q">US Male — Studio</option>
                      </optgroup>
                    </select>
                  </label>
                  <label className="chat-settings-label" style={{ marginTop: 10 }}>
                    TTS speed — {ttsSpeed.toFixed(1)}×
                    <input
                      type="range"
                      className="volume-slider"
                      style={{ width: '100%' }}
                      min={0.5}
                      max={2.0}
                      step={0.1}
                      value={ttsSpeed}
                      onChange={(e) => setTtsSpeed(parseFloat(e.target.value))}
                    />
                  </label>
                  <p className="audio-settings-hint">
                    Voice &amp; speed apply to newly generated pages.
                  </p>
                  <div style={{ marginTop: 12 }}>
                    <div className="theme-picker-label">Colour scheme</div>
                    <div className="theme-swatches">
                      {THEMES.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          className={`theme-swatch${colorScheme === t.id ? ' active' : ''}`}
                          style={{ background: t.color }}
                          onClick={() => setColorScheme(t.id)}
                          title={t.label}
                          aria-label={t.label}
                        />
                      ))}
                    </div>
                  </div>
                  {docId && (
                    <button
                      type="button"
                      className="btn btn-nav"
                      style={{ width: '100%', marginTop: 8 }}
                      onClick={() => {
                        api.clearAudio(docId).catch(console.error)
                        setAudioSettingsOpen(false)
                      }}
                    >
                      Clear audio cache
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Progress strip */}
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

        {/* Error strip */}
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
        onTimeUpdate={(e) => setAudioCurrentTime(e.currentTarget.currentTime)}
        onDurationChange={(e) => setAudioDuration(e.currentTarget.duration)}
        onLoadedMetadata={(e) => {
          const dur = e.currentTarget.duration
          setAudioDuration(dur)
          if (pendingSeekRef.current !== null && isFinite(dur)) {
            e.currentTarget.currentTime = pendingSeekRef.current * dur
            pendingSeekRef.current = null
          }
        }}
      />

      <div
        className="main"
        style={{ paddingTop: headerHeight }}
      >
        <div className="panel pdf-panel">
          <PdfViewer
            key={docId ?? 'none'}
            url={pdfUrl}
            page={currentPage}
            allBlocks={allPageBlocks}
            activeBlock={activeBlock}
            activeWordBbox={activeWordBbox}
            searchResult={searchResults[searchIdx]}
            onPageClick={onPdfPageClick}
            onCurrentPageChange={onPdfCurrentPageChange}
            onNumPages={setPdfNumPages}
            onBlockClick={onBlockClick}
            zoom={pdfZoom}
          />
        </div>
        {/* Floating bottom-right HUD: page nav + zoom + search */}
        <div className="pdf-hud">
          {/* Search row */}
          <div className="pdf-hud-row pdf-hud-search-row">
            <input
              type="text"
              className="pdf-hud-search"
              placeholder="Search…"
              value={searchInput}
              onChange={(e) => {
                setSearchInput(e.target.value)
                if (!e.target.value.trim()) { setSearchResults([]); setSearchIdx(0) }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitSearch(searchInput)
                if (e.key === 'Escape') { setSearchInput(''); setSearchResults([]); setSearchIdx(0); e.currentTarget.blur() }
              }}
              aria-label="Search text"
            />
            <button
              className="pdf-hud-btn pdf-hud-search-go"
              onClick={() => commitSearch(searchInput)}
              title="Search"
              aria-label="Search"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
            </button>
            {searchResults.length > 0 && (
              <>
                <span className="pdf-hud-search-count">{searchIdx + 1}/{searchResults.length}</span>
                <button className="pdf-hud-btn" onClick={() => searchNav(-1)} title="Previous result">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>
                </button>
                <button className="pdf-hud-btn" onClick={() => searchNav(1)} title="Next result">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
                </button>
              </>
            )}
          </div>
          {/* Page + zoom row */}
          <div className="pdf-hud-row">
            <button className="pdf-hud-btn" disabled={!docId || currentPage <= 1} onClick={() => goToPage(currentPage - 1)} title="Previous page">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <span className="pdf-hud-page">
              <input
                type="text"
                inputMode="numeric"
                className="pdf-hud-page-input"
                value={pageInputValue}
                onChange={(e) => setPageInputValue(e.target.value.replace(/\D/g, '').slice(0, 5))}
                onFocus={() => setPageInputFocused(true)}
                onBlur={applyPageInput}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applyPageInput()
                  if (e.key === 'Escape') { setPageInputValue(String(currentPage)); setPageInputFocused(false); e.currentTarget.blur() }
                }}
                aria-label="Page number"
              />
              {totalPages ? <span className="pdf-hud-page-total">/ {totalPages}</span> : ''}
            </span>
            <button className="pdf-hud-btn" disabled={!docId || (totalPages > 0 && currentPage >= totalPages)} onClick={() => goToPage(currentPage + 1)} title="Next page">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
            <div className="pdf-hud-divider" />
            <button className="pdf-hud-btn" onClick={() => setPdfZoom(z => Math.max(0.5, +(z - 0.1).toFixed(1)))} title="Zoom out" disabled={pdfZoom <= 0.5}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <span className="pdf-hud-zoom">{Math.round(pdfZoom * 100)}%</span>
            <button className="pdf-hud-btn" onClick={() => setPdfZoom(z => Math.min(2.0, +(z + 0.1).toFixed(1)))} title="Zoom in" disabled={pdfZoom >= 2.0}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
          </div>
        </div>
        {/* Laurence chat */}
        <button
          type="button"
          className={`chat-trigger chat-trigger-avatar ${chatOpen ? 'chat-trigger-open' : ''}`}
          style={{ top: headerHeight + 16 }}
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
                className={`voice-mode-toggle${voiceMode ? ' active' : ''}`}
                onClick={() => setVoiceMode((v) => !v)}
                title={voiceMode ? 'Switch to text mode' : 'Switch to voice mode'}
                aria-label="Toggle voice mode"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                  <line x1="12" y1="19" x2="12" y2="23"/>
                  <line x1="8" y1="23" x2="16" y2="23"/>
                </svg>
              </button>
              <button
                type="button"
                className="chat-panel-close"
                onClick={() => setChatOpen(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="chat-messages" ref={chatListRef}>
              {chatMessages.length === 0 && !chatLoading && (
                <p className="chat-placeholder">
                  {voiceMode
                    ? 'Tap the mic to speak with Laurence. Uses your Google API key.'
                    : 'Ask about the current page. ' + (pages.length > 0 ? 'Page text is included as context.' : 'Process the PDF to add page context.')}
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
            {voiceMode ? (
              <div className="voice-input-area">
                <button
                  type="button"
                  className={`voice-mic-btn${isRecording ? ' recording' : ''}${laurenceSpeaking ? ' speaking' : ''}`}
                  onClick={startVoiceInput}
                  disabled={chatLoading || laurenceSpeaking}
                  aria-label={isRecording ? 'Stop recording' : 'Start recording'}
                >
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                    <line x1="12" y1="19" x2="12" y2="23"/>
                    <line x1="8" y1="23" x2="16" y2="23"/>
                  </svg>
                  <span className="voice-mic-label">
                    {laurenceSpeaking ? 'Laurence speaking…' : isRecording ? 'Listening…' : 'Tap to speak'}
                  </span>
                </button>
                <div className="chat-input-wrap" style={{ borderTop: 'none', paddingTop: 0 }}>
                  <input
                    type="text"
                    className="chat-input"
                    placeholder="Or type here…"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(undefined, true) } }}
                    disabled={chatLoading}
                  />
                  <button type="button" className="btn btn-accent chat-send" disabled={chatLoading || !chatInput.trim()} onClick={() => sendChat(undefined, true)}>Send</button>
                </div>
              </div>
            ) : (
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
                onClick={() => sendChat()}
              >
                Send
              </button>
            </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
