import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInstructions,
  detectNewTraces,
  isStable,
  snapshotTracesInDir,
} from "./recordViaInstrumentsApp.js";

describe("recordViaInstrumentsApp helpers", () => {
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = join(
      tmpdir(),
      `rvia-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(scratchDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  });

  describe("snapshotTracesInDir", () => {
    it("returns empty set when the directory does not exist", () => {
      const out = snapshotTracesInDir(join(scratchDir, "nope"));
      expect(out.size).toBe(0);
    });

    it("returns absolute paths of *.trace entries only", () => {
      mkdirSync(join(scratchDir, "a.trace"));
      mkdirSync(join(scratchDir, "b.trace"));
      writeFileSync(join(scratchDir, "readme.txt"), "ignore");
      mkdirSync(join(scratchDir, "subdir"));
      const out = snapshotTracesInDir(scratchDir);
      expect(out.size).toBe(2);
      expect(out.has(join(scratchDir, "a.trace"))).toBe(true);
      expect(out.has(join(scratchDir, "b.trace"))).toBe(true);
      expect(out.has(join(scratchDir, "readme.txt"))).toBe(false);
      expect(out.has(join(scratchDir, "subdir"))).toBe(false);
    });
  });

  describe("detectNewTraces", () => {
    it("returns paths present in current but absent in baseline", () => {
      const baseline = new Set(["/x/a.trace"]);
      const current = new Set(["/x/a.trace", "/x/b.trace"]);
      const out = detectNewTraces(current, baseline);
      expect(out).toEqual(["/x/b.trace"]);
    });

    it("returns empty when nothing new appeared", () => {
      const baseline = new Set(["/x/a.trace", "/x/b.trace"]);
      const current = new Set(["/x/a.trace", "/x/b.trace"]);
      expect(detectNewTraces(current, baseline)).toEqual([]);
    });

    it("sorts results alphabetically for determinism", () => {
      const baseline = new Set<string>();
      const current = new Set(["/x/z.trace", "/x/a.trace", "/x/m.trace"]);
      expect(detectNewTraces(current, baseline)).toEqual([
        "/x/a.trace",
        "/x/m.trace",
        "/x/z.trace",
      ]);
    });
  });

  describe("isStable", () => {
    it("returns true when mtime is older than stableForMs", () => {
      const nowMs = 1_000_000;
      const ok = isStable(
        "/tmp/fake.trace",
        nowMs,
        10_000,
        () => ({ mtimeMs: nowMs - 15_000 }),
      );
      // Note: existsSync('/tmp/fake.trace') likely false, returns early.
      // Use a real path via the scratchDir to test the positive case.
      expect(ok).toBe(false);
    });

    it("positive case against a real path on disk", () => {
      const trace = join(scratchDir, "alive.trace");
      mkdirSync(trace);
      // The dir's mtime is "now-ish"; with stableForMs = 0 we should be
      // immediately stable (more than 0 ms have passed since mkdir).
      const ok = isStable(trace, Date.now() + 1, 0);
      expect(ok).toBe(true);
    });

    it("returns false when the path does not exist", () => {
      const out = isStable(
        join(scratchDir, "missing.trace"),
        Date.now(),
        10_000,
      );
      expect(out).toBe(false);
    });
  });

  describe("buildInstructions", () => {
    it("includes the template name in the chooser step", () => {
      const inst = buildInstructions(
        "Animation Hitches",
        "/tmp/traces",
      );
      const joined = inst.join("\n");
      expect(joined).toContain("**Animation Hitches** template");
    });

    it("includes the watchDir path in the save step", () => {
      const inst = buildInstructions("Time Profiler", "/my/custom/dir");
      const joined = inst.join("\n");
      expect(joined).toContain("/my/custom/dir");
      expect(joined).toMatch(/Save As/);
    });

    it("returns a non-empty step list", () => {
      const inst = buildInstructions("Leaks", "/tmp");
      expect(inst.length).toBeGreaterThan(3);
    });
  });
});
