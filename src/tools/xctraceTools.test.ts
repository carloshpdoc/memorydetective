import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  analyzeHangsFromXml,
  classifyHangFrame,
  hangFrameMapKey,
  correlateTimeProfileToHangs,
} from "./analyzeHangs.js";
import { analyzeTimeProfileFromXml } from "./analyzeTimeProfile.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES = resolve(__dirname, "../../tests/fixtures");

const hangsXml = readFileSync(
  resolve(FIXTURES, "example-potential-hangs.xml"),
  "utf8",
);

describe("analyzeHangsFromXml", () => {
  it("aggregates totals from real fixture", () => {
    const result = analyzeHangsFromXml(hangsXml, "/fake/run.trace");
    expect(result.ok).toBe(true);
    expect(result.totals.rows).toBe(35);
    expect(result.totals.hangs).toBeGreaterThan(0);
    expect(result.totals.microhangs).toBeGreaterThan(0);
    expect(result.totals.longestMs).toBeGreaterThan(500);
  });

  it("sorts top entries by duration desc", () => {
    const result = analyzeHangsFromXml(hangsXml, "/fake/run.trace", 5);
    expect(result.top.length).toBe(5);
    for (let i = 0; i + 1 < result.top.length; i++) {
      expect(result.top[i].durationMs).toBeGreaterThanOrEqual(
        result.top[i + 1].durationMs,
      );
    }
  });

  it("filters by minDurationMs", () => {
    const noFilter = analyzeHangsFromXml(hangsXml, "/fake/run.trace", 100, 0);
    const filtered = analyzeHangsFromXml(hangsXml, "/fake/run.trace", 100, 500);
    expect(filtered.totals.rows).toBeLessThan(noFilter.totals.rows);
    for (const e of filtered.top) {
      expect(e.durationMs).toBeGreaterThanOrEqual(500);
    }
  });

  it("produces a diagnosis string", () => {
    const result = analyzeHangsFromXml(hangsXml, "/fake/run.trace");
    expect(result.diagnosis).toMatch(/hangs total/);
  });

  it("returns a clean empty result when no rows match", () => {
    const result = analyzeHangsFromXml(
      hangsXml,
      "/fake/run.trace",
      10,
      999_999,
    );
    expect(result.totals.rows).toBe(0);
    expect(result.top).toEqual([]);
    expect(result.diagnosis).toContain("No hangs detected");
  });

  it("sets status to 'available' when the hangs table is present", () => {
    const result = analyzeHangsFromXml(hangsXml, "/fake/run.trace");
    expect(result.status).toBe("available");
  });

  it("sets status to 'not_present' when no hangs table is in the trace", () => {
    // Empty trace-query-result with no potential-hangs schema.
    const empty = `<?xml version="1.0"?><trace-query-result></trace-query-result>`;
    const result = analyzeHangsFromXml(empty, "/fake/run.trace");
    expect(result.status).toBe("not_present");
    expect(result.totals.rows).toBe(0);
  });

  it("filters hangs to the timeRangeMs window when provided", () => {
    // Take baseline counts, then run with a window that drops the late hangs.
    const baseline = analyzeHangsFromXml(hangsXml, "/fake/run.trace", 100, 0);
    expect(baseline.totals.rows).toBeGreaterThan(0);

    // Use a generous tight window around the FIRST hang's startMs so we keep
    // at least one entry and exclude later ones. The fixture's first hang
    // starts within the first ~1s of the trace, others further out.
    const firstStartMs = baseline.top
      .slice()
      .sort((a, b) => a.startNs - b.startNs)[0].startNs / 1_000_000;
    const windowed = analyzeHangsFromXml(hangsXml, "/fake/run.trace", 100, 0, {
      startMs: Math.max(0, firstStartMs - 50),
      endMs: firstStartMs + 100,
    });
    expect(windowed.totals.rows).toBeGreaterThan(0);
    expect(windowed.totals.rows).toBeLessThan(baseline.totals.rows);
    for (const e of windowed.top) {
      const startMs = e.startNs / 1_000_000;
      expect(startMs).toBeGreaterThanOrEqual(firstStartMs - 50);
      expect(startMs).toBeLessThanOrEqual(firstStartMs + 100);
    }
  });

  it("timeRangeMs returning zero rows still reports status=available", () => {
    // A window far past the recording's data range should empty the result
    // but status stays available (the trace was readable, just nothing in
    // this window). Different from not_present.
    const windowed = analyzeHangsFromXml(hangsXml, "/fake/run.trace", 100, 0, {
      startMs: 10_000_000,
      endMs: 11_000_000,
    });
    expect(windowed.totals.rows).toBe(0);
    expect(windowed.status).toBe("available");
  });

  it("enriches top hangs with mainThreadViolations when topFramesByHangStartNs is provided", () => {
    const baseline = analyzeHangsFromXml(hangsXml, "/fake/run.trace", 100, 0);
    expect(baseline.top.length).toBeGreaterThan(0);
    const longest = baseline.top[0];
    const map: Record<string, string> = {
      [hangFrameMapKey(longest.startNs)]: "pthread_mutex_lock",
    };
    const enriched = analyzeHangsFromXml(
      hangsXml,
      "/fake/run.trace",
      100,
      0,
      undefined,
      map,
    );
    expect(enriched.top[0].mainThreadViolations).toEqual([
      { kind: "lock-contention", topFrame: "pthread_mutex_lock", samples: 1 },
    ]);
  });

  it("leaves mainThreadViolations undefined on hangs not present in the supplemental map", () => {
    const baseline = analyzeHangsFromXml(hangsXml, "/fake/run.trace", 100, 0);
    if (baseline.top.length < 2) return; // nothing to assert about
    const longest = baseline.top[0];
    const map: Record<string, string> = {
      [hangFrameMapKey(longest.startNs)]: "sqlite3_step",
    };
    const enriched = analyzeHangsFromXml(
      hangsXml,
      "/fake/run.trace",
      100,
      0,
      undefined,
      map,
    );
    expect(enriched.top[0].mainThreadViolations).toBeDefined();
    expect(enriched.top[1].mainThreadViolations).toBeUndefined();
  });

  it("returns an empty mainThreadViolations array when the frame is supplied but matches no signature", () => {
    const baseline = analyzeHangsFromXml(hangsXml, "/fake/run.trace", 100, 0);
    if (baseline.top.length === 0) return;
    const longest = baseline.top[0];
    const map: Record<string, string> = {
      [hangFrameMapKey(longest.startNs)]: "MyAppCustomMainThreadHelper",
    };
    const enriched = analyzeHangsFromXml(
      hangsXml,
      "/fake/run.trace",
      100,
      0,
      undefined,
      map,
    );
    expect(enriched.top[0].mainThreadViolations).toEqual([]);
  });
});

describe("classifyHangFrame", () => {
  it("classifies sync-io for POSIX read/write/fsync top frames", () => {
    expect(classifyHangFrame("read")?.kind).toBe("sync-io");
    expect(classifyHangFrame("pwrite")?.kind).toBe("sync-io");
    expect(classifyHangFrame("fsync")?.kind).toBe("sync-io");
    expect(
      classifyHangFrame("NSData _initWithContentsOfURL:options:error:")?.kind,
    ).toBe("sync-io");
  });

  it("classifies db-lock for SQLite mutex/step/prepare top frames", () => {
    expect(classifyHangFrame("sqlite3_step")?.kind).toBe("db-lock");
    expect(classifyHangFrame("sqlite3_mutex_enter")?.kind).toBe("db-lock");
    expect(classifyHangFrame("pagerSharedLock")?.kind).toBe("db-lock");
    expect(classifyHangFrame("NSManagedObjectContext save:")?.kind).toBe(
      "db-lock",
    );
  });

  it("classifies network for synchronous URL session / CFNetwork frames", () => {
    expect(
      classifyHangFrame("NSURLConnection sendSynchronousRequest:")?.kind,
    ).toBe("network");
    expect(classifyHangFrame("CFReadStreamRead")?.kind).toBe("network");
    expect(classifyHangFrame("nw_connection_start")?.kind).toBe("network");
  });

  it("classifies lock-contention for pthread / os_unfair / dispatch frames", () => {
    expect(classifyHangFrame("pthread_mutex_lock")?.kind).toBe(
      "lock-contention",
    );
    expect(classifyHangFrame("os_unfair_lock_lock")?.kind).toBe(
      "lock-contention",
    );
    expect(classifyHangFrame("dispatch_semaphore_wait")?.kind).toBe(
      "lock-contention",
    );
    expect(classifyHangFrame("dispatch_sync")?.kind).toBe("lock-contention");
  });

  it("returns null when the frame matches no signature", () => {
    expect(classifyHangFrame("MyAppRenderView")).toBeNull();
    expect(classifyHangFrame("")).toBeNull();
    expect(classifyHangFrame("0x18004afc0")).toBeNull();
  });

  it("threads `samples` through unchanged", () => {
    const v = classifyHangFrame("sqlite3_step", 42);
    expect(v?.samples).toBe(42);
    expect(v?.topFrame).toBe("sqlite3_step");
  });

  it("hangFrameMapKey returns the stringified startNs", () => {
    expect(hangFrameMapKey(1_234_567_890)).toBe("1234567890");
    expect(hangFrameMapKey(0)).toBe("0");
  });
});

describe("analyzeTimeProfileFromXml", () => {
  it("returns a clean empty result when no time-profile table is present", () => {
    // The hangs fixture deliberately does not contain a time-profile schema.
    const result = analyzeTimeProfileFromXml(hangsXml, "/fake/run.trace");
    expect(result.ok).toBe(true);
    expect(result.totalSamples).toBe(0);
    expect(result.diagnosis).toMatch(/No time-profile/);
    expect(result.status).toBe("not_present");
  });

  it("parses a synthetic time-profile XML", () => {
    const synthetic = `<?xml version="1.0"?>
<trace-query-result>
<node><schema name="time-profile">
<col><mnemonic>weight</mnemonic><name>Weight</name></col>
<col><mnemonic>symbol</mnemonic><name>Symbol</name></col>
<col><mnemonic>thread</mnemonic><name>Thread</name></col>
</schema>
<row><weight fmt="42 ms">42</weight><symbol fmt="MyApp.foo()">MyApp.foo()</symbol><thread fmt="Main"/></row>
<row><weight fmt="42 ms">42</weight><symbol fmt="MyApp.foo()">MyApp.foo()</symbol><thread fmt="Main"/></row>
<row><weight fmt="11 ms">11</weight><symbol fmt="MyApp.bar()">MyApp.bar()</symbol><thread fmt="Main"/></row>
</node></trace-query-result>`;
    const result = analyzeTimeProfileFromXml(synthetic, "/fake/run.trace");
    expect(result.totalSamples).toBe(3);
    expect(result.topSymbols[0]).toEqual({
      symbol: "MyApp.foo()",
      samples: 2,
    });
  });
});

describe("correlateTimeProfileToHangs (v1.12)", () => {
  it("returns empty map when no hangs", () => {
    const r = correlateTimeProfileToHangs([], [
      { startNs: 1_000_000, topFrame: "pthread_mutex_lock" },
    ]);
    expect(r).toEqual({});
  });

  it("returns empty map when no time-profile rows", () => {
    const r = correlateTimeProfileToHangs(
      [{ startNs: 1_000_000, durationNs: 500_000 }],
      [],
    );
    expect(r).toEqual({});
  });

  it("correlates a sample falling inside a hang window to that hang", () => {
    const r = correlateTimeProfileToHangs(
      [{ startNs: 1_000_000, durationNs: 1_000_000 }],
      [
        { startNs: 1_500_000, topFrame: "pthread_mutex_lock", weight: 1 },
      ],
    );
    expect(r).toEqual({
      "1000000": "pthread_mutex_lock",
    });
  });

  it("excludes samples outside the hang window", () => {
    const r = correlateTimeProfileToHangs(
      [{ startNs: 1_000_000, durationNs: 500_000 }],
      [
        // Sample BEFORE the window starts.
        { startNs: 500_000, topFrame: "before", weight: 1 },
        // Sample AFTER the window ends (start + duration = 1.5M).
        { startNs: 2_000_000, topFrame: "after", weight: 1 },
      ],
    );
    expect(r).toEqual({});
  });

  it("picks the frame with the highest aggregate weight when multiple samples overlap", () => {
    const r = correlateTimeProfileToHangs(
      [{ startNs: 1_000_000, durationNs: 1_000_000 }],
      [
        { startNs: 1_100_000, topFrame: "sqlite3_step", weight: 5 },
        { startNs: 1_200_000, topFrame: "pthread_mutex_lock", weight: 2 },
        { startNs: 1_500_000, topFrame: "sqlite3_step", weight: 3 },
      ],
    );
    // sqlite3_step total = 8 > pthread_mutex_lock total = 2.
    expect(r["1000000"]).toBe("sqlite3_step");
  });

  it("falls back to first backtrace line when topFrame is absent", () => {
    const r = correlateTimeProfileToHangs(
      [{ startNs: 1_000_000, durationNs: 500_000 }],
      [
        {
          startNs: 1_200_000,
          backtrace: "MyApp.foo()\nMyApp.bar()\n",
          weight: 1,
        },
      ],
    );
    expect(r["1000000"]).toBe("MyApp.foo()");
  });

  it("handles multiple hangs independently", () => {
    const r = correlateTimeProfileToHangs(
      [
        { startNs: 1_000_000, durationNs: 500_000 },
        { startNs: 5_000_000, durationNs: 500_000 },
      ],
      [
        { startNs: 1_200_000, topFrame: "sqlite3_step", weight: 1 },
        { startNs: 5_200_000, topFrame: "pthread_mutex_lock", weight: 1 },
      ],
    );
    expect(r).toEqual({
      "1000000": "sqlite3_step",
      "5000000": "pthread_mutex_lock",
    });
  });

  it("uses default weight of 1 when sample.weight is undefined", () => {
    const r = correlateTimeProfileToHangs(
      [{ startNs: 1_000_000, durationNs: 1_000_000 }],
      [
        { startNs: 1_100_000, topFrame: "winner" },
        { startNs: 1_200_000, topFrame: "loser" },
        { startNs: 1_300_000, topFrame: "winner" },
      ],
    );
    // winner counted twice (no weight), loser once. Winner has score 2.
    expect(r["1000000"]).toBe("winner");
  });
});
