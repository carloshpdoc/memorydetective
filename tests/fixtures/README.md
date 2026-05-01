# Fixtures

Snapshots of real `leaks(1)` output captured from DemoApp iOS during the leak-fix-001 investigation. Truncated to ~200 lines each for the repo (full outputs are 60k+ lines and ~6MB).

| File | Source | Notes |
|---|---|---|
| `example-leaks.head.leaks.txt` | `example-leaks.memgraph` (pre-fix) | 60k leaks total, full SavedItems place-details retain cycle (TagIndexProjection → DetailViewModel) is in the first ~50 lines |
| `example-fix.head.leaks.txt` | `example-leaks-fix2.memgraph` (post-fix) | 55k leaks total — but the app-specific DetailViewModel cycle is gone. Remaining cycles are SwiftUI internals that always show up |

## Regenerating

```bash
leaks ~/Desktop/example-leaks.memgraph 2>&1 | head -200 > tests/fixtures/example-leaks.head.leaks.txt
leaks ~/Desktop/example-leaks-fix2.memgraph 2>&1 | head -200 > tests/fixtures/example-fix.head.leaks.txt
```

Original `.memgraph` files are not committed (~30MB binary each). They live at `~/Desktop/` on the maintainer's machine. End-to-end tests against real graphs are gated by an env var:

```bash
MEMGRAPH_DIR=~/Desktop npm test
```

## About `leaks(1)` exit code

`leaks` exits with code `1` when leaks are found, `0` when clean. **This is normal**, not an error. The MCP tool treats both as success and reports the leak status to the caller.
