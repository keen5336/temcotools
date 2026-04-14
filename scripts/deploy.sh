#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

echo "Rebuilding and restarting TemcoTools app..."
docker compose -f docker-compose.yml up -d --build --no-deps app

echo "Current container status:"
docker compose -f docker-compose.yml ps
