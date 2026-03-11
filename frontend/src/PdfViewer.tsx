import React, { useCallback, useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'

if (typeof window !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()
}

const PAGE_LOAD_DELAY_MS = 80

type WordItem  = { text: string; bbox: [number,number,number,number]; charOffset: number }
type LineItem  = { bbox: [number,number,number,number] }
type BlockItem = {
  text: string
  charOffset: number
  lines: LineItem[]
  words: WordItem[]
  /** legacy fallback for old pages.json without lines/words */
  bbox?: [number,number,number,number]
}

type Props = {
  url: string | null
  page: number
  allBlocks?: Record<number, BlockItem[]>
  activeBlock?: number
  activeWordBbox?: [number,number,number,number] | null
  searchResult?: { page: number; blockIdx: number }
  onPageClick?: (pageNum: number) => void
  onCurrentPageChange?: (pageNum: number) => void
  onNumPages?: (numPages: number) => void
  onBlockClick?: (pageNum: number, blockIdx: number) => void
  zoom?: number
}

const DEFAULT_SCALE = 2.0

export function PdfViewer({ url, page, allBlocks, activeBlock, activeWordBbox, searchResult, onPageClick, onCurrentPageChange, onNumPages, onBlockClick, zoom }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const pageRefsRef = useRef<(HTMLDivElement | null)[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [priorityPage, setPriorityPage] = useState<number | null>(null)
  const docRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null)
  const scrollRAF = useRef<number | null>(null)

  useEffect(() => {
    if (!url) {
      docRef.current = null
      setNumPages(0)
      onNumPages?.(0)
      setError(null)
      setLoading(false)
      setPriorityPage(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setNumPages(0)
    setPriorityPage(null)

    const load = async () => {
      try {
        // Pass URL directly so PDF.js uses HTTP range requests (206 Partial Content)
        // instead of downloading the entire file before rendering page 1.
        const doc = await pdfjsLib.getDocument({ url, rangeChunkSize: 65536 }).promise
        if (cancelled) {
          doc.destroy()
          return
        }
        docRef.current = doc
        const n = doc.numPages
        setNumPages(n)
        onNumPages?.(n)
      } catch (e) {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : String(e)
        if (msg === 'Transport destroyed' || msg.includes('destroyed')) {
          return
        }
        setError(e instanceof Error ? e.message : 'Failed to load PDF')
        console.error(e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()

    return () => {
      cancelled = true
      docRef.current?.destroy()
      docRef.current = null
    }
  }, [url])

  useEffect(() => {
    if (page < 1 || !containerRef.current) return
    const idx = page - 1
    const el = pageRefsRef.current[idx]
    if (el) {
      el.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
  }, [page])

  const updatePageFromScroll = useCallback(() => {
    const container = containerRef.current
    if (!container || !onCurrentPageChange || numPages === 0) return
    const cr = container.getBoundingClientRect()
    const tolerance = 80
    for (let i = numPages - 1; i >= 0; i--) {
      const el = pageRefsRef.current[i]
      if (!el) continue
      const er = el.getBoundingClientRect()
      if (er.top <= cr.top + tolerance) {
        const pageNum = i + 1
        if (pageNum !== page) onCurrentPageChange(pageNum)
        return
      }
    }
    if (1 !== page) onCurrentPageChange(1)
  }, [numPages, page, onCurrentPageChange])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !onCurrentPageChange) return
    const onScroll = () => {
      if (scrollRAF.current != null) cancelAnimationFrame(scrollRAF.current)
      scrollRAF.current = requestAnimationFrame(() => {
        scrollRAF.current = null
        updatePageFromScroll()
      })
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', onScroll)
      if (scrollRAF.current != null) cancelAnimationFrame(scrollRAF.current)
    }
  }, [onCurrentPageChange, updatePageFromScroll])

  const onRequestPriority = useCallback((pageNum: number) => {
    setPriorityPage(pageNum)
  }, [])

  if (!url) {
    return (
      <div className="pdf-placeholder">
        Upload and process a PDF to view it here.
      </div>
    )
  }
  if (loading || (numPages === 0 && !error)) {
    return <div className="pdf-placeholder">Loading PDF…</div>
  }
  if (error) {
    return (
      <div className="pdf-placeholder pdf-error">
        {error}
      </div>
    )
  }
  return (
    <div className="pdf-pages-container" ref={containerRef} style={{ zoom: zoom ?? 1 }}>
      {Array.from({ length: numPages }, (_, i) => (
        <PdfPage
          key={i}
          docRef={docRef}
          pageNum={i + 1}
          scale={DEFAULT_SCALE}
          ref={(el) => { pageRefsRef.current[i] = el }}
          priority={priorityPage === i + 1}
          onRequestPriority={onRequestPriority}
          onPageClick={onPageClick}
          blocks={allBlocks?.[i + 1]}
          activeBlock={i + 1 === page ? activeBlock : undefined}
          activeWordBbox={i + 1 === page ? activeWordBbox : undefined}
          searchBlock={searchResult?.page === i + 1 ? searchResult.blockIdx : undefined}
          onBlockClick={onBlockClick ? (idx) => onBlockClick(i + 1, idx) : undefined}
        />
      ))}
    </div>
  )
}

type PageProps = {
  docRef: React.MutableRefObject<pdfjsLib.PDFDocumentProxy | null>
  pageNum: number
  scale: number
  priority: boolean
  onRequestPriority: (pageNum: number) => void
  onPageClick?: (pageNum: number) => void
  blocks?: BlockItem[]
  activeBlock?: number
  activeWordBbox?: [number,number,number,number] | null
  searchBlock?: number
  onBlockClick?: (idx: number) => void
}

const PdfPage = React.forwardRef<HTMLDivElement, PageProps>(function PdfPage(
  { docRef, pageNum, scale, priority, onRequestPriority, onPageClick, blocks, activeBlock, activeWordBbox, searchBlock, onBlockClick },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null)
  const delayRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [rendered, setRendered] = useState(false)
  const [hoveredBlock, setHoveredBlock] = useState<number | null>(null)

  useEffect(() => {
    const doc = docRef.current
    const canvas = canvasRef.current
    if (!doc || !canvas) return

    let cancelled = false

    const startRender = () => {
      if (cancelled) return
      doc.getPage(pageNum)
        .then((pdfPage) => {
          if (cancelled) {
            pdfPage.cleanup()
            return
          }
          if (renderTaskRef.current) {
            renderTaskRef.current.cancel()
            renderTaskRef.current = null
          }
          const viewport = pdfPage.getViewport({ scale })
          canvas.width = viewport.width
          canvas.height = viewport.height
          const ctx = canvas.getContext('2d')
          if (!ctx) return
          const task = pdfPage.render({ canvasContext: ctx, viewport })
          renderTaskRef.current = task
          task.promise
            .then(() => {
              if (!cancelled) setRendered(true)
            })
            .catch((err) => {
              if (!cancelled && err?.name !== 'RenderingCancelledException') console.error(err)
            })
            .finally(() => {
              renderTaskRef.current = null
              pdfPage.cleanup()
            })
        })
        .catch((err) => {
          if (cancelled) return
          if (err?.message === 'Transport destroyed' || err?.message?.includes('destroyed')) return
          console.error(err)
        })
    }

    const delayMs = priority ? 0 : pageNum * PAGE_LOAD_DELAY_MS
    if (delayMs === 0) {
      startRender()
    } else {
      delayRef.current = setTimeout(startRender, delayMs)
    }

    return () => {
      cancelled = true
      if (delayRef.current) {
        clearTimeout(delayRef.current)
        delayRef.current = null
      }
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel()
        renderTaskRef.current = null
      }
    }
  }, [docRef, pageNum, scale, priority])

  return (
    <div
      ref={ref}
      className="pdf-page-wrap"
      onClick={rendered ? () => onPageClick?.(pageNum) : undefined}
      role={rendered && onPageClick ? 'button' : undefined}
      title={rendered && onPageClick ? `Read page ${pageNum}` : undefined}
      style={rendered && onPageClick ? { cursor: 'pointer' } : undefined}
    >
      {!rendered && (
        <button
          type="button"
          className="pdf-page-placeholder pdf-page-placeholder-btn"
          onClick={() => onRequestPriority(pageNum)}
          title="Load this page first"
        >
          <span className="pdf-page-placeholder-text">Page {pageNum}…</span>
          <span className="pdf-page-placeholder-hint">Click to load</span>
        </button>
      )}
      <canvas ref={canvasRef} />
      {blocks && blocks.length > 0 && (
        <div className="pdf-block-overlay">
          {blocks.map((b, idx) => {
            // Skip blocks with no text or no geometry
            if (!b.text?.trim()) return null
            const rects: [number,number,number,number][] =
              b.lines?.length
                ? b.lines.map(l => l.bbox)
                : b.bbox ? [b.bbox] : []
            if (rects.length === 0) return null
            const isActive  = idx === activeBlock
            const isSearch  = idx === searchBlock
            const isHovered = idx === hoveredBlock
            const total = rects.length
            const R = '8px'
            const leftMost  = Math.min(...rects.map(r => r[0]))
            const rightMost = Math.max(...rects.map(r => r[2]))
            const effL = (i: number) => i === 0         ? rects[i][0] : leftMost
            const effR = (i: number) => i === total - 1 ? rects[i][2] : rightMost
            return rects.map((r, ri) => {
              const first = ri === 0
              const last  = ri === total - 1
              const left  = effL(ri)
              const right = effR(ri)
              const tlRound = first || effL(ri) !== effL(ri - 1)
              const trRound = first || effR(ri) !== effR(ri - 1)
              const brRound = last  || effR(ri) !== effR(ri + 1)
              const blRound = last  || effL(ri) !== effL(ri + 1)
              const borderRadius = `${tlRound?R:'0'} ${trRound?R:'0'} ${brRound?R:'0'} ${blRound?R:'0'}`
              return (
                <div
                  key={`${idx}-${ri}`}
                  className={`pdf-block-highlight${isActive ? ' active' : ''}${isSearch ? ' search' : ''}${isHovered ? ' hovered' : ''}`}
                  style={{
                    left:   `calc(${left * 100}% - 6px)`,
                    top:    `${r[1] * 100}%`,
                    width:  `calc(${(right - left) * 100}% + 12px)`,
                    height: last
                      ? `calc(${(r[3] - r[1]) * 100}% + 4px)`
                      : `${(rects[ri + 1][1] - r[1]) * 100}%`,
                    borderRadius,
                  }}
                  onMouseEnter={() => setHoveredBlock(idx)}
                  onMouseLeave={() => setHoveredBlock(null)}
                  onClick={(e) => { e.stopPropagation(); onBlockClick?.(idx) }}
                  title={first ? b.text.slice(0, 80) : undefined}
                />
              )
            })
          })}
          {activeWordBbox && (
            <div
              className="pdf-word-highlight"
              style={{
                left:   `calc(${activeWordBbox[0] * 100}% - 6px)`,
                top:    `calc(${activeWordBbox[1] * 100}% - 3px)`,
                width:  `calc(${(activeWordBbox[2] - activeWordBbox[0]) * 100}% + 12px)`,
                height: `calc(${(activeWordBbox[3] - activeWordBbox[1]) * 100}% + 6px)`,
              }}
            />
          )}
        </div>
      )}
    </div>
  )
})
