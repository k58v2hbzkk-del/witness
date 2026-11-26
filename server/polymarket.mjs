// Polymarket, read-only: discovery (Gamma REST), live prices (CLOB market channel) and live
// game state (sports channel). No keys, no wallet. Everything here is public data.

const GAMMA = 'https://gamma-api.polymarket.com'
const WS_MARKET = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'
const WS_SPORTS = 'wss://sports-api.polymarket.com/ws'

const parse = (v) => {
  if (Array.isArray(v)) return v
  try {
    return JSON.parse(v ?? '[]')
  } catch {
    return []
  }
}
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v))

async function getJson(path, params = {}) {
  const url = new URL(path, GAMMA)
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v))
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error(`gamma ${r.status} ${url.pathname}`)
  return r.json()
}

/** A two-sided market reduced to what fits on a 576×288 display. */
export function toMarket(m) {
  const outcomes = parse(m.outcomes)
  const tokens = parse(m.clobTokenIds)
  const prices = parse(m.outcomePrices).map(Number)
  if (outcomes.length !== 2 || tokens.length !== 2 || !m.enableOrderBook || m.closed) return null
  const yesNo = /^yes$/i.test(outcomes[0])
  const label = (m.groupItemTitle || m.question || '').trim()
  return {
    id: String(m.id),
    question: m.question,
    label: yesNo ? label : `${outcomes[0]} vs ${outcomes[1]}`,
    sides: yesNo ? ['YES', 'NO'] : outcomes.map((o) => String(o)),
    tokens: tokens.map(String),
    // last known prices; the live feed overwrites these
    bid: [num(m.bestBid), prices[1] != null && num(m.bestAsk) != null ? +(1 - num(m.bestAsk)).toFixed(3) : null],
    ask: [num(m.bestAsk), prices[1] != null && num(m.bestBid) != null ? +(1 - num(m.bestBid)).toFixed(3) : null],
    mid: [prices[0] ?? null, prices[1] ?? null],
    secondsDelay: Number(m.secondsDelay || 0),
    volume: Number(m.volumeNum ?? m.volume ?? 0),
    type: m.sportsMarketType || null,
    gameStartTime: m.gameStartTime || null,
    url: m.slug ? `https://polymarket.com/market/${m.slug}` : null,
  }
}

function rank(markets) {
  // money-line style markets first, then by volume
  const pri = (m) => (m.type === 'moneyline' ? 0 : m.type ? 2 : 1)
  return markets.filter(Boolean).sort((a, b) => pri(a) - pri(b) || b.volume - a.volume)
}

export function toContext(e, kind) {
  const markets = rank((e.markets || []).map(toMarket)).slice(0, 4)
  if (!markets.length) return null
  const start = markets.find((m) => m.gameStartTime)?.gameStartTime || e.startDate
  return {
    id: String(e.id),
    kind,
    title: String(e.title || '').replace(/\s+-\s+More Markets$/i, ''),
    slug: e.slug,
    start,
    volume24h: Number(e.volume24hr || 0),
    markets,
    url: e.slug ? `https://polymarket.com/event/${e.slug}` : null,
  }
}

/** Games that are live or start within the next few hours. */
export async function liveGames() {
  const events = await getJson('/events', { tag_slug: 'sports', active: true, closed: false, limit: 200, order: 'volume24hr', ascending: false })
  const now = Date.now()
  return events
    .map((e) => toContext(e, 'game'))
    .filter(Boolean)
    .filter((c) => {
      const t = Date.parse(c.start || '')
      return Number.isFinite(t) && t < now + 6 * 3600e3 && t > now - 4 * 3600e3
    })
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .slice(0, 30)
}

/** Free-text search: a city ("highest temperature in London"), a show, a speech, a team. */
export async function search(q) {
  const res = await getJson('/public-search', { q, limit_per_type: 10, events_status: 'active' })
  return (res.events || []).map((e) => toContext(e, 'search')).filter(Boolean).slice(0, 10)
}

export async function eventById(id) {
  return toContext(await getJson(`/events/${encodeURIComponent(id)}`), 'event')
}

// ------------------------------------------------------------------ live feeds
/** Keeps best bid/ask for a set of tokens. Calls onQuote(token, {bid, ask, at}). */
export class MarketFeed {
  constructor(onQuote, log = () => {}) {
    this.onQuote = onQuote
    this.log = log
    this.tokens = new Set()
    this.ws = null
    this.backoff = 1000
  }
  watch(tokens) {
    this.tokens = new Set(tokens)
    this.connect(true)
  }
  connect(restart = false) {
    if (restart && this.ws) {
      this.ws.onclose = null
      try {
        this.ws.close()
      } catch {}
      this.ws = null
    }
    if (!this.tokens.size) return
    const ws = new WebSocket(WS_MARKET)
    this.ws = ws
    ws.onopen = () => {
      this.backoff = 1000
      ws.send(JSON.stringify({ assets_ids: [...this.tokens], type: 'market', custom_feature_enabled: true }))
      this.ping = setInterval(() => ws.readyState === 1 && ws.send('PING'), 10_000)
      this.log('market feed connected', this.tokens.size)
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string' || ev.data === 'PONG') return
      let msgs
      try {
        msgs = [].concat(JSON.parse(ev.data))
      } catch {
        return
      }
      for (const m of msgs) this.handle(m)
    }
    ws.onclose = () => {
      clearInterval(this.ping)
      if (this.ws !== ws) return
      setTimeout(() => this.connect(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, 30_000)
    }
    ws.onerror = () => {}
  }
  handle(m) {
    const at = Number(m.timestamp) || Date.now()
    if (m.event_type === 'book') {
      const bid = Math.max(0, ...(m.bids || []).map((l) => Number(l.price)))
      const asks = (m.asks || []).map((l) => Number(l.price))
      this.onQuote(m.asset_id, { bid: bid || null, ask: asks.length ? Math.min(...asks) : null, at })
    } else if (m.event_type === 'best_bid_ask') {
      this.onQuote(m.asset_id, { bid: num(m.best_bid), ask: num(m.best_ask), at })
    } else if (m.event_type === 'price_change') {
      for (const c of m.price_changes || []) this.onQuote(c.asset_id, { bid: num(c.best_bid), ask: num(c.best_ask), at })
    }
  }
}

/** Every live game update Polymarket streams. Calls onGame(game). */
export class SportsFeed {
  constructor(onGame, log = () => {}) {
    this.onGame = onGame
    this.log = log
    this.backoff = 1000
  }
  start() {
    const ws = new WebSocket(WS_SPORTS)
    ws.onopen = () => ((this.backoff = 1000), this.log('sports feed connected'))
    ws.onmessage = (ev) => {
      if (ev.data === 'ping') return ws.send('pong')
      try {
        const g = JSON.parse(ev.data)
        if (g && g.homeTeam) this.onGame(g)
      } catch {}
    }
    ws.onclose = () => {
      setTimeout(() => this.start(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, 30_000)
    }
    ws.onerror = () => {}
  }
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\b(fc|cf|afc|sc|the|club|de|united|city)\b/g, ' ').replace(/\s+/g, ' ').trim()

/** Does this live game belong to this event? Matched on team names in the event title. */
export function gameMatches(game, title) {
  const t = ` ${norm(title)} `
  const hit = (team) => norm(team).split(' ').filter((w) => w.length >= 3).some((w) => t.includes(` ${w} `))
  return hit(game.homeTeam) && hit(game.awayTeam)
}
