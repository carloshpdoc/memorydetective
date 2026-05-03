# Multi-stage build for the memorydetective MCP server.
#
# This image is intended for sandbox introspection only (Glama / awesome-mcp-servers
# automated checks). The server starts cleanly on Linux and responds to MCP
# tools/list, resources/list, and prompts/list requests, but the actual tool
# implementations require macOS-only binaries (`leaks(1)`, `xcrun xctrace`,
# `xcrun sourcekit-lsp`). On Linux, attempting to invoke a tool will return a
# structured error rather than a panic.
#
# For real use, install via npm on macOS:  `npm install -g memorydetective`

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: build
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# Install full deps (incl. dev) for the TypeScript build.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Compile TypeScript -> dist/.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: runtime
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

# Production-only deps (skip TS, vitest, tsx).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && \
    npm cache clean --force

# Bring in the compiled binary.
COPY --from=build /app/dist ./dist

# stdio MCP server. The container reads MCP JSON-RPC frames from stdin and
# writes responses to stdout. No HTTP, no listening port.
ENTRYPOINT ["node", "dist/index.js"]
