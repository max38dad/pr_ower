# ── Proxy Gateway Dockerfile ──
# Multi-stage build optimized for Bunny Magic Containers.
# Minimal image size, production hardening.

# ── Stage 1: Build / Dependencies ──
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files and install production deps only.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts 2>/dev/null || npm install --omit=dev --ignore-scripts

# ── Stage 2: Production Runtime ──
FROM node:20-alpine

# Install dumb-init for proper signal handling.
RUN apk add --no-cache dumb-init ca-certificates

# Create non-root user.
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

WORKDIR /app

# Copy node_modules from builder.
COPY --chown=nodejs:nodejs --from=builder /app/node_modules ./node_modules

# Copy application code.
COPY --chown=nodejs:nodejs package.json ./
COPY --chown=nodejs:nodejs src/ ./src/

# Security hardening.
RUN chmod -R 555 /app && chmod 755 /app

# Node.js runtime flags for edge performance:
#   --max-old-space-size=512  Limit heap to 512MB (Bunny containers typically have 1-2GB)
#   --optimize-for-size       Favor smaller code over compilation speed
#   --no-node-snapshot        Disable V8 snapshot (reduces startup mem, good for short-lived edge)
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=512 --optimize-for-size"

USER nodejs

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=2 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r => { if (r.status !== 200) process.exit(1) })" || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
