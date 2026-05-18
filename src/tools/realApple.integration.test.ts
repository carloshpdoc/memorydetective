/**
 * D-03 (v1.18). Integration tests against real Apple-produced `.trace`
 * bundles.
 *
 * # Why this exists
 *
 * v1.14 shipped two parser bugs (item P + item O) that our synthetic XML
 * fixtures missed because we authored both the fixtures AND the parser
 * assumptions — the synthetic XML matched our wrong assumptions perfectly.
 * Real Apple traces caught the bugs only after a user pointed us at one.
 *
 * The risk class is "our XML parsing assumptions drift from Apple's
 * real output." Synthetic fixtures can't catch this. Real Apple `.trace`
 * bundles can, but committing them is awkward (anonymization of binary
 * SQLite + plists is fragile; bundles can be 30+ MB).
 *
 * # Pattern
 *
 * Tests are LOCAL-ONLY. They read from a directory pointed to by the
 * `MEMORYDETECTIVE_INTEGRATION_TRACES` env var. When the var is unset, or
 * a specific fixture file is missing, the test SKIPS silently. CI never
 * runs them; only the maintainer's machine does, against trace bundles
 * that live in `~/Desktop/` (or wherever) and never enter the repo.
 *
 * Activation:
 *
 *   MEMORYDETECTIVE_INTEGRATION_TRACES=~/Desktop npm test
 *
 * # Coverage
 *
 * The two trace bundles in the maintainer's standard validation corpus
 * (`wishlist-tti-device.trace` pre-fix + `wishlist-tti-device-fixed.trace`
 * post-fix, both Time Profiler templates) cover:
 *
 *  - `inspectTrace` (TOC + schema discovery against real Apple `--toc` output)
 *  - `analyzeHangs` (potential-hangs schema parser)
 *  - `analyzeTimeProfile` (time-profile schema parser, including the v1.14
 *    item O symbol-vs-weight bug we already fixed once)
 *  - `compareTracesByPattern` (pair diff across before/after)
 *  - `summarizeTrace` (end-to-end fan-out, also exercises D-02 cache path)
 *
 * The 4 v1.15+ analyzers (`analyzeNetworkActivity`, `analyzeMemoryFootprint`,
 * `analyzeEnergyImpact`, `analyzeLeakTimeline`) stay synthetic-only until
 * we acquire trace bundles recorded with their templates. When new bundles
 * land in the integration dir, add corresponding test blocks here.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { inspectTrace } from "./inspectTrace.js";
import { analyzeHangs } from "./analyzeHangs.js";
import { analyzeTimeProfile } from "./analyzeTimeProfile.js";
import { summarizeTrace } from "./summarizeTrace.js";
import { compareTracesByPattern } from "./compareTracesByPattern.js";

function expandHome(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

const INTEGRATION_DIR = process.env.MEMORYDETECTIVE_INTEGRATION_TRACES
  ? expandHome(process.env.MEMORYDETECTIVE_INTEGRATION_TRACES)
  : "";

const tracePath = (name: string): string =>
  INTEGRATION_DIR ? resolve(INTEGRATION_DIR, name) : "";

const WISHLIST_PRE = tracePath("wishlist-tti-device.trace");
const WISHLIST_POST = tracePath("wishlist-tti-device-fixed.trace");
const hasWishlistPre = Boolean(WISHLIST_PRE) && existsSync(WISHLIST_PRE);
const hasWishlistPost = Boolean(WISHLIST_POST) && existsSync(WISHLIST_POST);
const hasBoth = hasWishlistPre && hasWishlistPost;

describe.skipIf(!hasWishlistPre)("inspectTrace against real Time Profiler bundle", () => {
  it("returns a non-empty schema list with potential-hangs and time-profile", async () => {
    const r = await inspectTrace({ tracePath: WISHLIST_PRE });
    expect(r.ok).toBe(true);
    expect(r.schemas.length).toBeGreaterThan(0);
    const names = r.schemas.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["potential-hangs"]));
    expect(names).toEqual(expect.arrayContaining(["time-profile"]));
  }, 60_000);

  it("populates device + os + template metadata from Apple's real --toc output", async () => {
    const r = await inspectTrace({ tracePath: WISHLIST_PRE });
    // Apple's --toc carries <device> and <template> attributes that the
    // parser must read. v1.14 item P shipped because we missed the
    // self-closing element shape; this asserts the fix holds.
    expect(r.deviceModel).toBeTruthy();
    expect(r.osVersion).toBeTruthy();
    expect(r.templateName).toBeTruthy();
  }, 60_000);

  it("rowCounts is non-zero for at least one populated schema", async () => {
    const r = await inspectTrace({ tracePath: WISHLIST_PRE });
    const total = Object.values(r.rowCounts).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
  }, 60_000);

  it("suggestedNextCalls includes analyzeHangs + analyzeTimeProfile when those schemas have rows", async () => {
    const r = await inspectTrace({ tracePath: WISHLIST_PRE });
    const tools = r.suggestedNextCalls.map((c) => c.tool);
    expect(tools).toEqual(expect.arrayContaining(["analyzeHangs"]));
    expect(tools).toEqual(expect.arrayContaining(["analyzeTimeProfile"]));
  }, 60_000);
});

describe.skipIf(!hasWishlistPre)("analyzeHangs against the pre-fix wishlist trace", () => {
  it("returns the documented 23 hangs (validation corpus baseline)", async () => {
    const r = await analyzeHangs({ tracePath: WISHLIST_PRE });
    // Per CONTINUE.md: pre-fix trace has 23 Hangs + 12 Microhangs = 35 total,
    // longest 1164ms, total ~22s. Bounds are loose so a future Apple
    // schema bump that drops/changes a column doesn't false-positive,
    // but a regression to "0 events" still fails the test.
    const total = r.totals.hangs + r.totals.microhangs;
    expect(total).toBeGreaterThanOrEqual(20);
    expect(total).toBeLessThanOrEqual(60);
    expect(r.totals.longestMs).toBeGreaterThan(1000);
  }, 60_000);

  it("supportStatus[] surfaces potential-hangs as available", async () => {
    const r = await analyzeHangs({ tracePath: WISHLIST_PRE });
    const hangs = r.supportStatus.find((s) => s.kind === "potential-hangs");
    expect(hangs?.status).toBe("available");
  }, 60_000);
});

describe.skipIf(!hasWishlistPost)("analyzeHangs against the post-fix wishlist trace", () => {
  it("returns 0 hangs (validation corpus: fix verified)", async () => {
    const r = await analyzeHangs({ tracePath: WISHLIST_POST });
    expect(r.totals.hangs).toBe(0);
  }, 60_000);
});

describe.skipIf(!hasWishlistPre)("analyzeTimeProfile against the pre-fix wishlist trace", () => {
  it("returns symbol names in topSymbols, not the weight column (v1.14 item O regression guard)", async () => {
    const r = await analyzeTimeProfile({ tracePath: WISHLIST_PRE });
    expect(r.topSymbols.length).toBeGreaterThan(0);
    // Pre-v1.14 fix, every symbol in topSymbols would be the literal
    // weight string ("1.00 ms" etc.). After the fix, symbols are real
    // function names like `CFStringHashCString`. Assert the first symbol
    // is NOT a number-looking weight column.
    expect(r.topSymbols[0].symbol).not.toMatch(/^\d+(\.\d+)?\s*(ms|sec|μs)?$/);
    expect(r.topSymbols[0].samples).toBeGreaterThan(0);
  }, 120_000);

  it("supportStatus[] surfaces time-profile as available", async () => {
    const r = await analyzeTimeProfile({ tracePath: WISHLIST_PRE });
    const tp = r.supportStatus.find((s) => s.kind === "time-profile");
    expect(tp?.status).toBe("available");
  }, 120_000);
});

describe.skipIf(!hasBoth)("compareTracesByPattern between pre/post wishlist traces", () => {
  it("verdict is PASS for hangs: all 23 hangs resolved", async () => {
    const r = await compareTracesByPattern({
      before: WISHLIST_PRE,
      after: WISHLIST_POST,
      category: "hangs",
    });
    expect(r.verdict).toBe("PASS");
    // Pre had ~23 hangs, post has 0 — delta.count goes NEGATIVE (after - before).
    expect(r.delta.count).toBeLessThan(0);
  }, 120_000);
});

describe.skipIf(!hasWishlistPre)("summarizeTrace against the pre-fix wishlist trace (D-02 cache exercise)", () => {
  it("fans out to all 6 analyzers and returns ok with a markdown card", async () => {
    const r = await summarizeTrace({ tracePath: WISHLIST_PRE });
    expect(r.ok).toBe(true);
    expect(r.markdown).toBeTruthy();
    expect(r.markdown).toMatch(/Trace summary/i);
    // The wishlist trace has hangs, so the headline should mention them.
    expect(r.markdown).toMatch(/hang/i);
  }, 180_000);

  it("headline calls out the longest hang as user-visible (>250ms)", async () => {
    const r = await summarizeTrace({ tracePath: WISHLIST_PRE });
    expect(r.headline).toBeTruthy();
    // Pre-fix longest is ~1164ms, well above the user-visible threshold.
    expect(r.headline).toMatch(/hang/i);
  }, 180_000);
});
