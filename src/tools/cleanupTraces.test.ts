import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { cleanupTraces, isInsideTraceRoot } from "./cleanupTraces.js";

const ORIGINAL_ENV = { ...process.env };

let workDir: string;

function makeFakeTraceBundle(
  parent: string,
  name: string,
  contentBytes: number,
  ageDays: number,
): string {
  const bundle = joinPath(parent, name);
  mkdirSync(bundle, { recursive: true });
  // Add a synthetic Run1 directory + payload file to mimic xctrace.
  const runDir = joinPath(bundle, "Run1");
  mkdirSync(runDir);
  writeFileSync(joinPath(runDir, "trace.bin"), Buffer.alloc(contentBytes));
  if (ageDays > 0) {
    const mtime = new Date(Date.now() - ageDays * 86_400_000);
    utimesSync(bundle, mtime, mtime);
    utimesSync(runDir, mtime, mtime);
    utimesSync(joinPath(runDir, "trace.bin"), mtime, mtime);
  }
  return bundle;
}

describe("isInsideTraceRoot", () => {
  it("returns true when candidate is the root itself", () => {
    expect(isInsideTraceRoot("/Users/a/traces", "/Users/a/traces")).toBe(true);
  });

  it("returns true for paths strictly inside the root", () => {
    expect(
      isInsideTraceRoot("/Users/a/traces/run1.trace", "/Users/a/traces"),
    ).toBe(true);
  });

  it("returns false for sibling paths that share a prefix string", () => {
    // "/Users/a/traces2" starts with "/Users/a/traces" textually but is
    // a different directory; the separator check must reject it.
    expect(
      isInsideTraceRoot("/Users/a/traces2/run1.trace", "/Users/a/traces"),
    ).toBe(false);
  });

  it("returns false for paths outside the root", () => {
    expect(isInsideTraceRoot("/tmp/elsewhere.trace", "/Users/a/traces")).toBe(
      false,
    );
  });
});

describe("cleanupTraces", () => {
  beforeEach(() => {
    workDir = mkdtempSync(joinPath(tmpdir(), "mdt-cleanup-test-"));
    // Pin TRACE_ROOT to the test workDir so the tool's defaults align with
    // where we are creating fake bundles. ALLOW_EXTERNAL_CLEANUP unset.
    process.env.MEMORYDETECTIVE_TRACE_ROOT = workDir;
    delete process.env.MEMORYDETECTIVE_ALLOW_EXTERNAL_CLEANUP;
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns empty candidates when the root has no traces", () => {
    const r = cleanupTraces({ dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.candidates).toHaveLength(0);
    expect(r.deleted).toBe(0);
  });

  it("finds .trace bundles directly under root", () => {
    makeFakeTraceBundle(workDir, "run1.trace", 1024 * 1024, 5);
    makeFakeTraceBundle(workDir, "run2.trace", 2 * 1024 * 1024, 1);
    const r = cleanupTraces({ dryRun: true });
    expect(r.candidates).toHaveLength(2);
    // Sorted by age desc (oldest first).
    expect(r.candidates[0].path).toContain("run1.trace");
    expect(r.candidates[0].ageDays).toBeGreaterThanOrEqual(5);
    expect(r.candidates[1].ageDays).toBeLessThan(r.candidates[0].ageDays);
  });

  it("respects olderThanDays filter", () => {
    makeFakeTraceBundle(workDir, "fresh.trace", 1024, 0);
    makeFakeTraceBundle(workDir, "stale.trace", 1024, 7);
    const r = cleanupTraces({ dryRun: true, olderThanDays: 3 });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].path).toContain("stale.trace");
  });

  it("descends into nested subdirectories", () => {
    const subDir = joinPath(workDir, "sub", "nested");
    mkdirSync(subDir, { recursive: true });
    makeFakeTraceBundle(subDir, "deep.trace", 1024, 2);
    const r = cleanupTraces({ dryRun: true });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].path).toContain("deep.trace");
  });

  it("does NOT descend into .trace bundles (stops at boundary)", () => {
    // Create a .trace bundle with another .trace-named directory INSIDE
    // it. The tool must NOT recurse into the outer bundle.
    const outer = makeFakeTraceBundle(workDir, "outer.trace", 1024, 1);
    mkdirSync(joinPath(outer, "inner.trace"));
    const r = cleanupTraces({ dryRun: true });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].path).toContain("outer.trace");
    expect(r.candidates[0].path).not.toContain("inner.trace");
  });

  it("dryRun preserves files on disk", () => {
    const b = makeFakeTraceBundle(workDir, "run.trace", 1024, 1);
    const r = cleanupTraces({ dryRun: true });
    expect(r.deleted).toBe(0);
    expect(r.freedMB).toBe(0);
    expect(existsSync(b)).toBe(true);
  });

  it("dryRun=false actually deletes the bundles", () => {
    const a = makeFakeTraceBundle(workDir, "a.trace", 1024 * 1024, 1);
    const b = makeFakeTraceBundle(workDir, "b.trace", 2 * 1024 * 1024, 2);
    const r = cleanupTraces({ dryRun: false });
    expect(r.deleted).toBe(2);
    expect(r.freedMB).toBeGreaterThan(0);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
  });

  it("rejects external root without ALLOW_EXTERNAL_CLEANUP", () => {
    const externalDir = mkdtempSync(
      joinPath(tmpdir(), "mdt-cleanup-external-"),
    );
    try {
      const r = cleanupTraces({ dryRun: false, root: externalDir });
      expect(r.ok).toBe(false);
      expect(r.failureReason).toMatch(/MEMORYDETECTIVE_ALLOW_EXTERNAL_CLEANUP/);
      expect(r.deleted).toBe(0);
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it("accepts external root when ALLOW_EXTERNAL_CLEANUP=1", () => {
    const externalDir = mkdtempSync(
      joinPath(tmpdir(), "mdt-cleanup-external-"),
    );
    try {
      makeFakeTraceBundle(externalDir, "out.trace", 1024, 1);
      process.env.MEMORYDETECTIVE_ALLOW_EXTERNAL_CLEANUP = "1";
      const r = cleanupTraces({ dryRun: true, root: externalDir });
      expect(r.ok).toBe(true);
      expect(r.candidates).toHaveLength(1);
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it("returns ok with empty candidates when root does not exist", () => {
    const ghost = joinPath(workDir, "does-not-exist");
    const r = cleanupTraces({ dryRun: true, root: ghost });
    expect(r.ok).toBe(true);
    expect(r.candidates).toHaveLength(0);
  });

  it("ignores files and non-.trace directories", () => {
    writeFileSync(joinPath(workDir, "notes.txt"), "hello");
    mkdirSync(joinPath(workDir, "logs"));
    writeFileSync(joinPath(workDir, "logs", "a.log"), "log");
    const r = cleanupTraces({ dryRun: true });
    expect(r.candidates).toHaveLength(0);
  });
});
