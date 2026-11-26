# Witness

**Trade what's happening in front of your eyes.**

Witness puts the live Polymarket markets for the game, the city or the show in front of you on your
Even G2 glasses. When something happens, a goal, a red card, the rain starting, the people who are
there see it before the market moves. One gesture on the glasses backs what you just saw.

Built for **Heads Up: Even Realities Hackathon** (DoraHacks, TVM Ventures × Daos Hub), **Track 02 · Crypto & DeFi** (Polymarket).

- Live: https://witness-rjya.onrender.com (website) · https://witness-rjya.onrender.com/app/ (glasses + phone app)
- Paper trading only, on live public Polymarket data. No wallet, no keys, no custody.

## Why glasses

Prediction markets move on events. The people closest to an event see it first, but they can't use
it: by the time you pull out a phone, unlock it, find the market and tap through a trade, the market
has already moved. On G2 the odds sit in the corner of your eye while you keep watching, and acting
is one scroll on the touchpad or the R1 ring.

The other Polymarket apps for G2 are odds screens you check when you want. Witness is built around
**the moment**: the markets tied to what is in front of you, a nudge when something just happened,
and a score for whether you really were ahead of the market.

## How it works

1. **Pick the moment** in the phone app: a live or upcoming game Polymarket lists, any Polymarket
   search (a city's temperature markets, a speech, a show), or the built-in **REPLAY** match.
2. **Watch.** The glasses show the score and clock, up to four two-sided markets with live odds and
   their one-minute move, and the latest moment.
3. **Moments.** A score change from Polymarket's live sports feed, or a market swinging 5+ points in
   20 seconds, flashes on the glasses: *the market has not moved yet*.
4. **One gesture.**

   | Gesture | Watching | Positions |
   |---|---|---|
   | scroll up | back the first side (YES / first team) | previous |
   | scroll down | back the second side (NO / second team) | next |
   | tap | next market | sell / close app |
   | double-tap | cancel an order still waiting; otherwise open positions | back |

5. **Did the market follow you?** After each tap Witness watches that outcome for 60 seconds. If its
   price moves 3+ points your way it tells you how far and how many seconds after your tap:
   *"The market followed you: +8 pts, 9s after your tap."* If not, it says so.
6. **Telegram receipts** (optional): fills, results, sells and `/status`.

## Real Polymarket rules, no fake edge

Polymarket delays order matching on sports markets (`secondsDelay` on each market) so people at the
venue can't trade on a play before everyone else sees it. Witness respects that:

- A paper order **waits out the market's delay** and then fills at the **ask at that moment**, not the
  price you saw when you tapped. If the market moved inside the delay, you pay the new price, and
  the position shows both (`in at 55¢, tapped 43¢`).
- You can **cancel during the delay** with a double-tap.
- No fill at 99¢ or above, no fill without a seller, no spending more paper cash than you have.

The point is to show honestly how being there works *within* the venue's rules, not to promise an
edge that Polymarket has designed away.

## Architecture

```
glasses/   Even Hub app (TypeScript, Vite, Even Hub SDK 0.0.16)
  src/glasses.ts   G2 screens + gestures (3 text containers, 576×288)
  src/phone.ts     phone companion: pick a moment, stake, account, Telegram link
server/    Node 22, no dependencies
  polymarket.mjs   Gamma REST discovery, CLOB market WebSocket (book / price_change / best_bid_ask),
                   sports WebSocket (live scores), team matching
  desk.mjs         context, quotes, moments, paper account, delay-honouring fills, edge scoring
  replay.mjs       simulated match for demos and tests, always labelled REPLAY
  telegram.mjs     optional bot (long polling)
  server.mjs       HTTP + server-sent events, serves the site and /app
site/      website with a live mirror of what the glasses show
test/      13 tests (fills after the delay, cancel, edge scoring, swings, events, parsing, matching)
```

Data sources, all public and read-only:
`gamma-api.polymarket.com` (events, markets, search), `wss://ws-subscriptions-clob.polymarket.com/ws/market`
(live order book), `wss://sports-api.polymarket.com/ws` (live game state).

## Run it

```
npm test                      # server tests
cd glasses && npm ci && npm run build && cd ..
npm start                     # http://localhost:8787 and /app
OFFLINE=1 npm start           # no Polymarket connections, replay only
```

In the simulator: `cd glasses && npx evenhub-simulator http://localhost:8787/app/`.

Environment: `PORT`, `DATA_DIR`, `TELEGRAM_BOT_TOKEN` (optional), `OFFLINE=1`.

## Safety and limits

- Paper only. Nothing here can move real money.
- Polymarket says its sports feed can be delayed or wrong, so Witness uses it to flag moments, never to
  trade by itself. Nothing happens until you gesture.
- One shared paper desk per server (fine for a demo, not multi-user).
- The REPLAY match is simulated data and is labelled on every screen.
- No camera (G2 has none) and no microphone use.

## What existed before Nov 23 (hackathon disclosure)

All Witness code was written during the build week (Nov 26–29, 2026). Reused:
- npm dependencies (Even Hub SDK, CLI, simulator, Vite, TypeScript).
- The glasses build config (`glasses/tsconfig.json`, `vite.config.ts`) and the rendering pattern
  (three text containers, a serialized update queue) come from my earlier G2 prototype, Leash
  (github.com/k58v2hbzkk-del/leash), built Nov 18. No Leash features or server code are in Witness.

## License

MIT
