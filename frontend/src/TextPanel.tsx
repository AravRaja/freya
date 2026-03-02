import { useEffect, useRef } from 'react'

type PageItem = { page: number; text: string }

type Props = {
  pages: PageItem[]
  currentPage: number
  onPageClick: (page: number) => void
  canPlayPage?: (page: number) => boolean
}

export function TextPanel({ pages, currentPage, onPageClick, canPlayPage }: Props) {
  const activeRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [currentPage])

  if (pages.length === 0) {
    return (
      <div className="text-placeholder">
        Process a PDF to see extracted text here. Click a page block to jump to that page and play (when audio is ready).
      </div>
    )
  }

  return (
    <div className="text-list">
      {pages.map((p) => {
        const isActive = p.page === currentPage
        const canPlay = canPlayPage?.(p.page) ?? true
        return (
          <div
            key={p.page}
            ref={isActive ? activeRef : undefined}
            className={`text-block ${isActive ? 'active' : ''}`}
          >
            <button
              type="button"
              className="text-block-header-btn"
              onClick={() => onPageClick(p.page)}
              aria-current={isActive ? 'true' : undefined}
              aria-label={`Page ${p.page}${canPlay ? ', play' : ', audio not ready'}`}
            >
              Page {p.page}
              {!canPlay && (
                <span className="text-block-badge" aria-hidden="true">Generating…</span>
              )}
            </button>
            <div className="text-block-body text-block-body-selectable">
              {p.text || '(no text)'}
            </div>
          </div>
        )
      })}
    </div>
  )
}
