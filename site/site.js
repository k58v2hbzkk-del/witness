// Mirrors what the glasses would show, from the same live state.
const m = document.getElementById('mirror')
const pct = (p) => (p == null ? '--' : `${Math.round(p * 100)}%`)
const cents = (p) => (p == null ? '--' : `${Math.round(p * 100)}¢`)
function draw(s) {
  const c = s.context
  if (!c) return
  const g = s.game
  const head = g ? `● ${c.replay ? 'REPLAY ' : ''}${g.home.split(' ')[0]} ${g.score.replace('-', '–')} ${g.away.split(' ')[0]}  ${g.ended ? 'FT' : g.elapsed || g.period}` : `● ${c.title}`
  const rows = c.markets.map((x, i) => {
    const d = Math.round(x.change60 * 100)
    return `${i === s.focus ? '▶' : ' '} ${pct(x.mid[0]).padStart(4)}  ${x.label}${Math.abs(d) >= 2 ? `  ${d > 0 ? '▲' : '▼'}${Math.abs(d)}` : ''}`
  })
  const mo = s.moments.find((x) => x.type !== 'watch' && Date.now() - x.at < 45000)
  const f = c.markets[Math.min(s.focus, c.markets.length - 1)]
  m.textContent = `${head}\n\n${rows.join('\n')}${mo ? `\n\n● ${mo.text}` : '\n'}\n\n↑ ${f.sides[0]} ${cents(f.ask[0])}  ↓ ${f.sides[1]} ${cents(f.ask[1])}`
}
function connect() {
  const es = new EventSource('/api/stream')
  es.addEventListener('state', (e) => draw(JSON.parse(e.data)))
  es.onerror = () => (es.close(), setTimeout(connect, 3000))
}
connect()
