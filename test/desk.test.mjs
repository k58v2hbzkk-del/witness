import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Desk, START_CASH } from '../server/desk.mjs'
import { replayContext, Replay } from '../server/replay.mjs'
import { gameMatches, toMarket } from '../server/polymarket.mjs'

function setup() {
  let t = 1_000_000
  const events = []
  const desk = new Desk({ now: () => t, emit: (type, p) => events.push({ type, p }) })
  desk.setContext(replayContext())
  const m = desk.context.markets[0]
  const q = (mid, at = t) => {
    desk.quote(m.tokens[0], { bid: mid - 0.01, ask: mid + 0.01, at })
    desk.quote(m.tokens[1], { bid: 1 - mid - 0.01, ask: 1 - mid + 0.01, at })
  }
  return { desk, m, q, events, clock: { get: () => t, add: (ms) => (t += ms) } }
}

test('order waits out the delay and fills at the ask then, not at the tap', () => {
  const { desk, m, q, clock } = setup()
  q(0.42)
  const tr = desk.trade(m.id, 0)
  assert.equal(tr.tapAsk, 0.43)
  assert.equal(desk.positions.length, 0)
  clock.add(2000)
  q(0.55) // market jumps inside the delay
  assert.equal(desk.positions.length, 0)
  clock.add(1000)
  q(0.56)
  assert.equal(desk.positions.length, 1)
  assert.equal(desk.positions[0].fillPrice, 0.57)
  assert.ok(desk.positions[0].slip > 0.13)
  assert.equal(desk.cash, START_CASH - 10)
})

test('cancel during the delay', () => {
  const { desk, m, q, clock } = setup()
  q(0.42)
  const tr = desk.trade(m.id, 1)
  desk.cancel(tr.id)
  clock.add(5000)
  q(0.42)
  assert.equal(desk.positions.length, 0)
  assert.equal(desk.cash, START_CASH)
  assert.throws(() => desk.cancel(tr.id))
})

test('edge: market followed you after the delay', () => {
  const { desk, m, q, clock, events } = setup()
  q(0.42)
  desk.trade(m.id, 0)
  for (let s = 1; s <= 12; s++) {
    clock.add(1000)
    q(s < 8 ? 0.42 : 0.5)
  }
  const p = desk.positions[0]
  assert.equal(p.edge.status, 'followed')
  assert.equal(p.edge.seconds, 8)
  assert.equal(p.edge.beatDelay, true)
  assert.ok(events.some((e) => e.type === 'edge'))
})

test('edge: market did not follow within the window', () => {
  const { desk, m, q, clock } = setup()
  q(0.42)
  desk.trade(m.id, 0)
  for (let s = 1; s <= 61; s++) {
    clock.add(1000)
    q(0.41)
  }
  assert.equal(desk.positions[0].edge.status, 'not_followed')
})

test('close sells at the bid and books pnl', () => {
  const { desk, m, q, clock } = setup()
  q(0.4)
  desk.trade(m.id, 0)
  clock.add(3000)
  q(0.4) // fills at 0.41
  clock.add(1000)
  q(0.6) // bid 0.59
  const done = desk.close(desk.positions[0].id)
  assert.ok(Math.abs(done.pnl - (10 / 0.41) * 0.59 + 10) < 1e-9)
  assert.ok(desk.cash > START_CASH)
})

test('cannot spend more paper cash than you have', () => {
  const { desk, m, q } = setup()
  q(0.42)
  desk.setStake(50)
  for (let i = 0; i < 20; i++) desk.trade(m.id, 0)
  assert.throws(() => desk.trade(m.id, 0), /not enough/)
  assert.throws(() => desk.setStake(7))
})

test('no trade at 99 cents or without a price', () => {
  const { desk, m, q } = setup()
  assert.throws(() => desk.trade('nope', 0), /unknown/)
  q(0.985)
  assert.throws(() => desk.trade(m.id, 0), /99/)
})

test('swing moment fires once per window', () => {
  const { desk, q, clock } = setup()
  q(0.4)
  clock.add(5000)
  q(0.47)
  clock.add(1000)
  q(0.5)
  const swings = desk.moments.filter((x) => x.type === 'swing')
  assert.equal(swings.length, 1)
})

test('score change becomes a moment', () => {
  const { desk } = setup()
  const g = { gameId: desk.context.id, homeTeam: 'Northgate', awayTeam: 'Ashford Rovers', score: '0-0', replay: true }
  desk.game_(g)
  desk.game_({ ...g, score: '1-0', what: 'GOAL Northgate' })
  assert.equal(desk.moments[0].text, 'GOAL Northgate')
})

test('replay: market reacts only after the reaction delay', () => {
  const quotes = {}
  let t = 0
  const r = new Replay((tok, q) => (quotes[tok] = q), () => {})
  r.t0 = 0
  for (t = 0; t <= 40_000; t += 1000) r.tick(t)
  const atGoal = quotes['r-a-0'].bid
  for (; t <= 52_000; t += 1000) r.tick(t)
  assert.ok(quotes['r-a-0'].bid - atGoal > 0.1, 'Northgate odds jump after the goal is "known"')
})

test('team matching against event titles', () => {
  assert.ok(gameMatches({ homeTeam: 'Arsenal FC', awayTeam: 'Chelsea' }, 'Arsenal vs. Chelsea'))
  assert.ok(gameMatches({ homeTeam: 'Los Angeles Lakers', awayTeam: 'Boston Celtics' }, 'Lakers vs. Celtics'))
  assert.ok(!gameMatches({ homeTeam: 'Arsenal', awayTeam: 'Chelsea' }, 'Liverpool vs. Everton'))
})

test('gamma market parsing', () => {
  const m = toMarket({ id: 1, question: 'Will Arsenal win?', groupItemTitle: 'Arsenal', outcomes: '["Yes","No"]', outcomePrices: '["0.54","0.46"]', clobTokenIds: '["11","22"]', enableOrderBook: true, bestBid: 0.53, bestAsk: 0.55, secondsDelay: 3, sportsMarketType: 'moneyline' })
  assert.equal(m.label, 'Arsenal')
  assert.deepEqual(m.sides, ['YES', 'NO'])
  assert.equal(m.secondsDelay, 3)
  assert.equal(m.ask[1], 0.47)
  const t = toMarket({ id: 2, question: 'Lakers vs Celtics', outcomes: '["Lakers","Celtics"]', outcomePrices: '["0.6","0.4"]', clobTokenIds: '["1","2"]', enableOrderBook: true })
  assert.deepEqual(t.sides, ['Lakers', 'Celtics'])
  assert.equal(toMarket({ id: 3, outcomes: '["A","B","C"]', clobTokenIds: '["1","2","3"]', enableOrderBook: true }), null)
})

test('a game event is announced once', () => {
  const { desk } = setup()
  const g = { gameId: desk.context.id, homeTeam: 'Northgate', awayTeam: 'Ashford Rovers', score: '1-0', replay: true }
  desk.game_(g)
  for (let i = 0; i < 5; i++) desk.game_({ ...g, what: 'RED CARD Northgate' })
  desk.moment('swing', 'x', null)
  desk.game_({ ...g, what: 'RED CARD Northgate' })
  assert.equal(desk.moments.filter((m) => m.text === 'RED CARD Northgate').length, 1)
})

test('market labels are specific and decided markets are dropped', async () => {
  const { toMarket } = await import('../server/polymarket.mjs')
  const base = { outcomes: '["Heroic","FaZe"]', clobTokenIds: '["1","2"]', enableOrderBook: true, outcomePrices: '["0.6","0.4"]' }
  assert.equal(toMarket({ ...base, id: 1, question: 'Counter-Strike: Heroic vs FaZe - Map 1 Winner' }).label, 'Map 1 Winner')
  assert.equal(toMarket({ ...base, id: 2, question: 'Counter-Strike: Heroic vs FaZe (BO3)', sportsMarketType: 'moneyline' }).label, 'Match winner')
  assert.equal(toMarket({ ...base, id: 3, outcomes: '["Over","Under"]', question: 'Games Total: O/U 2.5' }).label, 'Total O/U 2.5')
  assert.equal(toMarket({ ...base, id: 4, outcomePrices: '["1","0"]', question: 'x' }), null)
})

test('handicaps are named, duplicates and thin markets dropped', async () => {
  const { toMarket, toContext } = await import('../server/polymarket.mjs')
  const base = { outcomes: '["PVISION","Lynn Vision"]', clobTokenIds: '["1","2"]', enableOrderBook: true, outcomePrices: '["0.6","0.4"]' }
  assert.equal(toMarket({ ...base, id: 1, question: 'Map Handicap: PVISION (-1.5) vs Lynn Vision (+1.5)' }).label, 'Handicap PVISION -1.5')
  assert.equal(toMarket({ ...base, id: 2, question: 'x', bestBid: '0.3', bestAsk: '0.6' }), null)
  const c = toContext({ id: 9, title: 'T', markets: [
    { ...base, id: 3, question: 'A vs B', groupItemTitle: 'Match Winner', sportsMarketType: 'moneyline', volumeNum: 5 },
    { ...base, id: 4, question: 'A vs B', sportsMarketType: 'moneyline', volumeNum: 1 },
    { ...base, id: 5, question: 'A vs B - Map 1 Winner' },
  ] }, 'game')
  assert.deepEqual(c.markets.map((m) => m.label), ['Match Winner', 'Map 1 Winner'])
})
