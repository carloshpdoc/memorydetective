import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  analyzeHangsFromXml,
  analyzeHangRisksFromXml,
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

// v1.14 item F: hang-risks schema. Different shape from potential-hangs
// (annotations, not measured durations). Reported alongside under
// `result.risks[]` + `result.risksTotals` when the schema is exported.
const HANG_RISKS_FIXTURE = `<?xml version="1.0"?>
<trace-query-result>
<node><schema name="hang-risks">
<col><mnemonic>time</mnemonic><name>Timestamp</name><engineering-type>event-time</engineering-type></col>
<col><mnemonic>process</mnemonic><name>Process</name><engineering-type>process</engineering-type></col>
<col><mnemonic>message</mnemonic><name>Message</name><engineering-type>narrative</engineering-type></col>
<col><mnemonic>severity</mnemonic><name>Severity</name><engineering-type>short-string</engineering-type></col>
<col><mnemonic>event-type</mnemonic><name>Event Type</name><engineering-type>event-type</engineering-type></col>
<col><mnemonic>backtrace</mnemonic><name>Backtrace</name><engineering-type>text-backtrace</engineering-type></col>
<col><mnemonic>thread</mnemonic><name>Thread</name><engineering-type>thread</engineering-type></col>
</schema>
<row>
<time id="1" fmt="00:00:01.500">1500000000</time>
<process id="2" fmt="DemoApp"/>
<message id="3" fmt="Main thread stalled for 280ms"/>
<severity id="4" fmt="Hang Risk"/>
<event-type id="5" fmt="narrative"/>
<backtrace id="6" fmt="pthread_mutex_lock\nNSPersistentStoreCoordinator lock"/>
<thread id="7" fmt="Main Thread"/>
</row>
<row>
<time id="8" fmt="00:00:03.800">3800000000</time>
<process ref="2"/>
<message id="9" fmt="Main thread stalled for 1200ms"/>
<severity id="10" fmt="Severe Hang Risk"/>
<event-type ref="5"/>
<backtrace id="11" fmt="dispatch_semaphore_wait"/>
<thread ref="7"/>
</row>
<row>
<time id="12" fmt="00:00:05.200">5200000000</time>
<process ref="2"/>
<message id="13" fmt="Main thread stalled for 350ms"/>
<severity id="14" fmt="Hang Risk"/>
<event-type ref="5"/>
<backtrace id="15" fmt="CFReadStreamRead"/>
<thread ref="7"/>
</row>
</node></trace-query-result>`;

const HANG_RISKS_EMPTY_FIXTURE = `<?xml version="1.0"?>
<trace-query-result>
<node><schema name="hang-risks">
<col><mnemonic>time</mnemonic><name>Timestamp</name><engineering-type>event-time</engineering-type></col>
<col><mnemonic>severity</mnemonic><name>Severity</name><engineering-type>short-string</engineering-type></col>
</schema>
</node></trace-query-result>`;

describe("analyzeHangRisksFromXml (v1.14 item F)", () => {
  it("parses risk rows with timestamp, severity, message, backtrace", () => {
    const r = analyzeHangRisksFromXml(HANG_RISKS_FIXTURE);
    expect(r.total).toBe(3);
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0].severity).toBe("Hang Risk");
    expect(r.rows[0].message).toBe("Main thread stalled for 280ms");
    expect(r.rows[1].severity).toBe("Severe Hang Risk");
    expect(r.rows[2].backtrace).toBe("CFReadStreamRead");
  });

  it("buckets bySeverity for the diagnosis layer to surface severe count", () => {
    const r = analyzeHangRisksFromXml(HANG_RISKS_FIXTURE);
    expect(r.bySeverity).toEqual({
      "Hang Risk": 2,
      "Severe Hang Risk": 1,
    });
  });

  it("sorts risks by timestamp ascending (chronological order during recording)", () => {
    const r = analyzeHangRisksFromXml(HANG_RISKS_FIXTURE);
    expect(r.rows[0].timestampNs).toBeLessThan(r.rows[1].timestampNs);
    expect(r.rows[1].timestampNs).toBeLessThan(r.rows[2].timestampNs);
  });

  it("returns empty result + empty bySeverity when the schema has no rows", () => {
    const r = analyzeHangRisksFromXml(HANG_RISKS_EMPTY_FIXTURE);
    expect(r.total).toBe(0);
    expect(r.rows).toEqual([]);
    expect(r.bySeverity).toEqual({});
  });

  it("returns empty result when the schema is absent entirely (graceful degradation)", () => {
    const r = analyzeHangRisksFromXml("<garbage/>");
    expect(r.total).toBe(0);
    expect(r.rows).toEqual([]);
  });

  it("respects topN by truncating after sort", () => {
    const r = analyzeHangRisksFromXml(HANG_RISKS_FIXTURE, 2);
    expect(r.rows).toHaveLength(2);
    expect(r.total).toBe(3); // total tracks pre-truncation count
  });
});

describe("analyzeHangsFromXml + hang-risks (integration)", () => {
  it("attaches risks[] + risksTotals when hangRisksXml is provided", () => {
    const result = analyzeHangsFromXml(
      hangsXml,
      "/fake/run.trace",
      10,
      0,
      undefined,
      undefined,
      HANG_RISKS_FIXTURE,
    );
    expect(result.risks).toBeDefined();
    expect(result.risks?.length).toBe(3);
    expect(result.risksTotals?.rows).toBe(3);
    expect(result.risksTotals?.bySeverity["Severe Hang Risk"]).toBe(1);
  });

  it("omits risks fields when hangRisksXml is not provided (backwards compat)", () => {
    const result = analyzeHangsFromXml(hangsXml, "/fake/run.trace");
    expect(result.risks).toBeUndefined();
    expect(result.risksTotals).toBeUndefined();
  });

  it("includes risk count in diagnosis (with severe count when present)", () => {
    const result = analyzeHangsFromXml(
      hangsXml,
      "/fake/run.trace",
      10,
      0,
      undefined,
      undefined,
      HANG_RISKS_FIXTURE,
    );
    expect(result.diagnosis).toContain("3 hang risk annotations");
    expect(result.diagnosis).toContain("1 severe");
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

  it("extracts symbol from <backtrace><frame name=...> (real Apple time-profile shape)", () => {
    // This is the shape that ships from xctrace export on a real .trace.
    // The symbol lives on the FIRST <frame> element's @_name attribute,
    // not on a dedicated <symbol> column. Pre-2026-05-15 the parser only
    // read @_fmt, so topSymbols ended up being the weight column repeated.
    const real = `<?xml version="1.0"?>
<trace-query-result>
<node xpath='//trace-toc[1]/run[1]/data[1]/table[13]'>
<schema name="time-profile">
<col><mnemonic>time</mnemonic><name>Sample Time</name><engineering-type>sample-time</engineering-type></col>
<col><mnemonic>weight</mnemonic><name>Weight</name><engineering-type>weight</engineering-type></col>
<col><mnemonic>stack</mnemonic><name>Backtrace</name><engineering-type>backtrace</engineering-type></col>
</schema>
<row>
<sample-time id="1" fmt="00:00.100.000">100000000</sample-time>
<weight id="2" fmt="1.00 ms">1000000</weight>
<backtrace id="3">
<frame id="4" name="_CFRunLoopRunSpecificWithOptions" addr="0x19e52fa6c">
<binary id="5" name="CoreFoundation" UUID="2F32D384" arch="arm64e" load-addr="0x19e513000" path="/dev/null"/>
</frame>
</backtrace>
</row>
<row>
<sample-time id="6" fmt="00:00.200.000">200000000</sample-time>
<weight id="7" fmt="1.00 ms">1000000</weight>
<backtrace id="8">
<frame id="9" name="_CFRunLoopRunSpecificWithOptions" addr="0x19e52fa6c">
<binary ref="5"/>
</frame>
</backtrace>
</row>
<row>
<sample-time id="10" fmt="00:00.300.000">300000000</sample-time>
<weight id="11" fmt="1.00 ms">1000000</weight>
<backtrace id="12">
<frame id="13" name="0x24c0aaa29" addr="0x24c0aaa29">
<binary id="14" name="libsystem_kernel.dylib" UUID="8D830129" arch="arm64e" load-addr="0x24c0aa000" path="/dev/null"/>
</frame>
</backtrace>
</row>
</node></trace-query-result>`;
    const result = analyzeTimeProfileFromXml(real, "/fake/real.trace");
    expect(result.totalSamples).toBe(3);
    // Two samples with the symbolicated frame should aggregate together.
    expect(result.topSymbols[0]).toEqual({
      symbol: "_CFRunLoopRunSpecificWithOptions",
      samples: 2,
    });
    // The hex-address frame should cluster by its binary name (with the
    // hex preserved in parens for traceability).
    expect(result.topSymbols[1]).toEqual({
      symbol: "libsystem_kernel.dylib (0x24c0aaa29)",
      samples: 1,
    });
  });

  it("uses bare binary name when the leaf frame has no @_name at all", () => {
    const minimal = `<?xml version="1.0"?>
<trace-query-result>
<node><schema name="time-profile">
<col><mnemonic>weight</mnemonic><name>Weight</name><engineering-type>weight</engineering-type></col>
<col><mnemonic>stack</mnemonic><name>Backtrace</name><engineering-type>backtrace</engineering-type></col>
</schema>
<row>
<weight id="1" fmt="1.00 ms">1000000</weight>
<backtrace id="2">
<frame id="3" addr="0xdeadbeef">
<binary id="4" name="MysteryLib" UUID="X" arch="arm64e" load-addr="0x0" path="/dev/null"/>
</frame>
</backtrace>
</row>
</node></trace-query-result>`;
    const result = analyzeTimeProfileFromXml(minimal, "/fake/minimal.trace");
    expect(result.totalSamples).toBe(1);
    expect(result.topSymbols[0]).toEqual({
      symbol: "MysteryLib",
      samples: 1,
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
