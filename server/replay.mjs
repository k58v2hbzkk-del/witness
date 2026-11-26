// REPLAY mode: a simulated match with simulated markets, for demos without a live game and for
// tests. Everything it produces is labelled REPLAY and never mixed with real Polymarket data.
//
// The script mirrors what happens in a real match: something happens on the pitch, the people
// watching see it first, and the market catches up a few seconds later.

const TEAM_A = 'Northgate'
const TEAM_B = 'Ashford Rovers'

export const REPLAY_ID = 'replay-northgate-ashford'

function markets() {
  const m = (id, label, sides, p, type) => ({
    id,
    question: label,
    label,
    sides,
    tokens: [`${id}-0`, `${id}-1`],
    bid: [p - 0.01, 1 - p - 0.01],
    ask: [p + 0.01, 1 - p + 0.01],
    mid: [p, 1 - p],
    secondsDelay: 3,
    volume: 0,
    type,
    gameStartTime: null,
    url: null,
  })
  return [
    m('r-a', `${TEAM_A} win`, ['YES', 'NO'], 0.42, 'moneyline'),
    m('r-d', 'Draw', ['YES', 'NO'], 0.29, 'moneyline'),
    m('r-b', `${TEAM_B} win`, ['YES', 'NO'], 0.29, 'moneyline'),
    m('r-o', 'Over 2.5 goals', ['YES', 'NO'], 0.48, 'totals'),
  ]
}

export function replayContext() {
  return {
    id: REPLAY_ID,
    kind: 'replay',
    title: `${TEAM_A} vs ${TEAM_B}`,
    slug: null,
    start: new Date().toISOString(),
    volume24h: 0,
    markets: markets(),
    url: null,
    replay: true,
  }
}

// Fair prices (outcome 0) the market drifts towards after each scripted moment.
const SCRIPT = [
  { at: 0, minute: 1, score: [0, 0], fair: { 'r-a': 0.42, 'r-d': 0.29, 'r-b': 0.29, 'r-o': 0.48 } },
  { at: 40, minute: 23, score: [1, 0], what: `GOAL ${TEAM_A}`, fair: { 'r-a': 0.63, 'r-d': 0.22, 'r-b': 0.15, 'r-o': 0.62 } },
  { at: 95, minute: 51, score: [1, 0], what: `RED CARD ${TEAM_A}`, fair: { 'r-a': 0.52, 'r-d': 0.27, 'r-b': 0.21, 'r-o': 0.6 } },
  { at: 140, minute: 74, score: [1, 1], what: `GOAL ${TEAM_B}`, fair: { 'r-a': 0.31, 'r-d': 0.42, 'r-b': 0.27, 'r-o': 0.81 } },
  { at: 190, minute: 90, score: [1, 1], what: 'FULL TIME', fair: { 'r-a': 0.01, 'r-d': 0.99, 'r-b': 0.01, 'r-o': 0.01 } },
]
const CYCLE = 210 // seconds, then the match restarts
const REACTION = 7 // seconds before the simulated market reacts to what happened

/**
 * Drives quotes and game updates for the replay context.
 * onQuote(token, {bid, ask, at}), onGame(game) — same shapes as the live feeds.
 */
export class Replay {
  constructor(onQuote, onGame, { speed = 1, seed = 7 } = {}) {
    this.onQuote = onQuote
    this.onGame = onGame
    this.speed = speed
    this.t0 = Date.now()
    this.price = Object.fromEntries(markets().map((m) => [m.id, m.mid[0]]))
    this.rand = mulberry(seed)
    this.lastStep = -1
  }
  start(tickMs = 1000) {
    this.timer = setInterval(() => this.tick(), tickMs)
    this.tick()
  }
  stop() {
    clearInterval(this.timer)
  }
  /** Seconds into the current cycle. */
  clock(now = Date.now()) {
    return (((now - this.t0) / 1000) * this.speed) % CYCLE
  }
  tick(now = Date.now()) {
    const s = this.clock(now)
    const step = [...SCRIPT].reverse().find((x) => x.at <= s)
    const idx = SCRIPT.indexOf(step)
    if (idx !== this.lastStep) {
      if (idx < this.lastStep) this.price = Object.fromEntries(markets().map((m) => [m.id, m.mid[0]]))
      this.lastStep = idx
    }
    // the market only "knows" the previous step until REACTION seconds have passed
    const known = s - step.at >= REACTION || idx === 0 ? step : SCRIPT[idx - 1]
    for (const [id, target] of Object.entries(known.fair)) {
      const p = this.price[id]
      const next = p + (target - p) * 0.35 + (this.rand() - 0.5) * 0.008
      this.price[id] = Math.min(0.99, Math.max(0.01, next))
      const mid = this.price[id]
      const spread = 0.01
      this.onQuote(`${id}-0`, { bid: round(mid - spread), ask: round(mid + spread), at: now })
      this.onQuote(`${id}-1`, { bid: round(1 - mid - spread), ask: round(1 - mid + spread), at: now })
    }
    const live = step.at < 190
    const into = s - step.at
    this.onGame({
      gameId: REPLAY_ID,
      leagueAbbreviation: 'REPLAY',
      homeTeam: TEAM_A,
      awayTeam: TEAM_B,
      status: live ? 'InProgress' : 'Final',
      live,
      ended: !live,
      score: `${step.score[0]}-${step.score[1]}`,
      period: step.minute < 46 ? '1H' : live ? '2H' : 'FT',
      elapsed: `${Math.min(90, step.minute + Math.floor(into / 2))}'`,
      what: step.what && into < 12 ? step.what : null,
      replay: true,
    })
  }
}

const round = (x) => Math.round(Math.min(0.99, Math.max(0.01, x)) * 1000) / 1000

function mulberry(a) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const replayTiming = { CYCLE, REACTION, SCRIPT }
