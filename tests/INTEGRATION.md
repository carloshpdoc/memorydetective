# Integration tests against real Apple `.trace` bundles

> **D-03 (v1.18).** Local-only validation that our parsers match the
> real-world output of `xcrun xctrace export` against Apple-produced
> trace bundles. Closes the gap that v1.14 items P + O exposed (synthetic
> XML fixtures matching our own wrong assumptions).

## Why this exists

The synthetic XML fixtures under `tests/fixtures/example-*.xml` cover the
parser logic deterministically, but they all match assumptions we made
ourselves while writing the parsers. When Apple drifts the `.trace` schema
across Xcode majors (or when our assumptions are simply wrong, like the
v1.14 item P xpath bug), synthetic tests pass and real users hit the
regression in production.

These integration tests run our parsers against **real `.trace` bundles
recorded by `xcrun xctrace record` or Instruments.app**. They catch
schema drift the day you rerun them, instead of months later via a
GitHub issue.

## Activation

```bash
MEMORYDETECTIVE_INTEGRATION_TRACES=~/Desktop npm test
```

The env var points at a directory containing the named fixture files
listed below. When the var is unset OR a specific fixture is missing,
the corresponding describe block skips silently (`describe.skipIf`).
CI runs always have the var unset, so CI is never affected.

## Expected fixtures

| Filename | Recorded with | Asserted behavior |
|---|---|---|
| `wishlist-tti-device.trace` | Time Profiler, attach mode, ~90s recording, physical device, pre-fix code | 23 hangs (20-60 tolerance), longest > 1000ms, time-profile populated with real symbol names |
| `wishlist-tti-device-fixed.trace` | Same template, post-fix code | 0 hangs (`totals.hangs === 0`) |

The wishlist pair is the maintainer's canonical validation corpus,
documented in `~/Desktop/internal/CONTINUE.md`. Anyone running the
integration suite needs to either:

1. Use the maintainer's existing traces (private to that machine), OR
2. Record their own pair against any app with a comparable scenario (a
   hang you can fix), name them with the same filenames, drop in the
   integration dir.

## Coverage

Today the corpus covers:

- `inspectTrace` — TOC parsing + device/OS/template extraction + row-count
  population + suggestedNextCalls suggestions against a real bundle.
- `analyzeHangs` — potential-hangs schema parsing on both pre- and
  post-fix traces (asserts that the fix produces 0 hangs).
- `analyzeTimeProfile` — top-symbol parsing on the v1.14 item O regression
  guard (symbols must be real function names, not the weight column).
- `compareTracesByPattern` — pre/post diff verdict.
- `summarizeTrace` — end-to-end fan-out across 6 analyzers, exercises
  the v1.18 D-02 schema-discovery cache in the wild.

Gaps (deferred until matching fixtures exist):

- `analyzeNetworkActivity` — needs a Network template recording.
- `analyzeMemoryFootprint` — needs a Memory Allocations template.
- `analyzeEnergyImpact` — needs an Energy Log template.
- `analyzeLeakTimeline` — needs a Leaks template.

Add new tests to `src/tools/realApple.integration.test.ts` when the
corresponding fixtures land in your integration dir.

## Timeouts

`xctrace export` is slow against large bundles (a 37 MB time-profile
trace takes 7-15s per analyzer call). Each integration test sets a
per-test timeout (60-180s depending on how many analyzer chains it
fires). If your machine is slower, bump the third positional argument
to `it()` for the affected test.

## Adding a new fixture

1. Record fresh against an app you own (do NOT commit real client traces
   to the public repo — these live LOCAL to your machine, never in git).
2. Drop the `.trace` bundle into your `MEMORYDETECTIVE_INTEGRATION_TRACES`
   directory.
3. Add a `describe.skipIf(!hasYourFixture)(...)` block to
   `src/tools/realApple.integration.test.ts` referencing it by name.
4. Run with `MEMORYDETECTIVE_INTEGRATION_TRACES=... npm test` to confirm
   the new block runs and asserts what you expect.

## Why we do NOT ship fixtures with the repo

A real `.trace` bundle is 30 MB+ and can leak process names, bundle ids,
symbol names from the recorded app's binary, and sometimes file paths.
Anonymizing one in place is fragile (Core Data SQLite + binary plists +
Apple-private schema that shifts between Xcode versions; no public
redaction tool). The pragmatic choice for a solo-maintainer project: keep
fixtures LOCAL to the maintainer's machine, version them on the disk
where they live, skip gracefully everywhere else.
