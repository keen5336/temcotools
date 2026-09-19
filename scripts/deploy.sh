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

echo "Rebuilding and restarting TemcoTools app..."
docker compose -f docker-compose.yml up -d --build --no-deps --wait --wait-timeout 120 app
docker compose -f docker-compose.yml up -d --no-deps --wait --wait-timeout 120 label-relay

echo "Current container status:"
docker compose -f docker-compose.yml ps
