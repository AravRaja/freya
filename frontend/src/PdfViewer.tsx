import React, { useCallback, useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'

if (typeof window !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()
}

const PAGE_LOAD_DELAY_MS = 80

type Props = {
  url: string | null
  page: number
  onPageClick?: (pageNum: number) => void
  onCurrentPageChange?: (pageNum: number) => void
  onNumPages?: (numPages: number) => void
}

const DEFAULT_SCALE = 1.5

export function PdfViewer({ url, page, onPageClick, onCurrentPageChange, onNumPages }: Props) {
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
    <div className="pdf-pages-container" ref={containerRef}>
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
}

const PdfPage = React.forwardRef<HTMLDivElement, PageProps>(function PdfPage(
  { docRef, pageNum, scale, priority, onRequestPriority, onPageClick },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null)
  const delayRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [rendered, setRendered] = useState(false)

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
    </div>
  )
})
