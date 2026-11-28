// The desk: what you are watching, the live prices for it, and a paper account that trades it
// under Polymarket's real rules (sports orders wait out the market's secondsDelay).

import { splitScore, gameMatches } from './polymarket.mjs'

export const START_CASH = 1000
export const STAKES = [5, 10, 25, 50]
const EDGE_WINDOW_MS = 60_000 // how long we watch the market after you tap
const EDGE_MOVE = 0.03 // 3 points in your direction counts as "the market followed you"
const SWING = 0.05 // 5 points inside SWING_MS is a moment worth a glance
const SWING_MS = 20_000
const HISTORY_MS = 180_000
const MAX_MOMENTS = 30

const clamp = (x) => Math.min(0.999, Math.max(0.001, x))
const cents = (p) => `${Math.round(p * 100)}¢`

export class Desk {
  constructor({ now = () => Date.now(), emit = () => {}, save = () => {} } = {}) {
    this.now = now
    this.emit = emit // (type, payload) for live clients and Telegram
    this.save = save
    this.context = null
    this.markets = new Map() // market id -> market (context markets + markets with open positions)
    this.byToken = new Map() // token -> {market, side}
    this.quotes = new Map() // token -> {bid, ask, mid, at}
    this.history = new Map() // token -> [{at, mid}]
    this.game = null
    this.gameId = null
    this.moments = []
    this.focus = 0
    this.stake = 10
    this.cash = START_CASH
    this.positions = [] // filled
    this.pending = [] // waiting out the delay
    this.closed = []
    this.seq = 0
  }

  // ------------------------------------------------------------------ context
  setContext(ctx) {
    this.context = ctx
    this.focus = 0
    this.game = null
    this.gameId = null
    this.moments = []
    for (const m of ctx.markets) this.addMarket(m)
    this.moment('watch', `Watching ${ctx.title}`, null)
    this.emit('context', this.publicContext())
    return this.tokens()
  }

  addMarket(m) {
    this.markets.set(m.id, m)
    m.tokens.forEach((t, side) => {
      this.byToken.set(t, { market: m, side })
      if (!this.quotes.has(t) && m.mid[side] != null) {
        this.quotes.set(t, { bid: m.bid[side], ask: m.ask[side], mid: m.mid[side], at: this.now(), stale: true })
      }
    })
  }

  /** Tokens the live feed should follow: the context plus anything you hold. */
  tokens() {
    const ids = new Set(this.context ? this.context.markets.map((m) => m.id) : [])
    for (const p of [...this.positions, ...this.pending]) ids.add(p.marketId)
    return [...ids].flatMap((id) => this.markets.get(id)?.tokens ?? [])
  }

  // ------------------------------------------------------------------ feeds
  quote(token, { bid, ask, at }) {
    const ref = this.byToken.get(token)
    if (!ref) return
    const prev = this.quotes.get(token) || {}
    const r3 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000)
    bid = r3(bid) ?? prev.bid ?? null
    ask = r3(ask) ?? prev.ask ?? null
    if (bid == null && ask == null) return
    const mid = bid != null && ask != null ? (bid + ask) / 2 : (bid ?? ask)
    const t = at || this.now()
    this.quotes.set(token, { bid, ask, mid, at: t })
    const h = this.history.get(token) || []
    h.push({ at: t, mid })
    while (h.length && h[0].at < t - HISTORY_MS) h.shift()
    this.history.set(token, h)
    if (ref.side === 0) this.checkSwing(ref.market, h)
    this.tick()
  }

  game_(g) {
    if (!this.context) return
    // once a live game is matched, stick to its gameId so a similarly named match can't take over
    const mine = g.replay
      ? this.context.replay && g.gameId === this.context.id
      : this.gameId != null
        ? g.gameId === this.gameId
        : gameMatches(g, this.context.title)
    if (!mine) return
    if (!g.replay) this.gameId = g.gameId
    const before = this.game
    const sc = splitScore(g.score, g.period)
    this.game = { home: g.homeTeam, away: g.awayTeam, score: sc.score, period: g.period, elapsed: sc.detail || g.elapsed, live: g.live, ended: g.ended, status: g.status, replay: !!g.replay }
    if (before && before.score !== sc.score) {
      if (sc.score === '0-0') {
        // a replay starting over: anything still open belongs to the last run
        if (g.replay) this.restart()
        this.moment('event', 'KICK-OFF', null)
      }
      else this.moment('score', g.what || `${sc.kind === 'map' ? 'MAP' : 'SCORE'} ${g.homeTeam} ${sc.score} ${g.awayTeam}`, null)
      this.lastWhat = g.what
    } else if (g.what && this.lastWhat !== g.what) {
      this.moment('event', g.what, null)
      this.lastWhat = g.what
    }
    if (!g.what) this.lastWhat = null
    if (before && !before.ended && g.ended && this.lastWhat !== 'FULL TIME') this.moment('event', 'FULL TIME', null)
    this.emit('game', this.game)
  }

  checkSwing(market, h) {
    if (!this.context || !this.context.markets.some((m) => m.id === market.id)) return
    const now = h[h.length - 1]
    const then = h.find((x) => x.at >= now.at - SWING_MS)
    if (!then) return
    const d = now.mid - then.mid
    if (Math.abs(d) < SWING) return
    const last = this.moments.find((m) => m.marketId === market.id && m.type === 'swing')
    if (last && now.at - last.at < SWING_MS) return
    this.moment('swing', `${market.label} ${cents(then.mid)} → ${cents(now.mid)}`, market.id, { from: then.mid, to: now.mid })
  }

  moment(type, text, marketId, extra = {}) {
    const m = { id: ++this.seq, at: this.now(), type, text, marketId, ...extra }
    this.moments.unshift(m)
    this.moments.length = Math.min(this.moments.length, MAX_MOMENTS)
    this.emit('moment', m)
    return m
  }

  // ------------------------------------------------------------------ trading (paper)
  setStake(usd) {
    if (!STAKES.includes(usd)) throw new Error(`stake must be one of ${STAKES.join(', ')}`)
    this.stake = usd
  }

  setFocus(i) {
    const n = this.context?.markets.length || 0
    this.focus = n ? ((i % n) + n) % n : 0
  }

  /**
   * You saw something. Back one side of a market. The order waits out the market's delay
   * (as on Polymarket) and fills at the ask at that moment, not at the price you saw.
   */
  trade(marketId, side) {
    const m = this.markets.get(marketId)
    if (!m) throw new Error('unknown market')
    if (side !== 0 && side !== 1) throw new Error('side must be 0 or 1')
    const q = this.quotes.get(m.tokens[side])
    if (!q || q.ask == null) throw new Error('no price yet')
    if (q.ask >= 0.99) throw new Error('nothing left to win at 99¢')
    if (q.ask <= 0.02) throw new Error('this market is all but settled')
    if (this.game?.ended) throw new Error('the game is over')
    const reserved = this.pending.reduce((s, p) => s + p.usd, 0)
    if (this.cash - reserved < this.stake) throw new Error('not enough paper cash')
    const now = this.now()
    const t = {
      id: `T${++this.seq}`,
      marketId,
      side,
      label: m.label,
      sideName: m.sides[side],
      usd: this.stake,
      tapAt: now,
      tapAsk: q.ask,
      tapMid: q.mid,
      fillAt: now + m.secondsDelay * 1000,
      delay: m.secondsDelay,
      replay: !!this.context?.replay,
    }
    this.pending.push(t)
    this.emit('pending', t)
    this.tick()
    return t
  }

  /** The replay looped back to kick-off: cancel waiting orders and stop scoring old taps. */
  restart() {
    for (const t of this.pending.splice(0)) this.emit('cancelled', t)
    for (const p of this.positions) if (p.edge?.status === 'watching') p.edge = { status: 'void' }
    for (const m of this.context?.markets || []) for (const tk of m.tokens) this.history.set(tk, [])
  }

  cancel(id) {
    const i = this.pending.findIndex((p) => p.id === id)
    if (i < 0) throw new Error('already filled or unknown')
    const [t] = this.pending.splice(i, 1)
    this.emit('cancelled', t)
    return t
  }

  close(id) {
    const i = this.positions.findIndex((p) => p.id === id)
    if (i < 0) throw new Error('unknown position')
    const p = this.positions[i]
    const q = this.quotes.get(this.markets.get(p.marketId).tokens[p.side])
    const bid = q?.bid ?? 0
    const proceeds = p.shares * bid
    this.cash += proceeds
    this.positions.splice(i, 1)
    const done = { ...p, exitAt: this.now(), exitBid: bid, pnl: proceeds - p.usd }
    this.closed.unshift(done)
    this.closed.length = Math.min(this.closed.length, 50)
    this.emit('closed', done)
    this.save()
    return done
  }

  /** Fills orders whose delay is over, and scores how early each tap was. */
  tick() {
    const now = this.now()
    for (const t of [...this.pending]) {
      if (now < t.fillAt) continue
      const q = this.quotes.get(this.markets.get(t.marketId).tokens[t.side])
      this.pending.splice(this.pending.indexOf(t), 1)
      if (!q || q.ask == null || q.ask >= 0.99) {
        this.emit('unfilled', { ...t, reason: 'no seller at a price worth paying' })
        continue
      }
      const price = clamp(q.ask)
      const shares = t.usd / price
      this.cash -= t.usd
      const p = { ...t, fillPrice: price, filledAt: now, shares, slip: price - t.tapAsk, edge: { status: 'watching' } }
      this.positions.push(p)
      this.emit('filled', p)
      this.save()
    }
    for (const p of this.positions) this.scoreEdge(p, now)
  }

  /**
   * Edge: did the market move your way after you tapped, and how many seconds later?
   * "Followed" = the mid moved EDGE_MOVE in your direction within EDGE_WINDOW_MS of the tap.
   */
  scoreEdge(p, now) {
    if (p.edge.status !== 'watching') return
    const h = this.history.get(this.markets.get(p.marketId).tokens[p.side]) || []
    const after = h.filter((x) => x.at >= p.tapAt)
    const hit = after.find((x) => x.mid - p.tapMid >= EDGE_MOVE)
    if (hit) {
      p.edge = { status: 'followed', seconds: Math.round((hit.at - p.tapAt) / 1000), move: hit.mid - p.tapMid, beatDelay: hit.at - p.tapAt > p.delay * 1000 }
      this.emit('edge', p)
      return
    }
    if (now - p.tapAt >= EDGE_WINDOW_MS) {
      const last = after[after.length - 1]
      p.edge = { status: 'not_followed', move: last ? last.mid - p.tapMid : 0 }
      this.emit('edge', p)
    }
  }

  // ------------------------------------------------------------------ views
  value(p) {
    const q = this.quotes.get(this.markets.get(p.marketId).tokens[p.side])
    return p.shares * (q?.bid ?? 0)
  }

  publicContext() {
    if (!this.context) return null
    const c = this.context
    return {
      id: c.id,
      kind: c.kind,
      title: c.title,
      url: c.url,
      replay: !!c.replay,
      markets: c.markets.map((m) => this.marketView(m)),
    }
  }

  marketView(m) {
    const q = m.tokens.map((t) => this.quotes.get(t) || {})
    const h = this.history.get(m.tokens[0]) || []
    const ref = h.find((x) => x.at >= (h[h.length - 1]?.at ?? 0) - 60_000)
    return {
      id: m.id,
      label: m.label,
      sides: m.sides,
      bid: q.map((x) => x.bid ?? null),
      ask: q.map((x) => x.ask ?? null),
      mid: q.map((x) => x.mid ?? null),
      change60: ref && q[0].mid != null ? q[0].mid - ref.mid : 0,
      delay: m.secondsDelay,
      url: m.url,
    }
  }

  snapshot() {
    const open = this.positions.map((p) => {
      const value = this.value(p)
      return { ...p, value, pnl: value - p.usd }
    })
    const invested = open.reduce((s, p) => s + p.value, 0)
    return {
      at: this.now(),
      context: this.publicContext(),
      game: this.game,
      moments: this.moments.slice(0, 12),
      focus: this.focus,
      stake: this.stake,
      stakes: STAKES,
      cash: this.cash,
      equity: this.cash + invested,
      pnl: this.cash + invested - START_CASH,
      pending: this.pending.map((t) => ({ ...t, fillsIn: Math.max(0, Math.ceil((t.fillAt - this.now()) / 1000)) })),
      positions: open,
      closed: this.closed.slice(0, 10),
    }
  }

  // ------------------------------------------------------------------ persistence
  toJSON() {
    return { cash: this.cash, stake: this.stake, positions: this.positions, closed: this.closed, markets: [...this.markets.values()].filter((m) => this.positions.some((p) => p.marketId === m.id)), seq: this.seq }
  }
  restore(s) {
    if (!s) return
    for (const m of s.markets || []) this.addMarket(m)
    this.cash = s.cash ?? START_CASH
    this.stake = s.stake ?? 10
    this.positions = (s.positions || []).filter((p) => this.markets.has(p.marketId))
    this.closed = s.closed || []
    this.seq = s.seq || 0
  }
  reset() {
    this.cash = START_CASH
    this.positions = []
    this.pending = []
    this.closed = []
    this.save()
  }
}
