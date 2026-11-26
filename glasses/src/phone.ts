// The phone side: choose what you are watching, set your stake, see your paper account.
// Everything here also works with a mouse, so the demo runs in a normal browser.
import { api, pct, cents, usd, signed, pts, type State, type Listing, type Push } from './api'

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
let state: State | null = null
let toastTimer = 0

const CSS = `
:root{--ink:#0e0d0d;--paper:#f7f6f4;--white:#fff;--line:#e6e2dd;--muted:#7d766f;--red:#ff2d3d;--up:#14804a;--down:#c2261c;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);-webkit-font-smoothing:antialiased}
.wrap{max-width:560px;margin:0 auto;padding:16px 14px 80px}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.logo{display:flex;gap:9px;align-items:center;font-weight:850;letter-spacing:-.02em;font-size:18px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--red);box-shadow:0 0 0 4px rgba(255,45,61,.15);animation:p 1.6s infinite}
@keyframes p{50%{box-shadow:0 0 0 7px rgba(255,45,61,.05)}}
.status{font-size:12px;color:var(--muted)}
.card{background:var(--white);border:1px solid var(--line);border-radius:16px;padding:14px;margin-bottom:12px}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin:0 0 10px;font-weight:700}
.board{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.board b{font-size:20px;letter-spacing:-.02em}.board .clock{font:600 13px ui-monospace,Menlo,monospace;color:var(--red)}
.tag{font-size:10px;font-weight:800;letter-spacing:.12em;background:var(--ink);color:#fff;padding:3px 7px;border-radius:99px;margin-left:6px;vertical-align:middle}
.mk{display:grid;grid-template-columns:1fr auto;gap:6px 10px;padding:11px 0;border-top:1px solid var(--line);align-items:center}
.mk:first-of-type{border-top:0}.mk.f{background:linear-gradient(90deg,rgba(255,45,61,.07),transparent);margin:0 -14px;padding:11px 14px}
.mk .q{font-weight:650;font-size:15px}.mk .p{font:700 18px ui-monospace,Menlo,monospace}
.ch{font-size:12px;margin-left:6px}.ch.u{color:var(--up)}.ch.d{color:var(--down)}
.btns{grid-column:1/-1;display:flex;gap:8px}
button{font:inherit;font-weight:700;font-size:14px;border-radius:11px;border:1px solid var(--line);background:var(--paper);padding:10px 12px;cursor:pointer;color:var(--ink)}
button.y{background:var(--ink);color:#fff;border-color:var(--ink);flex:1}button.n{flex:1}
button:disabled{opacity:.5}
.chips{display:flex;gap:6px;flex-wrap:wrap}.chips button.on{background:var(--red);border-color:var(--red);color:#fff}
.moment{font-size:13px;padding:7px 0;border-top:1px dashed var(--line);display:flex;justify-content:space-between;gap:8px}
.moment:first-child{border-top:0}.moment .t{color:var(--muted);font-size:11px;white-space:nowrap}
.pos{padding:10px 0;border-top:1px solid var(--line);font-size:14px}.pos:first-child{border-top:0}
.pos .l{display:flex;justify-content:space-between;gap:8px}.pos small{color:var(--muted);display:block;margin-top:3px}
.pnl.u{color:var(--up)}.pnl.d{color:var(--down)}
.list button{display:block;width:100%;text-align:left;margin-top:6px;background:var(--white)}
.list button small{display:block;color:var(--muted);font-weight:500;font-size:12px;margin-top:2px}
input{width:100%;font:inherit;font-size:15px;padding:11px 12px;border:1px solid var(--line);border-radius:11px;background:var(--paper)}
.note{font-size:12px;color:var(--muted);line-height:1.5}
.toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:var(--ink);color:#fff;padding:11px 16px;border-radius:12px;font-size:14px;font-weight:600;opacity:0;transition:.2s;max-width:92vw}
.toast.on{opacity:1}
a{color:inherit}
`

export function mountPhone() {
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)
  $('#app').innerHTML = `
  <div class="wrap">
    <header><div class="logo"><span class="dot"></span>Witness</div><span class="status" id="status">connecting…</span></header>
    <section class="card" id="now"></section>
    <section class="card"><h2>Stake per tap</h2><div class="chips" id="stakes"></div>
      <p class="note">Paper money only. Orders wait out each market's real Polymarket delay and fill at the price at that moment, not the price you saw.</p></section>
    <section class="card"><h2>Moments</h2><div id="moments"></div></section>
    <section class="card"><h2>Your paper account</h2><div id="account"></div></section>
    <section class="card"><h2>What are you watching?</h2>
      <input id="q" placeholder="Search Polymarket: a team, a city, a show…" />
      <div class="list" id="pick"></div></section>
    <section class="card" id="tg"></section>
  </div><div class="toast" id="toast"></div>`

  $('#q').addEventListener('keydown', async (e) => {
    if ((e as KeyboardEvent).key !== 'Enter') return
    const q = ($('#q') as HTMLInputElement).value.trim()
    if (!q) return
    try {
      const r = await api.search(q)
      listing(r.results, `Results for "${q}"`)
    } catch (err) {
      toast((err as Error).message)
    }
  })
  document.addEventListener('click', onClick)
  loadContexts()
}

async function loadContexts() {
  try {
    const c = await api.contexts()
    listing([...c.live, ...c.replay], c.live.length ? 'Live and starting soon' : 'Try the replay match')
    $('#tg').innerHTML = c.telegram
      ? `<h2>Telegram receipts</h2><p class="note">Send <b>/start ${esc(c.telegram.code)}</b> to <a href="https://t.me/${esc(c.telegram.bot)}" target="_blank">@${esc(c.telegram.bot)}</a>. ${c.telegram.linked} chat(s) linked. Fills, results and /status land there.</p>`
      : `<h2>Telegram receipts</h2><p class="note">Not switched on for this server.</p>`
  } catch (e) {
    $('#pick').innerHTML = `<p class="note">${esc((e as Error).message)}</p>`
  }
}

function listing(items: Listing[], title: string) {
  $('#pick').innerHTML =
    `<p class="note">${esc(title)}</p>` +
    (items.length
      ? items
          .map((i) => {
            const t = i.start ? Date.parse(i.start) : NaN
            const when = !Number.isFinite(t) ? '' : t <= Date.now() ? '● LIVE NOW' : `Starts ${new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
            return `<button data-watch="${esc(i.id)}">${esc(i.title)}<small>${i.kind === 'replay' ? 'REPLAY · simulated data' : `${esc(when)}${i.markets ? ` · ${i.markets} market${i.markets > 1 ? 's' : ''}` : ''}`}</small></button>`
          })
          .join('')
      : '<p class="note">Nothing tradable found.</p>')
}

async function onClick(e: Event) {
  const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null
  if (!b) return
  const d = b.dataset
  try {
    if (d.watch) {
      b.disabled = true
      await api.watch(d.watch)
      toast('Watching. Your glasses show it now.')
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } else if (d.trade) {
      const [id, side] = d.trade.split(':')
      const t = await api.trade(id, Number(side))
      toast(`${t.sideName} · ${t.label}: fills in ${t.delay}s`)
    } else if (d.cancel) {
      await api.cancel(d.cancel)
      toast('Cancelled before it filled')
    } else if (d.close) {
      const c = await api.close(d.close)
      toast(`Sold at ${cents(c.exitBid)} · ${signed(c.pnl)}`)
    } else if (d.stake) {
      await api.stake(Number(d.stake))
    } else if (d.focus) {
      await api.focus(Number(d.focus))
    } else if (d.reset) {
      if (confirm('Reset the paper account to $1,000?')) await api.reset()
    }
  } catch (err) {
    toast((err as Error).message)
  } finally {
    b.disabled = false
  }
}

function toast(msg: string) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.add('on')
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => t.classList.remove('on'), 2600)
}

export function setPhoneOnline(ok: boolean) {
  $('#status').textContent = ok ? 'live' : 'reconnecting…'
}

export function onPhonePush(p: Push) {
  if (p.type === 'edge' && p.data.edge.status === 'followed') toast(`⚡ The market followed you: ${pts(p.data.edge.move)} pts after ${p.data.edge.seconds}s`)
  if (p.type === 'filled') toast(`Filled at ${cents(p.data.fillPrice)} (you tapped at ${cents(p.data.tapAsk)})`)
}

export function setPhoneState(s: State) {
  state = s
  const c = s.context
  const g = s.game
  if (!c) {
    $('#now').innerHTML = '<p class="note">Pick something to watch below.</p>'
  } else {
    const board = g
      ? `<div class="board"><b>${esc(g.home)} ${esc(g.score.replace('-', '–'))} ${esc(g.away)}</b><span class="clock">${esc(g.ended ? 'FT' : g.elapsed || g.period)}</span></div>`
      : `<div class="board"><b>${esc(c.title)}</b></div>`
    $('#now').innerHTML =
      `<h2>Now watching${c.replay ? '<span class="tag">REPLAY</span>' : ''}</h2>${board}` +
      c.markets
        .map((m, i) => {
          const ch = Math.round(m.change60 * 100)
          return `<div class="mk ${i === s.focus ? 'f' : ''}" >
            <span class="q" data-focus="${i}">${esc(m.label)}</span>
            <span class="p">${pct(m.mid[0])}${ch ? `<span class="ch ${ch > 0 ? 'u' : 'd'}">${ch > 0 ? '▲' : '▼'}${Math.abs(ch)}</span>` : ''}</span>
            <div class="btns"><button class="y" data-trade="${esc(m.id)}:0">${esc(m.sides[0])} ${cents(m.ask[0])}</button><button class="n" data-trade="${esc(m.id)}:1">${esc(m.sides[1])} ${cents(m.ask[1])}</button></div>
          </div>`
        })
        .join('') +
      (c.url ? `<p class="note"><a href="${esc(c.url)}" target="_blank">Open on Polymarket ↗</a> · delay ${c.markets[0]?.delay ?? 0}s</p>` : '')
  }
  $('#stakes').innerHTML = s.stakes.map((x) => `<button class="${x === s.stake ? 'on' : ''}" data-stake="${x}">$${x}</button>`).join('')
  $('#moments').innerHTML =
    s.moments
      .slice(0, 8)
      .map((m) => `<div class="moment"><span>${m.type === 'score' || m.type === 'event' ? '⚡ ' : m.type === 'swing' ? '↕ ' : ''}${esc(m.text)}</span><span class="t">${new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></div>`)
      .join('') || '<p class="note">Nothing yet.</p>'
  const rows = [
    ...s.pending.map((t) => `<div class="pos"><div class="l"><span>◆ ${esc(t.sideName)} · ${esc(t.label)}</span><button data-cancel="${esc(t.id)}">Cancel · ${t.fillsIn ?? 0}s</button></div><small>$${t.usd} · tapped at ${cents(t.tapAsk)} · waiting out the ${t.delay}s delay</small></div>`),
    ...s.positions.map((p) => {
      const e = p.edge
      const edge = e.status === 'followed' ? `⚡ market followed: ${pts(e.move ?? 0)} pts after ${e.seconds}s` : e.status === 'not_followed' ? '○ market did not follow' : e.status === 'void' ? '○ not scored (replay restarted)' : '… watching the market'
      return `<div class="pos"><div class="l"><span>${esc(p.sideName)} · ${esc(p.label)}</span><span class="pnl ${p.pnl >= 0 ? 'u' : 'd'}">${signed(p.pnl)}</span></div><small>in ${cents(p.fillPrice)} (tapped ${cents(p.tapAsk)}) · now ${usd(p.value)} · ${edge}</small><button data-close="${esc(p.id)}" style="margin-top:7px">Sell</button></div>`
    }),
  ]
  $('#account').innerHTML =
    `<div class="board"><b>${usd(s.equity)}</b><span class="pnl ${s.pnl >= 0 ? 'u' : 'd'}">${signed(s.pnl)}</span></div>` +
    (rows.join('') || '<p class="note">No positions. On the glasses: scroll up or down to back a side.</p>') +
    (s.closed.length ? `<p class="note">Closed: ${s.closed.slice(0, 3).map((c) => `${esc(c.label)} ${signed(c.pnl)}`).join(' · ')}</p>` : '') +
    `<button data-reset="1" style="margin-top:8px">Reset paper account</button>`
}

export const _state = () => state
