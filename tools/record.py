"""Records Witness running in the Even Hub simulator against the live server, with real Polymarket data.
Screens -> frames/, state -> state.jsonl, actions -> actions.log. Used by .github/workflows/record.yml."""
import json, os, sys, time, threading, urllib.request

BASE = os.environ.get('BASE', 'https://witness-rjya.onrender.com')
SIM = 'http://127.0.0.1:9898'
MIN = float(os.environ.get('MINUTES', '25'))
QUERY = os.environ.get('QUERY', '').strip().lower()
os.makedirs('frames', exist_ok=True)

def get(u, t=20): return urllib.request.urlopen(u, timeout=t).read()
def post(u, body):
    r = urllib.request.Request(u, data=json.dumps(body).encode(), headers={'content-type': 'application/json'})
    return json.loads(urllib.request.urlopen(r, timeout=30).read() or b'{}')
t0 = time.time()
alog = open('actions.log', 'w')
def act(a):
    try: post(f'{SIM}/api/input', {'action': a})
    except Exception as e: print('input failed', a, e)
    alog.write(f'{time.time()-t0:.2f} {a}\n'); alog.flush(); print(f'{time.time()-t0:7.1f}s {a}', flush=True)

# pick a live game: a team name if given, else the busiest game that has already started
cs = json.loads(get(f'{BASE}/api/contexts', 90))
now = time.time() * 1000
live = [c for c in cs.get('live', []) if c.get('markets', 0) >= 2]
def started(c):
    try:
        from datetime import datetime
        return datetime.fromisoformat(c['start'].replace('Z', '+00:00')).timestamp() * 1000 <= now
    except Exception: return False
pick = None
if QUERY:
    hits = [c for c in live if QUERY in c['title'].lower()]
    on = [c for c in hits if started(c)]
    pick = (sorted(on, key=lambda c: c['start'])[-1] if on else (hits[0] if hits else None))
    if not pick:
        found = json.loads(get(f'{BASE}/api/search?q=' + urllib.parse.quote(QUERY), 60))
        pick = (found.get('results') or found if isinstance(found, list) else found.get('results', [None]))[0]
if not pick:
    soccer = [c for c in live if started(c) and not c['title'].lower().startswith(('counter-strike', 'lol', 'dota', 'valorant'))]
    pick = (soccer or [c for c in live if started(c)] or live)[0]
print('context:', pick['title'], pick['id'], flush=True)
post(f'{BASE}/api/context', {'id': pick['id']})
post(f'{BASE}/api/reset', {})
post(f'{BASE}/api/stake', {'usd': 10})

stop = False
frames = []
def shooter():
    i = 0
    while not stop:
        t = time.time() - t0
        try:
            open(f'frames/f{i:06d}.png', 'wb').write(get(f'{SIM}/api/screenshot/glasses', 5)); frames.append((i, round(t, 3))); i += 1
        except Exception: pass
        time.sleep(max(0, 0.2 - (time.time() - t0 - t)))
threading.Thread(target=shooter, daemon=True).start()

slog = open('state.jsonl', 'w')
seen, last_act, fills = set(), time.time(), []
forced = False
time.sleep(4)
for k in range(3): act('click'); time.sleep(1.5)
act('click')  # back to the first market (4 markets max; wraps)
while time.time() - t0 < MIN * 60:
    try: s = json.loads(get(f'{BASE}/api/state', 15))
    except Exception: time.sleep(1); continue
    s['_t'] = round(time.time() - t0, 2); slog.write(json.dumps(s) + '\n'); slog.flush()
    for m in s.get('moments', [])[:3]:
        key = (m.get('type'), m.get('text'), m.get('at'))
        if key in seen: continue
        seen.add(key)
        if m.get('type') in ('score', 'swing') and len(seen) > 1 and time.time() - last_act > 30:
            time.sleep(1.8); act('up'); last_act = time.time(); fills.append(time.time())
    if not forced and time.time() - t0 > 45:
        act('up'); forced = True; last_act = time.time(); fills.append(time.time())
    if fills and time.time() - fills[0] > 25:
        act('double_click'); time.sleep(5); act('double_click'); fills.pop(0); last_act = time.time()
    if time.time() - last_act > 60:
        act('click'); last_act = time.time()
    time.sleep(1)
stop = True; time.sleep(1)
json.dump({'context': pick, 'frames': frames}, open('frames.json', 'w'))
print('frames', len(frames))
