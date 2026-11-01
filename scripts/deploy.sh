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

temco_deploy_v2=false
if [[ -f prisma/migrations/20261101020000_strong_identity_sessions/migration.sql ]]; then
  temco_deploy_v2=true
  if [[ -z "${TEMCO_V2_EXPECT_DATABASE:-}" ]]; then
    echo "TemcoTools v2 requires the reviewed maintenance/enrollment procedure in docs/v2/cutover-runbook.md." >&2
    echo "This shortcut accepts only an already migrated/enrolled target, explicitly named by TEMCO_V2_EXPECT_DATABASE." >&2
    exit 1
  fi
  if [[ ! -d "$ROOT_DIR/runtime/admin-files" ]] || [[ -L "$ROOT_DIR/runtime/admin-files" ]]; then
    echo "Prepare and verify the existing managed-file volume during the manual cutover before using this shortcut." >&2
    exit 1
  fi
fi

echo "Building the published app and database migration images..."
if [[ "$temco_deploy_v2" == true ]]; then
  docker compose -f docker-compose.yml --profile mcp-http build app migrate mcp-http
  if [[ "$(docker image inspect temcotools-mcp --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" != "$VCS_REF" ]]; then
    echo "Refusing an MCP image with an unexpected revision." >&2
    exit 1
  fi
  echo "Checking v2 schema, identity, recovery and durable-effect readiness before any restart..."
  # Host maintenance inspection, never a delegated application identity. This
  # deliberately blocks first cutover and future unapplied schema changes.
  docker compose -f docker-compose.yml --profile mcp-http run --rm --no-deps -T \
    --entrypoint node mcp-http --import tsx scripts/v2-preflight.ts \
    --expect-database "$TEMCO_V2_EXPECT_DATABASE" --allow-operational-target --phase launch
else
  docker compose -f docker-compose.yml build app migrate
fi
for image in temcotools-app temcotools-migrate; do
  if [[ "$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" != "$VCS_REF" ]] ||
     [[ "$(docker image inspect "$image" --format '{{index .Config.Labels "com.temcotools.production-eligible"}}')" != "true" ]] ||
     [[ "$(docker image inspect "$image" --format '{{index .Config.Labels "com.temcotools.deployment-role"}}')" != "production" ]]; then
    echo "Refusing an image with an unexpected revision or deployment role: $image" >&2
    exit 1
  fi
done

echo "Ensuring admin file manager storage is writable by the app user..."
mkdir -p "$ROOT_DIR/runtime/admin-files"
if ! chown -R 1001:1001 "$ROOT_DIR/runtime/admin-files" 2>/dev/null; then
  sudo chown -R 1001:1001 "$ROOT_DIR/runtime/admin-files"
fi
if ! chmod -R ug+rwX "$ROOT_DIR/runtime/admin-files" 2>/dev/null; then
  sudo chmod -R ug+rwX "$ROOT_DIR/runtime/admin-files"
fi

echo "Applying database migrations before restarting the app..."
docker compose -f docker-compose.yml run --rm --no-deps -T migrate

echo "Restarting TemcoTools app..."
docker compose -f docker-compose.yml up -d --no-deps --wait --wait-timeout 120 app
docker compose -f docker-compose.yml up -d --no-deps --wait --wait-timeout 120 label-relay
docker compose -f docker-compose.yml up -d --no-deps --wait --wait-timeout 120 api-relay
if [[ "$temco_deploy_v2" == true ]]; then
  docker compose -f docker-compose.yml --profile mcp-http up -d --no-deps --wait --wait-timeout 120 mcp-http
fi

echo "Current container status:"
docker compose -f docker-compose.yml ps
