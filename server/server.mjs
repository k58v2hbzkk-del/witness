import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { Desk } from './desk.mjs'
import { MarketFeed, SportsFeed, liveGames, search, eventById } from './polymarket.mjs'
import { Replay, replayContext, REPLAY_ID } from './replay.mjs'
import { Telegram } from './telegram.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data')
const FILE = path.join(DATA, 'witness.json')
const OFFLINE = process.env.OFFLINE === '1' // no Polymarket connections (tests, sandboxes)
fs.mkdirSync(DATA, { recursive: true })

const log = (...a) => console.log(new Date().toISOString(), ...a)
const clients = new Set()
const send = (type, payload) => {
  const line = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
  for (const c of clients) c.write(line)
}

let saved = {}
try {
  saved = JSON.parse(fs.readFileSync(FILE, 'utf8'))
} catch {}

let tg = null
const persist = () => {
  try {
    fs.writeFileSync(FILE, JSON.stringify({ desk: desk.toJSON(), chats: tg ? [...tg.chats] : [] }))
  } catch (e) {
    log('save failed', e.message)
  }
}

const usd = (x) => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`
const c = (p) => `${Math.round(p * 100)}¢`

const desk = new Desk({
  emit: (type, p) => {
    send(type, p)
    if (!tg) return
    if (type === 'filled') tg.broadcast(`▶ ${p.replay ? '[REPLAY] ' : ''}${p.sideName} · ${p.label}\n${usd(p.usd)} filled at ${c(p.fillPrice)} after the ${p.delay}s delay (you tapped at ${c(p.tapAsk)}).`)
    if (type === 'edge' && p.edge.status === 'followed') tg.broadcast(`⚡ The market followed you: ${p.label} ${p.sideName} moved ${Math.round(p.edge.move * 100)} pts ${p.edge.seconds}s after your tap.`)
    if (type === 'edge' && p.edge.status === 'not_followed') tg.broadcast(`○ ${p.label} ${p.sideName}: the market did not follow within 60s.`)
    if (type === 'closed') tg.broadcast(`■ Closed ${p.label} ${p.sideName} at ${c(p.exitBid)} · ${p.pnl >= 0 ? '+' : ''}${usd(p.pnl)}`)
  },
  save: () => persist(),
})
desk.restore(saved.desk)

// ------------------------------------------------------------------ feeds
const market = new MarketFeed((tok, q) => desk.quote(tok, q), log)
let replay = null
function watch() {
  const tokens = desk.tokens()
  const live = tokens.filter((t) => !t.startsWith('r-'))
  if (!OFFLINE) market.watch(live)
  const wantReplay = desk.context?.replay || tokens.some((t) => t.startsWith('r-'))
  if (wantReplay && !replay) {
    replay = new Replay((tok, q) => desk.quote(tok, q), (g) => desk.game_(g))
    replay.start()
  } else if (!wantReplay && replay) {
    replay.stop()
    replay = null
  }
}
if (!OFFLINE) new SportsFeed((g) => desk.game_(g), log).start()
setInterval(() => desk.tick(), 500)
setInterval(() => send('state', desk.snapshot()), 1000)

desk.setContext(replayContext())
watch()

if (process.env.TELEGRAM_BOT_TOKEN && !OFFLINE) {
  tg = new Telegram(process.env.TELEGRAM_BOT_TOKEN, {
    log,
    chats: saved.chats || [],
    onCommand: (cmd) => {
      if (cmd === 'linked') return persist()
      const s = desk.snapshot()
      if (cmd === 'status') {
        const pos = s.positions.map((p) => `• ${p.label} ${p.sideName}: ${usd(p.value)} (${p.pnl >= 0 ? '+' : ''}${usd(p.pnl)})`).join('\n')
        return `Watching: ${s.context?.title ?? 'nothing'}${s.context?.replay ? ' [REPLAY]' : ''}\nPaper equity ${usd(s.equity)} (${s.pnl >= 0 ? '+' : ''}${usd(s.pnl)})\n${pos || 'No open positions.'}`
      }
      return 'Commands: /status'
    },
  })
  tg.start()
}

// ------------------------------------------------------------------ http
const rate = new Map()
function limited(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress
  const now = Date.now()
  const w = (rate.get(ip) || []).filter((t) => now - t < 10_000)
  w.push(now)
  rate.set(ip, w)
  return w.length > 60
}

const body = (req) =>
  new Promise((res) => {
    let b = ''
    req.on('data', (x) => (b += x).length > 1e4 && req.destroy())
    req.on('end', () => {
      try {
        res(JSON.parse(b || '{}'))
      } catch {
        res({})
      }
    })
  })

const json = (res, code, data) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
  res.end(JSON.stringify(data))
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp4': 'video/mp4', '.woff2': 'font/woff2' }

function serveStatic(req, res, dir, rel) {
  const f = path.join(dir, rel || 'index.html')
  if (!f.startsWith(dir) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return false
  const size = fs.statSync(f).size
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '')
  if (range && f.endsWith('.mp4')) {
    const start = range[1] ? Number(range[1]) : 0
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    res.writeHead(206, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 })
    fs.createReadStream(f, { start, end }).pipe(res)
    return true
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream', 'content-length': size, 'accept-ranges': 'bytes' })
  fs.createReadStream(f).pipe(res)
  return true
}

let gamesCache = { at: 0, list: [] }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const p = url.pathname
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST' })
    return res.end()
  }
  try {
    if (p === '/api/health') return json(res, 200, { ok: true, offline: OFFLINE })
    if (p === '/api/state') return json(res, 200, desk.snapshot())
    if (p === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'access-control-allow-origin': '*' })
      res.write(`event: state\ndata: ${JSON.stringify(desk.snapshot())}\n\n`)
      clients.add(res)
      const ka = setInterval(() => res.write(': ka\n\n'), 15_000)
      req.on('close', () => (clients.delete(res), clearInterval(ka)))
      return
    }
    if (p.startsWith('/api/') && req.method === 'POST' && limited(req)) return json(res, 429, { error: 'slow down' })

    if (p === '/api/contexts') {
      const out = { replay: [{ id: REPLAY_ID, title: replayContext().title, kind: 'replay', note: 'Simulated match for demos' }], live: [], telegram: tg?.enabled ? { bot: tg.username, code: tg.code, linked: tg.chats.size } : null }
      if (!OFFLINE) {
        if (Date.now() - gamesCache.at > 60_000) {
          try {
            gamesCache = { at: Date.now(), list: await liveGames() }
          } catch (e) {
            log('liveGames', e.message)
          }
        }
        out.live = gamesCache.list.map((g) => ({ id: g.id, title: g.title, start: g.start, kind: 'game', markets: g.markets.length }))
      }
      return json(res, 200, out)
    }
    if (p === '/api/search') {
      const q = String(url.searchParams.get('q') || '').slice(0, 80)
      if (!q || OFFLINE) return json(res, 200, { results: [] })
      const r = await search(q)
      return json(res, 200, { results: r.map((e) => ({ id: e.id, title: e.title, start: e.start, kind: 'search', markets: e.markets.length })) })
    }
    if (p === '/api/context' && req.method === 'POST') {
      const { id } = await body(req)
      let ctx
      if (id === REPLAY_ID) ctx = replayContext()
      else if (!OFFLINE) ctx = await eventById(String(id))
      if (!ctx) return json(res, 404, { error: 'no tradable two-sided markets in that event' })
      desk.setContext(ctx)
      watch()
      return json(res, 200, desk.snapshot())
    }
    if (p === '/api/focus' && req.method === 'POST') {
      const { index } = await body(req)
      desk.setFocus(Number(index) || 0)
      return json(res, 200, { focus: desk.focus })
    }
    if (p === '/api/stake' && req.method === 'POST') {
      const { usd: s } = await body(req)
      desk.setStake(Number(s))
      return json(res, 200, { stake: desk.stake })
    }
    if (p === '/api/trade' && req.method === 'POST') {
      const { marketId, side } = await body(req)
      const t = desk.trade(String(marketId), Number(side))
      watch()
      return json(res, 200, t)
    }
    if (p === '/api/cancel' && req.method === 'POST') {
      const { id } = await body(req)
      return json(res, 200, desk.cancel(String(id)))
    }
    if (p === '/api/close' && req.method === 'POST') {
      const { id } = await body(req)
      const done = desk.close(String(id))
      watch()
      return json(res, 200, done)
    }
    if (p === '/api/reset' && req.method === 'POST') {
      desk.reset()
      return json(res, 200, desk.snapshot())
    }
    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' })

    // static: /app/* is the glasses + phone app, everything else the website
    const rel = decodeURIComponent(p).replace(/^\/+/, '')
    if (rel === 'app' || rel.startsWith('app/')) {
      if (serveStatic(req, res, path.join(ROOT, 'glasses', 'dist'), rel.replace(/^app\/?/, ''))) return
    } else if (serveStatic(req, res, path.join(ROOT, 'site'), rel)) return
    res.writeHead(404).end('not found')
  } catch (e) {
    json(res, 400, { error: String(e.message || e).slice(0, 300) })
  }
})

const PORT = Number(process.env.PORT || 8787)
server.listen(PORT, () => log(`witness on :${PORT}${OFFLINE ? ' (offline: replay only)' : ''}`))
