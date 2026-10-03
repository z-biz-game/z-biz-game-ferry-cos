#!/usr/bin/env bash
# One-shot verification gate for 迷津渡: the node suites first, then a real browser against a real
# server, driven over CDP. Everything exits with the script, including the Chrome it started in a
# temp profile.
#
# Do NOT add --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader: software
# rasterization saturates the cores and, with no CDP client attached, the process will not exit on
# its own. This game is 2D canvas, so plain headless Chrome is enough.
#
#   ./tools/verify.sh                       # node suites + @boot @play @routes @save @pointer
#   SCENARIOS="pointer" ./tools/verify.sh   # one browser suite while editing the view
#   SKIP_UNIT=1 ./tools/verify.sh           # browser job in CI (the suites are their own job)
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
CDP_PORT=${CDP_PORT:-9348}
WEB_PORT=${WEB_PORT:-5188}
BASE=${BASE_URL:-http://127.0.0.1:$WEB_PORT/}
MIN_BROWSER_ROWS=${MIN_BROWSER_ROWS:-38}
# The logic tier has a floor of its own: `tools/doctest.mjs` compares this number against the
# assertion counts it measures by actually running every suite, so lowering the floor is a change
# the documentation gate notices. Suites only ever get added, never silently dropped.
MIN_LOGIC_ROWS=${MIN_LOGIC_ROWS:-95}
CHROME=${CHROME_BIN:-}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
[ -x "$CHROME" ] || { echo "no Chrome found; set CHROME_BIN" >&2; exit 2; }

# One headless Chrome per machine, and one app per web port: this repository shares a farm with
# sibling games that default to :5180/:9340. Talking to somebody else's DevTools or somebody
# else's index.html produces confident nonsense, so refuse instead.
if curl -fsS -m 1 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1; then
  echo "something already owns DevTools on :$CDP_PORT — stop it or pass CDP_PORT=<other>" >&2
  exit 6
fi

UDD=$(mktemp -d)
"$CHROME" --headless=new --remote-debugging-port=$CDP_PORT --user-data-dir=$UDD \
  --window-size=1280,820 --no-first-run --no-default-browser-check about:blank >/tmp/ferry-chrome.log 2>&1 &
CPID=$!
node "$HERE/server.cjs" $WEB_PORT >/tmp/ferry-server.log 2>&1 &
SPID=$!
cleanup() {
  trap - EXIT
  kill -9 $CPID $SPID 2>/dev/null
  wait $CPID 2>/dev/null
  wait $SPID 2>/dev/null
  # No residue: a Chrome still holding the temp profile would be left running for the next agent.
  RESID=$(pgrep -f "user-data-dir=$UDD" 2>/dev/null | wc -l | tr -d ' ')
  [ "${RESID:-0}" != "0" ] && echo "WARNING: $RESID chrome process still holds $UDD" >&2
  rm -rf $UDD
}
trap cleanup EXIT
# Watchdog redirects its fds: a background subshell inherits the script's stdout, and if this runs
# inside a pipeline it would hold the write end open for the full timeout and stall the consumer
# long after the tests finished.
( sleep ${WD_TIMEOUT:-420}; cleanup ) </dev/null >/dev/null 2>&1 & WD=$!

# A fresh --user-data-dir binds DevTools noticeably later than a warm profile, so wait on both
# endpoints rather than guessing a sleep duration. The web root is waited on *with its content*:
# a port already serving another game would otherwise be polled as "ready".
for i in $(seq 1 60); do
  curl -fsS -m 1 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 2 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 || {
  echo "devtools never bound on :$CDP_PORT" >&2; exit 3; }
for i in $(seq 1 40); do
  curl -fsS -m 1 "$BASE" 2>/dev/null | grep -q 'id="lot"' && break
  sleep 0.25
done
curl -fsS -m 2 "$BASE" 2>/dev/null | grep -q 'id="lot"' || {
  echo "static server never served this app at $BASE" >&2; exit 4; }

cd "$HERE"
FAILED=0
ROWS=0

echo "=== node suites ==="
LOGIC=0
if [ -z "${SKIP_UNIT:-}" ]; then
  for f in test/*.test.mjs; do
    echo "--- $f"
    node "$f" > /tmp/ferry-unit.txt 2>&1 || FAILED=1
    cat /tmp/ferry-unit.txt
    N=$(grep '^rows: ' /tmp/ferry-unit.txt | tail -1 | awk '{print $2}')
    LOGIC=$((LOGIC + ${N:-0}))
  done
  echo "logic assertions counted: $LOGIC (floor $MIN_LOGIC_ROWS)"
  [ "$LOGIC" -ge "$MIN_LOGIC_ROWS" ] || { echo "too few logic assertions" >&2; FAILED=1; }
else
  echo "SKIP_UNIT=1 — the node suites are their own CI job"
fi

# The sixth gate: every number printed into README / DESIGN / deliverable is compared against the
# value the code reports right now. Pure node, no browser, so it belongs in the logic tier — and it
# reads the docs, so it runs the same way locally and in CI (`node tools/doctest.mjs`).
if [ -z "${SKIP_UNIT:-}" ]; then
  echo "=== doc numbers ==="
  node tools/doctest.mjs > /tmp/ferry-doctest.txt 2>&1 || FAILED=1
  cat /tmp/ferry-doctest.txt
  DOCS_ROWS=$(grep '^rows: ' /tmp/ferry-doctest.txt | tail -1 | awk '{print $2}')
  echo "doc-number assertions counted: ${DOCS_ROWS:-0}"
fi

# The ledger: eight knives, each one a documented lie written back into a throwaway copy, each one
# required to turn the gate above red AND name the assertion it bites. A doc gate nobody ever trips
# is a doc gate nobody can trust — "0 FAIL" also means "the parser found nothing to compare".
# It belongs in the logic tier because it starts no browser: 7 copies + 1 knife-free control.
if [ -z "${SKIP_UNIT:-}" ]; then
  echo "=== sabotage ledger ==="
  node tools/sabotage.mjs > /tmp/ferry-sabotage.txt 2>&1 || FAILED=1
  cat /tmp/ferry-sabotage.txt
fi

export CDP_PORT
export BASE_URL=$BASE
node tools/playtest.mjs open "$BASE" | head -3
# The pool is tens of kilobytes of measurement and the shell resolves a route before it reports a
# state, so wait on window.ferry rather than on a timer.
BOOT=""
for i in $(seq 1 60); do
  BOOT=$(node tools/playtest.mjs eval "window.ferry?window.ferry.state.id:'nope'" nonav 2>/dev/null | tr -d '\n" ')
  case "$BOOT" in *nope*|"") sleep 0.5 ;; *) break ;; esac
done
echo "boot lot: $BOOT"
[ "$BOOT" = "nope" ] && { echo "window.ferry never appeared at $BASE" >&2; exit 5; }

for s in ${SCENARIOS:-boot play routes save pointer}; do
  echo "=== @$s ==="
  rm -f /tmp/ferry-rows.txt
  node tools/playtest.mjs eval "@$s" nonav 2>&1 | python3 -c '
import sys, json
raw = sys.stdin.read()
# Brace counting, not JSON.parse of a whole line: headless Chrome appends its own text to the
# same line the console log arrives on, so the first { is where the payload starts and its
# matching brace is where it ends.
start = raw.find("{")
if start < 0:
    print("NO RESULT", raw[-400:]); sys.exit(1)
depth = 0
d = None
for i in range(start, len(raw)):
    if raw[i] == "{": depth += 1
    elif raw[i] == "}":
        depth -= 1
        if depth == 0:
            try: d = json.loads(raw[start:i + 1])
            except Exception as e:
                print("BAD JSON", e, raw[start:start+200]); sys.exit(1)
            break
rows = d.get("rows", [])
print("rows:", len(rows), "fail:", json.dumps(d.get("fail"), ensure_ascii=False))
for r in rows:
    if not r["pass"]: print("  FAIL", r["test"], json.dumps(r["detail"], ensure_ascii=False)[:300])
# One scenario runs exactly once: the count is written out here rather than re-running the suite
# to recount it, because these suites mutate the save file as they go.
open("/tmp/ferry-rows.txt", "w").write(str(len(rows)))
sys.exit(1 if d.get("fail") else 0)
' || FAILED=1
  N=$(cat /tmp/ferry-rows.txt 2>/dev/null || echo 0)
  ROWS=$((ROWS + ${N:-0}))
  echo "  rows so far: $ROWS"
  node tools/playtest.mjs shot "/tmp/ferry-$s.png" >/dev/null 2>&1
done

echo "=== console ==="
node tools/playtest.mjs logs | tee /tmp/ferry-console.txt
grep -q 'EXCEPTION' /tmp/ferry-console.txt && { echo "console raised an exception" >&2; FAILED=1; }

echo "browser rows counted: $ROWS (minimum $MIN_BROWSER_ROWS)"
[ "$ROWS" -ge "$MIN_BROWSER_ROWS" ] || { echo "too few browser assertions" >&2; FAILED=1; }

kill $WD 2>/dev/null
wait $WD 2>/dev/null
[ $FAILED -eq 0 ] && echo "=== ALL GREEN ===" || echo "=== FAILURES ABOVE ==="
exit $FAILED
