// What the G2 shows. You are watching something real; the glasses keep its markets in the corner of
// your eye, and one gesture backs what you just saw.
//
//   scroll up   back the first side of the focused market (YES / home team)
//   scroll down back the second side (NO / away team)
//   tap         next market
//   double-tap  cancel an order still waiting out Polymarket's delay; otherwise open positions
import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { api, pct, cents, usd, signed, pts, type State, type Push, type MarketView } from './api'

type Mode = 'watch' | 'positions'
type Flash = { title: string; body: string; until: number }

const HDR = { id: 1, name: 'hdr' }
const BODY = { id: 2, name: 'body' }
const FOOT = { id: 3, name: 'foot' }
const W = 44 // characters per line that fit comfortably

let bridge: EvenAppBridge
let state: State | null = null
let mode: Mode = 'watch'
let cursor = 0
let flash: Flash | null = null
let online = false
let busy = false
const shown = { hdr: '', body: '', foot: '' }

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const ago = (at: number) => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`
}
const arrow = (d: number) => (d >= 0.02 ? `▲${Math.round(d * 100)}` : d <= -0.02 ? `▼${Math.round(-d * 100)}` : '')

// ------------------------------------------------------------------ screens
function header(s: State): string {
  const c = s.context
  if (!c) return '● WITNESS'
  const tag = c.replay ? 'REPLAY ' : ''
  const g = s.game
  if (g) {
    const [h, a] = g.score.split('-')
    const clock = g.ended ? 'FT' : g.elapsed || g.period
    return cap(`● ${tag}${short(g.home)} ${h}–${a} ${short(g.away)}  ${clock}`, W + 6)
  }
  return cap(`● ${tag}${c.title}`, W + 6)
}
const short = (team: string) => cap(team.split(' ')[0], 12)

function screen(): [string, string, string] {
  if (!state) return ['● WITNESS', online ? 'Loading…' : 'Connecting to Witness…', '']
  const head = header(state)
  if (flash && Date.now() < flash.until) return [head, `${flash.title}\n${flash.body}`, footFor(true)]
  flash = null
  if (!state.context) return [head, 'Pick what you are watching\nin the Witness phone app.', '']
  if (mode === 'positions') return positions()
  return watch(head)
}

function watch(head: string): [string, string, string] {
  const s = state!
  const ms = s.context!.markets
  const focus = Math.min(s.focus, ms.length - 1)
  const rows = ms.map((m, i) => `${i === focus ? '▶' : '   '} ${pct(m.mid[0])}  ${cap(m.label, 26)}  ${arrow(m.change60)}`)
  const p = s.pending[0]
  const latest = s.moments.find((m) => m.type !== 'watch')
  let extra = ''
  if (p) extra = `◆ ${p.sideName} ${cap(p.label, 18)} fills in ${p.fillsIn ?? 0}s`
  else if (latest && Date.now() - latest.at < 45_000) extra = `● ${cap(latest.text, 30)} · ${ago(latest.at)}`
  return [head, rows.join('\n') + (extra ? `\n\n${extra}` : ''), footFor(false)]
}

function footFor(flashing: boolean): string {
  const s = state
  if (!s?.context || mode === 'positions') return ''
  if (s.pending.length) return 'double-tap: cancel before it fills'
  if (flashing) return ''
  const m = s.context.markets[Math.min(s.focus, s.context.markets.length - 1)]
  return cap(`↑ ${sideTag(m, 0)} ${cents(m.ask[0])}  ↓ ${sideTag(m, 1)} ${cents(m.ask[1])}  ·  $${s.stake}`, W + 6)
}
const sideTag = (m: MarketView, i: number) => cap(m.sides[i], 9)

function positions(): [string, string, string] {
  const s = state!
  const list = s.positions
  const slots = list.length + 1
  cursor = Math.min(cursor, slots - 1)
  const head = `● PAPER ${usd(s.equity)}  ${signed(s.pnl)}`
  if (cursor === list.length) return [head, list.length ? `${list.length} open position${list.length > 1 ? 's' : ''}\n\n■ CLOSE WITNESS` : 'No open positions.\n\n■ CLOSE WITNESS', `${cursor + 1}/${slots}  tap: close app  double-tap: back`]
  const p = list[cursor]
  const e = p.edge
  const edge =
    e.status === 'followed' ? `● market followed ${pts(e.move ?? 0)} pts after ${e.seconds}s` : e.status === 'not_followed' ? '○ market did not follow' : e.status === 'void' ? '○ not scored (replay restarted)' : '… watching the market'
  const body = `${p.sideName} · ${cap(p.label, 30)}\nin at ${cents(p.fillPrice)} (tapped ${cents(p.tapAsk)})\nnow ${usd(p.value)}  ${signed(p.pnl)}\n${edge}`
  return [head, body, `${cursor + 1}/${slots}  tap: sell  double-tap: back`]
}

// ------------------------------------------------------------------ rendering
let queue = Promise.resolve()
function call<T>(fn: () => Promise<T>) {
  const run = queue.then(() => Promise.race([fn(), new Promise<T>((r) => setTimeout(() => r(undefined as T), 4000))]))
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function render() {
  if (!bridge) return
  const [h, b, f] = screen()
  const parts: [typeof HDR, string, keyof typeof shown][] = [
    [HDR, h, 'hdr'],
    [BODY, b || ' ', 'body'],
    [FOOT, f || ' ', 'foot'],
  ]
  for (const [c, text, key] of parts) {
    if (shown[key] === text) continue
    shown[key] = text
    await call(() => bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: c.id, containerName: c.name, content: text })))
  }
}

function showFlash(title: string, body: string, ms = 2500) {
  flash = { title, body, until: Date.now() + ms }
  render()
}

// ------------------------------------------------------------------ input
async function onInput(kind: 'click' | 'double' | 'up' | 'down') {
  if (!state || busy) return
  if (mode === 'positions') {
    const slots = state.positions.length + 1
    if (kind === 'double') return (mode = 'watch'), render()
    if (kind === 'down') return (cursor = (cursor + 1) % slots), render()
    if (kind === 'up') return (cursor = (cursor - 1 + slots) % slots), render()
    if (cursor === state.positions.length) return bridge.shutDownPageContainer(1)
    const p = state.positions[cursor]
    return act(() => api.close(p.id), 'SOLD', `${p.sideName} · ${cap(p.label, 26)}`)
  }
  const ms = state.context?.markets ?? []
  if (!ms.length) return
  if (kind === 'double') {
    const p = state.pending[state.pending.length - 1]
    if (p) return act(() => api.cancel(p.id), 'CANCELLED', 'Nothing was bought.')
    return (mode = 'positions'), (cursor = 0), render()
  }
  if (kind === 'click') {
    const next = (state.focus + 1) % ms.length
    state.focus = next
    render()
    return api.focus(next).catch(() => {})
  }
  const m = ms[Math.min(state.focus, ms.length - 1)]
  const side = kind === 'up' ? 0 : 1
  busy = true
  try {
    const t = await api.trade(m.id, side)
    showFlash(`◆ ${t.sideName} · ${cap(t.label, 28)}`, `$${t.usd} at about ${cents(t.tapAsk)}\n${t.delay ? `fills in ${t.delay}s (Polymarket's delay)\ndouble-tap to cancel` : 'filling now'}`, Math.max(1800, t.delay * 1000))
  } catch (e) {
    showFlash('NOT PLACED', cap(String((e as Error).message || e), 40))
  } finally {
    busy = false
  }
}

async function act(fn: () => Promise<unknown>, title: string, body: string) {
  busy = true
  try {
    await fn()
    showFlash(title, body, 1800)
  } catch (e) {
    showFlash('NOT DONE', cap(String((e as Error).message || e), 40))
  } finally {
    busy = false
  }
}

// ------------------------------------------------------------------ boot
export async function startGlasses() {
  bridge = await waitForEvenAppBridge()
  const text = (c: { id: number; name: string }, y: number, h: number, capture: 0 | 1, brightness: number, content: string) =>
    new TextContainerProperty({ xPosition: 0, yPosition: y, width: 576, height: h, borderWidth: 0, borderColor: 0, paddingLength: 6, containerID: c.id, containerName: c.name, isEventCapture: capture, textColor: brightness, content })
  await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: 3,
      textObject: [text(HDR, 0, 44, 0, 3, '● WITNESS'), text(BODY, 44, 200, 1, 4, 'Connecting to Witness…'), text(FOOT, 244, 44, 0, 2, ' ')],
    }),
  )
  console.log('WITNESS_READY')
  bridge.onEvenHubEvent((e) => {
    const sys = e.sysEvent ? (e.sysEvent.eventType ?? OsEventTypeList.CLICK_EVENT) : null
    const txt = e.textEvent ? (e.textEvent.eventType ?? null) : null
    if (sys === OsEventTypeList.DOUBLE_CLICK_EVENT) return onInput('double')
    if (txt === OsEventTypeList.SCROLL_TOP_EVENT) return onInput('up')
    if (txt === OsEventTypeList.SCROLL_BOTTOM_EVENT) return onInput('down')
    if (sys === OsEventTypeList.CLICK_EVENT && e.sysEvent) return onInput('click')
    if (sys === OsEventTypeList.FOREGROUND_ENTER_EVENT) return (shown.hdr = shown.body = shown.foot = ''), render()
  })
  setInterval(render, 1000)
}

export function setGlassesState(s: State) {
  state = s
  render()
}
export function setOnline(ok: boolean) {
  online = ok
  render()
}

/** Things worth interrupting the view for. */
export function onGlassesPush(p: Push) {
  const d = p.data
  if (p.type === 'moment' && (d.type === 'score' || d.type === 'event')) showFlash(`● ${cap(d.text, 34)}`, 'The market has not moved yet.\n↑/↓ to back what you just saw.', 3500)
  if (p.type === 'filled') showFlash(`▶ FILLED ${cents(d.fillPrice)}`, `${d.sideName} · ${cap(d.label, 28)}\nyou tapped at ${cents(d.tapAsk)} · ${d.delay}s delay`, 2600)
  if (p.type === 'unfilled') showFlash('NOT FILLED', cap(d.reason, 40), 2600)
  if (p.type === 'edge' && d.edge.status === 'followed') showFlash('● THE MARKET FOLLOWED YOU', `${d.sideName} ${cap(d.label, 24)}\n${pts(d.edge.move)} pts, ${d.edge.seconds}s after your tap`, 3500)
}
