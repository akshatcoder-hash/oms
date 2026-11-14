#!/bin/sh
# One-command macOS check of the host-mode Seatbelt profile. Run from the repo root on a Mac:
#   sh scripts/seatbelt-verify.sh
# Prints PASS/FAIL per block; a skipped block is a FAIL. Exit 0 only when every block passes.
set -u
cd "$(dirname "$0")/.." || exit 2
if [ "$(uname -s)" != Darwin ] || [ ! -x /usr/bin/sandbox-exec ]; then
  echo "FAIL needs macOS with /usr/bin/sandbox-exec"; exit 2
fi
# The Surfpool block needs the pinned binary: the one `oms doctor --install` put in place, or a checkout's copy.
: "${SURFPOOL_BINARY:=$(ls "$HOME"/.oms/tools/surfpool-*/surfpool .tmp/tools/surfpool 2>/dev/null | head -1)}"
[ -n "$SURFPOOL_BINARY" ] || { echo "FAIL no Surfpool found: run oms doctor --install first, or set SURFPOOL_BINARY"; exit 2; }
export SURFPOOL_BINARY
tap=$(node --test --test-reporter=tap --test-name-pattern='^seatbelt:' packages/sandbox/test/seatbelt.test.ts 2>&1)
fails=0; count=0
echo "$tap" | grep -E '^# Subtest: seatbelt:' >/dev/null || { echo "$tap"; echo "FAIL no seatbelt tests ran"; exit 1; }
summary=$(echo "$tap" | awk '
  /^(not )?ok [0-9]+ - seatbelt:/ {
    name = $0; sub(/^(not )?ok [0-9]+ - /, "", name); sub(/ # SKIP.*/, "", name)
    verdict = ($1 == "ok" && $0 !~ /# SKIP/) ? "PASS" : "FAIL"
    print verdict " " name
  }')
echo "$summary"
count=$(echo "$summary" | grep -c . || true)
fails=$(echo "$summary" | grep -c '^FAIL' || true)
if [ "$count" -lt 11 ] || [ "$fails" -gt 0 ]; then
  echo "$tap" | grep -E '^ +(error|expected|actual|stack)' | head -40
  echo "SEATBELT VERIFY: FAIL ($fails failed, $count blocks seen, 11 expected)"; exit 1
fi
echo "SEATBELT VERIFY: PASS ($count blocks)"
