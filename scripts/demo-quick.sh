#!/usr/bin/env bash
# Trimmed demo for the README GIF — runs in <15s.
# For the full demo (including a live classifyCycle), see ./demo.sh.

set -e

B="\033[1m"
DIM="\033[2m"
CYAN="\033[36m"
GREEN="\033[32m"
RST="\033[0m"

step() { printf "\n${B}${CYAN}▶ %s${RST}\n" "$1"; }
note() { printf "${DIM}%s${RST}\n" "$1"; }

step "1. Run unit tests"
npx vitest run 2>&1 | tail -6

step "2. Start MCP server, list registered tools"
note "Server speaks MCP over stdio."
(
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"demo","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  sleep 1
) | node dist/index.js 2>/dev/null | grep '"id":2' | node -e "
const r = JSON.parse(require('fs').readFileSync(0,'utf8'));
const tools = r.result.tools;
const G = '\x1b[32m', R = '\x1b[0m';
console.log(\`\\n  \${G}\${tools.length} tools registered:\${R}\`);
for (const t of tools) console.log(\`    • \${t.name}\`);
"

printf "\n${B}${GREEN}✓ Done.${RST} For the full demo (live classifyCycle): ./scripts/demo.sh\n\n"
