#!/usr/bin/env bash
set -e

CONTAINER_NAME="orion"
IMAGE_NAME="orion:latest"

echo "=== Starting ORION Demo Container ==="
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

REPO_LOWER=$(echo "${GITHUB_REPOSITORY:-al3xutul02/orion}" | tr '[:upper:]' '[:lower:]')
GHCR_IMAGE="ghcr.io/${REPO_LOWER}:latest"

if docker pull "$GHCR_IMAGE" 2>/dev/null; then
  echo "[+] Using pre-built image from GHCR: $GHCR_IMAGE"
  IMAGE_TO_RUN="$GHCR_IMAGE"
else
  echo "[+] GHCR image not found or not public yet, building locally..."
  docker build -t "$IMAGE_NAME" .
  IMAGE_TO_RUN="$IMAGE_NAME"
fi

echo "[+] Starting container..."
docker run -d \
  --name "$CONTAINER_NAME" \
  -p 4200:4200 \
  -p 8000:8000 \
  -v orion-data:/var/lib/mysql \
  "$IMAGE_TO_RUN"

echo "=== ORION is now running on port 4200! ==="
