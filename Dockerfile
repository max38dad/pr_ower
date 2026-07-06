# ── Proxy Gateway Dockerfile ──
# Optimized for Bunny Magic Containers edge runtime.
# Single-stage, minimal, no memory flags (let Node.js auto-detect).

FROM node:20-alpine

WORKDIR /app

# Dependencies.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts 2>/dev/null || npm install --omit=dev --ignore-scripts

# Application code.
COPY src/ ./src/

# Runtime.
ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "src/index.js"]
