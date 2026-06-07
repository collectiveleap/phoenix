#!/bin/sh
# Decisive evidence for PROVIDER-STREAMING-DIAGNOSIS.md, made runnable.
#
# Confirms the ONLY variable that changes the outcome is `--output-format
# stream-json`: default text mode buffers a large output to 0 bytes until
# completion (watchdog reads that as a startup stall and kills it), while
# stream-json emits a first byte in ~2s and streams throughout.
#
# Usage:  sh change-notes/repro-streaming.sh
# Needs:  a working `claude` on PATH (or a known install location).

set -u

MODEL="${MODEL:-sonnet}"
COMMON="--model $MODEL --tools '' --no-session-persistence"
BIG_PROMPT='Output ONLY a complete ~300-line inline-HTML single-page app. No markdown fences, no commentary.'

echo "== 1. trivial prompt — returns immediately (sanity) =="
printf 'Reply with exactly: OK' | claude -p $COMMON
echo

echo "== 2. large output, DEFAULT text mode — looks hung (0 bytes until done) =="
echo "   (Ctrl-C if it sits silent; that silence IS the bug Phoenix used to kill.)"
time (printf '%s' "$BIG_PROMPT" | claude -p $COMMON | head -c 200)
echo

echo "== 3. SAME prompt, stream-json — first byte in ~2s, streams throughout =="
time (printf '%s' "$BIG_PROMPT" \
  | claude -p $COMMON --output-format stream-json --verbose \
  | head -n 20)
echo

cat <<'EOF'

== Manual S5 acceptance (the headline) ==
Under `phoenix run` with the claude-cli provider, a node-typescript web-UI
module (a full inline-HTML SPA) must generate to completion hands-off:

  1. Build:  node node_modules/typescript/bin/tsc
  2. In a scratch project with a spec containing a web-UI section:
       node /path/to/phoenix/dist/cli.js run
  3. Expect: a complete, non-stub `web-experience` module and a passing
     acceptance gate. The run journal should show that module streaming from
     ~2s to completion (call_first_byte early, call_progress rising), with no
     `watchdog_kill` against it.
EOF
