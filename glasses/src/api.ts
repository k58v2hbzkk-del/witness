// Talks to the Witness server. Same origin when served by it; VITE_API overrides for packaged builds.
export const API = (import.meta.env.VITE_API as string | undefined)?.replace(/\/$/, '') ?? ''

export type MarketView = {
  id: string
  label: string
  sides: string[]
  bid: (number | null)[]
  ask: (number | null)[]
  mid: (number | null)[]
  change60: number
  delay: number
  url: string | null
}
export type Context = { id: string; kind: string; title: string; url: string | null; replay: boolean; markets: MarketView[] }
export type Game = { home: string; away: string; score: string; period: string; elapsed: string; live: boolean; ended: boolean; status: string; replay: boolean }
export type Moment = { id: number; at: number; type: 'watch' | 'score' | 'event' | 'swing'; text: string; marketId: string | null }
export type Edge = { status: 'watching' | 'void' | 'followed' | 'not_followed'; seconds?: number; move?: number; beatDelay?: boolean }
export type Trade = {
  id: string
  marketId: string
  side: number
  label: string
  sideName: string
  usd: number
  tapAt: number
  tapAsk: number
  tapMid: number
  fillAt: number
  delay: number
  replay: boolean
  fillsIn?: number
}
export type Position = Trade & { fillPrice: number; filledAt: number; shares: number; slip: number; edge: Edge; value: number; pnl: number }
export type Closed = Position & { exitAt: number; exitBid: number }
export type State = {
  at: number
  context: Context | null
  game: Game | null
  moments: Moment[]
  focus: number
  stake: number
  stakes: number[]
  cash: number
  equity: number
  pnl: number
  pending: Trade[]
  positions: Position[]
  closed: Closed[]
}
export type Listing = { id: string; title: string; start?: string; kind: string; markets?: number; note?: string }

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(API + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json()
  if (!r.ok) throw new Error(j.error || r.statusText)
  return j as T
}

export const api = {
  contexts: () => call<{ replay: Listing[]; live: Listing[]; telegram: { bot: string; code: string; linked: number } | null }>('/api/contexts'),
  search: (q: string) => call<{ results: Listing[] }>(`/api/search?q=${encodeURIComponent(q)}`),
  watch: (id: string) => call<State>('/api/context', { id }),
  focus: (index: number) => call('/api/focus', { index }),
  stake: (usd: number) => call('/api/stake', { usd }),
  trade: (marketId: string, side: number) => call<Trade>('/api/trade', { marketId, side }),
  cancel: (id: string) => call<Trade>('/api/cancel', { id }),
  close: (id: string) => call<Closed>('/api/close', { id }),
  reset: () => call<State>('/api/reset', {}),
}

export type Push = { type: string; data: any }

/** Live state and events over server-sent events, reconnecting on its own. */
export function connect(onState: (s: State) => void, onPush: (p: Push) => void, onStatus: (ok: boolean) => void) {
  const open = () => {
    const es = new EventSource(API + '/api/stream')
    es.addEventListener('state', (m) => onState(JSON.parse((m as MessageEvent).data)))
    for (const t of ['moment', 'pending', 'filled', 'cancelled', 'unfilled', 'edge', 'closed', 'context']) {
      es.addEventListener(t, (m) => onPush({ type: t, data: JSON.parse((m as MessageEvent).data) }))
    }
    es.onopen = () => onStatus(true)
    es.onerror = () => {
      onStatus(false)
      es.close()
      setTimeout(open, 2000)
    }
  }
  open()
}

export const pct = (p: number | null | undefined) => (p == null ? '--' : `${Math.round(p * 100)}%`)
export const cents = (p: number | null | undefined) => (p == null ? '--' : `${Math.round(p * 100)}¢`)
export const usd = (n: number) => (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2)
export const signed = (n: number) => (n >= 0 ? '+' : '-') + usd(Math.abs(n))
export const pts = (d: number) => `${d >= 0 ? '+' : '−'}${Math.abs(Math.round(d * 100))}`
