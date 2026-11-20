#!/usr/bin/env bash
# Push a small, varied set of test images into the dev registry:
#   - several tags sharing one digest (collateral-delete warning)
#   - a different image under another tag (keep-newest-N)
#   - nested repositories ("tools" and "tools/busybox")
#   - a multi-arch image index
# Re-runnable.
set -euo pipefail
REG="${REG:-127.0.0.1:5055}"

docker pull -q busybox:latest >/dev/null
docker pull -q alpine:3.20 >/dev/null

push() { # src dst
  docker tag "$1" "$REG/$2"
  docker push -q "$REG/$2" >/dev/null
  docker rmi "$REG/$2" >/dev/null
  echo "pushed $2"
}

for t in 1.0 1.1 latest; do push busybox:latest "tools/busybox:$t"; done
push alpine:3.20 tools/busybox:old
push busybox:latest tools:1
push alpine:3.20 alpine:3.20
push alpine:3.20 alpine:stable
push busybox:latest apps/demo:dev

# multi-arch index (copies all platforms from Docker Hub)
if docker buildx version >/dev/null 2>&1; then
  docker buildx imagetools create -t "$REG/multi/alpine:3.20" alpine:3.20 >/dev/null 2>&1 \
    && echo "pushed multi/alpine:3.20 (multi-arch)"
fi
