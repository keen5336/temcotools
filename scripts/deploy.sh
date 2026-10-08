#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

if [[ -n "$(git status --porcelain)" ]] || [[ "$(git branch --show-current)" != "main" ]]; then
  echo "Deploy requires a clean main branch." >&2
  exit 1
fi
git fetch origin main
export VCS_REF="$(git rev-parse HEAD)"
if [[ "$VCS_REF" != "$(git rev-parse origin/main)" ]]; then
  echo "Deploy requires the published origin/main revision." >&2
  exit 1
fi

echo "Ensuring admin file manager storage is writable by the app user..."
mkdir -p "$ROOT_DIR/runtime/admin-files"
if ! chown -R 1001:1001 "$ROOT_DIR/runtime/admin-files" 2>/dev/null; then
  sudo chown -R 1001:1001 "$ROOT_DIR/runtime/admin-files"
fi
if ! chmod -R ug+rwX "$ROOT_DIR/runtime/admin-files" 2>/dev/null; then
  sudo chmod -R ug+rwX "$ROOT_DIR/runtime/admin-files"
fi

echo "Building the published app and database migration images..."
docker compose -f docker-compose.yml build app migrate
for image in temcotools-app temcotools-migrate; do
  if [[ "$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" != "$VCS_REF" ]] ||
     [[ "$(docker image inspect "$image" --format '{{index .Config.Labels "com.temcotools.production-eligible"}}')" != "true" ]] ||
     [[ "$(docker image inspect "$image" --format '{{index .Config.Labels "com.temcotools.deployment-role"}}')" != "production" ]]; then
    echo "Refusing an image with an unexpected revision or deployment role: $image" >&2
    exit 1
  fi
done

echo "Applying database migrations before restarting the app..."
docker compose -f docker-compose.yml run --rm --no-deps -T migrate

echo "Restarting TemcoTools app..."
docker compose -f docker-compose.yml up -d --no-deps --wait --wait-timeout 120 app
docker compose -f docker-compose.yml up -d --no-deps --wait --wait-timeout 120 label-relay

echo "Current container status:"
docker compose -f docker-compose.yml ps
