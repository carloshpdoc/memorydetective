#!/usr/bin/env bash
# memorydetective demo
# Runs through the headline scenarios so vhs can capture a GIF.

set -e

# Colors (ANSI). vhs records terminal escape codes faithfully.
B="\033[1m"
DIM="\033[2m"
CYAN="\033[36m"
GREEN="\033[32m"
RST="\033[0m"

step() { printf "\n${B}${CYAN}▶ %s${RST}\n" "$1"; }
note() { printf "${DIM}%s${RST}\n" "$1"; }

step "1. Run unit tests (61 tests across parsers + tools)"
npx vitest run 2>&1 | tail -8

step "2. Start MCP server, list registered tools"
note "Server speaks MCP over stdio. Sending initialize + tools/list..."
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

step "3. Classify cycles in a real memgraph (if available)"
MEMGRAPH="${MEMGRAPH:-$HOME/Desktop/example-leaks.memgraph}"
if [[ -f "$MEMGRAPH" ]]; then
  note "Calling classifyCycle against $MEMGRAPH"
  (
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"demo","version":"1.0"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"classifyCycle\",\"arguments\":{\"path\":\"$MEMGRAPH\",\"maxResults\":2}}}"
    sleep 30
  ) | node dist/index.js 2>/dev/null | grep '"id":2' | node -e "
const r = JSON.parse(require('fs').readFileSync(0,'utf8'));
const data = JSON.parse(r.result.content[0].text);
const G = '\x1b[32m', R = '\x1b[0m';
console.log(\`\\n  \${G}Total cycles: \${data.totalCycles}\${R}\`);
for (const c of data.classified) {
  const pm = c.primaryMatch;
  const root = c.rootClass.length > 60 ? c.rootClass.slice(0,57)+'...' : c.rootClass;
  console.log(\`    Root: \${root}\`);
  if (pm) {
    console.log(\`    Match: \${G}\${pm.patternId}\${R} (\${pm.confidence})\`);
    console.log(\`    Fix:  \${pm.fixHint.slice(0,90)}...\`);
  }
}
"
else
  note "No .memgraph at $MEMGRAPH — skipping live classification."
  note "(Run with MEMGRAPH=/path/to/your.memgraph ./scripts/demo.sh to see this step.)"
fi

printf "\n${B}${GREEN}✓ Done.${RST} GitHub: https://github.com/carloshpdoc/memorydetective\n\n"
