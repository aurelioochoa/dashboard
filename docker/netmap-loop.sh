#!/bin/sh
# ============================================================
# netmap sidecar loop.
#
# netmap is a one-shot CLI, so this wraps it in a scan loop and
# publishes the result on a volume the dashboard backend reads.
#
# The sidecar is a separate container on purpose: netmap needs
# NET_RAW/NET_ADMIN and the host network namespace to run
# arp-scan/nmap/traceroute, and the backend must not have those.
# The two never talk directly — they share a directory.
#
#   graph.json   the current topology (written atomically)
#   .scanning    present while a scan is running
#   .scan-now    touched by the backend to request a scan now
# ============================================================
set -eu

TARGET="${NETMAP_TARGET:-192.168.1.0/24}"
DATA_DIR="${NETMAP_DATA_DIR:-/data}"
# Default to hourly: an nmap sweep is noisy on the LAN, and the
# dashboard's "Escanear ahora" button covers the impatient case.
INTERVAL="${NETMAP_INTERVAL:-3600}"
EXTRA_ARGS="${NETMAP_ARGS:-}"

GRAPH="$DATA_DIR/graph.json"
# netmap picks its output format from the file EXTENSION (see its
# main.rs), so the temp file has to end in .json too — "graph.json.tmp"
# is rejected as an unknown format and silently writes nothing.
GRAPH_TMP="$DATA_DIR/graph.tmp.json"
LOCK="$DATA_DIR/.scanning"
TRIGGER="$DATA_DIR/.scan-now"

mkdir -p "$DATA_DIR"
# A lock left behind by a killed container would show "scanning" forever.
rm -f "$LOCK"

log() { echo "[netmap-loop] $*" >&2; }

scan() {
  log "scanning $TARGET"
  : > "$LOCK"

  # Write to a temp file and rename, so the backend never reads a
  # half-written graph. `|| true` because a scan that finds nothing
  # (or a transient backend failure) must not kill the loop.
  if netmap scan "$TARGET" --no-tui --output "$GRAPH_TMP" $EXTRA_ARGS >/dev/null; then
    if [ -s "$GRAPH_TMP" ]; then
      mv "$GRAPH_TMP" "$GRAPH"
      log "wrote $GRAPH"
    else
      log "scan produced no output, keeping previous graph"
      rm -f "$GRAPH_TMP"
    fi
  else
    log "scan failed, keeping previous graph"
    rm -f "$GRAPH_TMP"
  fi

  rm -f "$LOCK"
}

trap 'rm -f "$LOCK"; exit 0' TERM INT

log "starting: target=$TARGET interval=${INTERVAL}s"
scan

while :; do
  # Sleep in 1s slices so a trigger file is noticed promptly rather
  # than at the end of a long interval.
  waited=0
  while [ "$waited" -lt "$INTERVAL" ]; do
    if [ -f "$TRIGGER" ]; then
      rm -f "$TRIGGER"
      log "scan requested by dashboard"
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  scan
done
