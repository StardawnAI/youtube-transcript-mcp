#!/usr/bin/env bash
# Starts a free Cloudflare WARP proxy container next to an existing n8n
# container, so n8n can reach YouTube through Cloudflare's network.
# Run it on the machine where n8n runs in Docker.
#
#   ./install-warp.sh                 # finds the n8n container automatically
#   ./install-warp.sh my-n8n          # or name it
#   WARP_NAME=warp2 ./install-warp.sh # different container name → proxy http://warp2:1080
#
# Needs no Cloudflare account. The proxy is only reachable from the Docker
# network(s) n8n is on; no port is published on the host.
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash on Windows: keep container paths as they are

WARP_NAME="${WARP_NAME:-warp}"
WARP_IMAGE="${WARP_IMAGE:-caomingjun/warp:latest}"
FALLBACK_NETWORK="${FALLBACK_NETWORK:-n8n-warp}"
N8N_CONTAINER="${1:-}"

die() { echo "✗ $*" >&2; exit 1; }
ok()  { echo "  ✓ $*"; }

command -v docker >/dev/null || die "docker not found"
docker info >/dev/null 2>&1 || die "cannot talk to Docker (try sudo)"

# 1. Find the n8n container
if [ -z "$N8N_CONTAINER" ]; then
  candidates=$(docker ps --format '{{.Names}} {{.Image}}' | awk 'tolower($2) ~ /n8n/ {print $1}')
  count=$(printf '%s\n' "$candidates" | grep -c . || true)
  [ "$count" -eq 0 ] && die "no running n8n container found — pass its name: $0 <container>"
  [ "$count" -gt 1 ] && die "several n8n containers found, pass one: $0 <container>"$'\n'"$candidates"
  N8N_CONTAINER="$candidates"
fi
docker inspect "$N8N_CONTAINER" >/dev/null 2>&1 || die "container '$N8N_CONTAINER' not found"
echo "▸ n8n container: $N8N_CONTAINER"

# 2. Docker networks shared with n8n. Name-based DNS (warp → IP) only works on
#    user-defined networks, so n8n on the default bridge gets one extra network.
networks=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$N8N_CONTAINER")
targets=()
for net in $networks; do
  case "$net" in bridge|host|none) ;; *) targets+=("$net") ;; esac
done
if [ "${#targets[@]}" -eq 0 ]; then
  echo "▸ n8n is only on the default bridge network; adding network '$FALLBACK_NETWORK'"
  docker network inspect "$FALLBACK_NETWORK" >/dev/null 2>&1 || docker network create "$FALLBACK_NETWORK" >/dev/null
  docker network connect "$FALLBACK_NETWORK" "$N8N_CONTAINER" 2>/dev/null || true
  targets=("$FALLBACK_NETWORK")
fi

# 3. Start WARP (or reuse an existing container with that name)
if docker inspect "$WARP_NAME" >/dev/null 2>&1; then
  echo "▸ container '$WARP_NAME' exists, reusing it"
  docker start "$WARP_NAME" >/dev/null
else
  echo "▸ starting $WARP_IMAGE as '$WARP_NAME'"
  docker run -d --name "$WARP_NAME" --restart unless-stopped \
    --network "${targets[0]}" \
    --device-cgroup-rule 'c 10:200 rwm' \
    --cap-add MKNOD --cap-add AUDIT_WRITE --cap-add NET_ADMIN \
    --sysctl net.ipv6.conf.all.disable_ipv6=0 \
    --sysctl net.ipv4.conf.all.src_valid_mark=1 \
    -e WARP_SLEEP=2 \
    -v "${WARP_NAME}-data:/var/lib/cloudflare-warp" \
    "$WARP_IMAGE" >/dev/null
fi
for net in "${targets[@]}"; do
  docker network connect "$net" "$WARP_NAME" 2>/dev/null || true
done
ok "attached to network(s): ${targets[*]}"

# 4. Wait until WARP is connected
echo "▸ waiting for the WARP tunnel (up to 90 s)"
for _ in $(seq 1 45); do
  trace=$(docker exec "$WARP_NAME" curl -fsS --max-time 5 -x http://127.0.0.1:1080 \
    https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null || true)
  if printf '%s' "$trace" | grep -Eq '^warp=(on|plus)'; then
    ok "WARP connected (exit IP $(printf '%s' "$trace" | sed -n 's/^ip=//p'))"
    break
  fi
  sleep 2
done
printf '%s' "${trace:-}" | grep -Eq '^warp=(on|plus)' || die "WARP did not connect — check: docker logs $WARP_NAME"

# 5. Check that n8n can reach the proxy by name
if docker exec "$N8N_CONTAINER" node -e "require('net').connect(1080,'$WARP_NAME').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; then
  ok "n8n reaches the proxy"
else
  die "n8n cannot reach $WARP_NAME:1080 — are both containers on the same Docker network?"
fi

echo
echo "Proxy URL for n8n: http://$WARP_NAME:1080"
[ "$WARP_NAME" = "warp" ] || echo "Run setup with: --proxy http://$WARP_NAME:1080"
