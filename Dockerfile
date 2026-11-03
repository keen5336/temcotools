# Dockerfile for Next.js
FROM node:24-alpine AS base

# Install dependencies only when needed
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Install dependencies based on the preferred package manager
COPY package.json package-lock.json* ./
RUN npm ci

# Scanner assets are pinned/lazy browser runtimes, prepared independently from
# the application dependency graph. No recognition service or global headers.
FROM base AS scan-assets
WORKDIR /app
COPY scripts/scan-lab/runtime-package.json /opt/temcoscan/package.json
COPY scripts/scan-lab/runtime-package-lock.json /opt/temcoscan/package-lock.json
RUN npm ci --prefix /opt/temcoscan --no-audit --no-fund
COPY scripts/scan-lab-prepare.mjs ./scripts/scan-lab-prepare.mjs
COPY scripts/scan-lab ./scripts/scan-lab
COPY lib/scan-lab/runtime ./lib/scan-lab/runtime
COPY public/scan-lab/licenses ./public/scan-lab/licenses
RUN SCAN_LAB_SANDBOX=/opt/temcoscan node scripts/scan-lab-prepare.mjs

# Rebuild the source code only when needed
FROM deps AS builder
WORKDIR /app
COPY . .
COPY --from=scan-assets /app/public/scan-lab/vendor ./public/scan-lab/vendor

RUN npx prisma generate
RUN npm run build

# Dedicated migration image uses the pinned Prisma CLI from package-lock.json.
FROM deps AS migrator
WORKDIR /app
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/keen5336/temcotools" \
      org.opencontainers.image.revision=$VCS_REF \
      com.temcotools.deployment-role="production" \
      com.temcotools.workload-class="database-migration" \
      com.temcotools.production-eligible="true"
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
USER node
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/keen5336/temcotools" \
      org.opencontainers.image.revision=$VCS_REF \
      com.temcotools.deployment-role="production" \
      com.temcotools.workload-class="warehouse-app" \
      com.temcotools.production-eligible="true"

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 --ingroup nodejs nextjs

# Copy runtime files needed by the standalone Next server
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts

# Set the correct permission for prerender cache
RUN mkdir .next
RUN chown nextjs:nodejs .next

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/node_modules/ws ./node_modules/ws

USER nextjs:nodejs

EXPOSE 3000

ENV PORT=3000
# set hostname to localhost
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
