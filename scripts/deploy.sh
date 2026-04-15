#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

echo "Ensuring admin file manager storage is writable by the app user..."
mkdir -p "$ROOT_DIR/runtime/admin-files"
if ! chown -R 1001:1001 "$ROOT_DIR/runtime/admin-files" 2>/dev/null; then
  sudo chown -R 1001:1001 "$ROOT_DIR/runtime/admin-files"
fi
if ! chmod -R ug+rwX "$ROOT_DIR/runtime/admin-files" 2>/dev/null; then
  sudo chmod -R ug+rwX "$ROOT_DIR/runtime/admin-files"
fi

echo "Rebuilding and restarting TemcoTools app..."
docker compose -f docker-compose.yml up -d --build --no-deps app

echo "Current container status:"
docker compose -f docker-compose.yml ps
