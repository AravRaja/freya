export const BASE = (import.meta.env.VITE_API_BASE as string) || '/api'

function checkResponse(r: Response, body: string): never | void {
  if (!r.ok) throw new Error(body || r.statusText)
}

async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, options)
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).toLowerCase()
    const isNetworkError = e instanceof TypeError || msg.includes('fetch') || msg.includes('connection') || msg.includes('econnrefused')
    throw new Error(isNetworkError
      ? 'Backend not reachable. Start it with: cd backend && uvicorn main:app --reload --port 8000'
      : (e instanceof Error ? e.message : 'Network error'))
  }
}

export const api = {
  async upload(file: File): Promise<{ docId: string; duplicate?: boolean }> {
    const form = new FormData()
    form.append('file', file)
    const r = await apiFetch(`${BASE}/upload`, { method: 'POST', body: form })
    const text = await r.text()
    checkResponse(r, text)
    return text ? JSON.parse(text) : {}
  },

  async process(docId: string): Promise<{ status: string; docId: string }> {
    const r = await apiFetch(`${BASE}/process/${docId}`, { method: 'POST' })
    const text = await r.text()
    checkResponse(r, text)
    return text ? JSON.parse(text) : {}
  },

  async status(docId: string): Promise<{
    donePages: number
    totalPages: number
    stage: string
    error?: string
    readyAudioPages?: number[]
  }> {
    const r = await apiFetch(`${BASE}/status/${docId}`)
    const text = await r.text()
    checkResponse(r, text)
    return text ? JSON.parse(text) : {}
  },

  async library(): Promise<{ books: { docId: string; title: string; processed: boolean }[] }> {
    const r = await apiFetch(`${BASE}/library`)
    const text = await r.text()
    checkResponse(r, text)
    return text ? JSON.parse(text) : { books: [] }
  },

  async renameBook(docId: string, title: string): Promise<{ docId: string; title: string }> {
    const r = await apiFetch(`${BASE}/library/${docId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    const text = await r.text()
    checkResponse(r, text)
    return text ? JSON.parse(text) : { docId, title }
  },

  async deleteBook(docId: string): Promise<{ deleted: string }> {
    const r = await apiFetch(`${BASE}/library/${docId}`, { method: 'DELETE' })
    const text = await r.text()
    checkResponse(r, text)
    return text ? JSON.parse(text) : {}
  },

  async pages(docId: string): Promise<{ pages: { page: number; text: string }[] }> {
    const r = await apiFetch(`${BASE}/pages/${docId}`)
    const text = await r.text()
    checkResponse(r, text)
    return text ? JSON.parse(text) : {}
  },

  async chat(params: {
    openai_api_key: string
    messages: { role: string; content: string }[]
    context?: string
  }): Promise<{ content: string }> {
    const r = await apiFetch(`${BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    const text = await r.text()
    checkResponse(r, text)
    return text ? JSON.parse(text) : { content: '' }
  },

  async tts(params: {
    openai_api_key: string
    text: string
    voice?: string
  }): Promise<Blob> {
    const r = await apiFetch(`${BASE}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        openai_api_key: params.openai_api_key,
        text: params.text,
        voice: params.voice ?? 'shimmer',
      }),
    })
    if (!r.ok) {
      const text = await r.text()
      checkResponse(r, text)
    }
    return r.blob()
  },
}
