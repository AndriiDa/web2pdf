# Web2PDF — container image for the Docker/long-lived-server deployment path.
#
# Uses the official Playwright image, which already carries Chromium and every
# system library it needs. Building Chromium dependencies by hand on a slim base
# is a well-known source of silent font and codec failures, so we do not.
#
# Pin the Playwright image tag to the SAME version as the `playwright` package
# in package.json: a mismatch means the bundled browser and the client library
# disagree about the protocol.
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS base

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ---- Dependencies ----------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json* ./
# `--ignore-scripts` is deliberately NOT used: esbuild needs its postinstall.
RUN npm ci --no-audit --no-fund

# ---- Build -----------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=production
RUN npm run build

# ---- Runtime ---------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    BROWSER_MODE=local

# The Playwright image ships a non-root `pwuser`; run as it rather than root.
COPY --from=builder --chown=pwuser:pwuser /app/.next ./.next
COPY --from=builder --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --from=builder --chown=pwuser:pwuser /app/package.json ./package.json
COPY --from=builder --chown=pwuser:pwuser /app/public ./public

USER pwuser
EXPOSE 3000

# A conversion holds a Chromium process, so give the container room: 2 GB is a
# sensible floor for MAX_CONCURRENT_JOBS=2.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
