import { describe, it, expect } from "vitest";
import {
  buildHeadline,
  buildMarkdownCard,
  correlateHangsAndHitches,
  buildCorrelations,
  SUMMARIZE_AREA_KEYS,
  type SummarizeTraceResult,
} from "./summarizeTrace.js";
import type { AnalyzeHangsResult } from "./analyzeHangs.js";
import type { AnalyzeAnimationHitchesResult } from "./analyzeAnimationHitches.js";
import type { AnalyzeTimeProfileResult } from "./analyzeTimeProfile.js";
import type { AnalyzeAllocationsResult } from "./analyzeAllocations.js";
import type { AnalyzeAppLaunchResult } from "./analyzeAppLaunch.js";
import type { AnalyzeNetworkActivityResult } from "./analyzeNetworkActivity.js";
import type { InspectTraceResult } from "./inspectTrace.js";

function emptyInspection(): InspectTraceResult {
  return {
    ok: true,
    tracePath: "/tmp/empty.trace",
    schemas: [],
    rowCounts: {},
    diagnosis: "Trace contains no analyzable schemas.",
    suggestedNextCalls: [],
  };
}

function inspectionWith(rowCounts: Record<string, number>): InspectTraceResult {
  return {
    ok: true,
    tracePath: "/tmp/run.trace",
    schemas: Object.entries(rowCounts).map(([name, rowCount]) => ({
      name,
      rowCount,
    })),
    rowCounts,
    deviceModel: "iPhone 15 Pro Max",
    osVersion: "iOS 18.0",
    templateName: "Time Profiler",
    diagnosis: "ok",
    suggestedNextCalls: [],
  };
}

function emptyAreas(): SummarizeTraceResult["areas"] {
  return {
    hangs: { status: "schema-absent", diagnosis: "no hangs" },
    hitches: { status: "schema-absent", diagnosis: "no hitches" },
    timeProfile: { status: "schema-absent", diagnosis: "no time-profile" },
    allocations: { status: "schema-absent", diagnosis: "no allocations" },
    appLaunch: { status: "schema-absent", diagnosis: "no app-launch" },
    network: { status: "schema-absent", diagnosis: "no network" },
  };
}

function makeHang(
  durationMs: number,
  startNs = 1_000_000_000,
  violation?: { kind: "sync-io" | "db-lock" | "network" | "lock-contention"; topFrame: string },
): AnalyzeHangsResult["top"][number] {
  const entry: AnalyzeHangsResult["top"][number] = {
    startNs,
    startFmt: `${(startNs / 1e9).toFixed(2)}s`,
    durationNs: durationMs * 1e6,
    durationMs,
    durationFmt: `${durationMs}ms`,
    hangType: durationMs >= 250 ? "Hang" : "Microhang",
  };
  if (violation) {
    entry.mainThreadViolations = [{ ...violation, samples: 1 }];
  }
  return entry;
}

function makeHangsResult(entries: AnalyzeHangsResult["top"]): AnalyzeHangsResult {
  return {
    ok: true,
    tracePath: "/tmp/run.trace",
    totals: {
      rows: entries.length,
      hangs: entries.filter((e) => e.hangType === "Hang").length,
      microhangs: entries.filter((e) => e.hangType === "Microhang").length,
      longestMs: Math.max(0, ...entries.map((e) => e.durationMs)),
      averageMs:
        entries.length > 0
          ? entries.reduce((s, e) => s + e.durationMs, 0) / entries.length
          : 0,
      totalDurationMs: entries.reduce((s, e) => s + e.durationMs, 0),
    },
    top: entries,
    diagnosis: "synthetic",
    status: "available",
  };
}

function makeAppLaunch(totalMs: number, launchType: "cold" | "warm" = "cold"): AnalyzeAppLaunchResult {
  return {
    ok: true,
    tracePath: "/tmp/run.trace",
    totalLaunchMs: totalMs,
    launchType,
    phases: [
      { phase: "dyld-init", label: "Dyld Init", durationMs: 100, percentOfTotal: 10 },
      { phase: "objc-init", label: "ObjC Init", durationMs: 50, percentOfTotal: 5 },
    ],
    diagnosis: "synthetic",
  };
}

function makeHitches(perceptibleCount: number): AnalyzeAnimationHitchesResult {
  return {
    ok: true,
    tracePath: "/tmp/run.trace",
    totals: {
      rows: perceptibleCount,
      totalDurationMs: 0,
      longestMs: 200,
      averageMs: 150,
      perceptible: perceptibleCount,
    },
    byType: {},
    top: [],
    diagnosis: "synthetic",
    status: "available",
  };
}

describe("SUMMARIZE_AREA_KEYS", () => {
  it("declares all 5 areas in stable order", () => {
    expect(SUMMARIZE_AREA_KEYS).toEqual([
      "hangs",
      "hitches",
      "timeProfile",
      "allocations",
      "appLaunch",
    ]);
  });
});

describe("buildHeadline", () => {
  it("highlights a long hang above 250ms as user-visible", () => {
    const areas = emptyAreas();
    areas.hangs = {
      status: "ok",
      diagnosis: "",
      result: makeHangsResult([
        makeHang(1400, 4_200_000_000, {
          kind: "db-lock",
          topFrame: "sqlite3_step",
        }),
      ]),
    };
    const headline = buildHeadline(areas);
    expect(headline).toContain("1400ms hang");
    expect(headline).toContain("t=4.20s");
    expect(headline).toContain("sqlite3_step");
    expect(headline).toContain("db-lock");
  });

  it("falls back to long launch when hangs are absent", () => {
    const areas = emptyAreas();
    areas.appLaunch = {
      status: "ok",
      diagnosis: "",
      result: makeAppLaunch(1500),
    };
    const headline = buildHeadline(areas);
    expect(headline).toContain("1500ms");
    expect(headline).toContain("cold");
    expect(headline).toContain("Above the 1s");
  });

  it("falls back to perceptible hitches when hangs and launch are clean", () => {
    const areas = emptyAreas();
    areas.hitches = {
      status: "ok",
      diagnosis: "",
      result: makeHitches(7),
    };
    const headline = buildHeadline(areas);
    expect(headline).toContain("7 animation hitches");
    expect(headline).toContain("user-perceptible");
  });

  it("falls back to short hang (<250ms) note when nothing else surfaces", () => {
    const areas = emptyAreas();
    areas.hangs = {
      status: "ok",
      diagnosis: "",
      result: makeHangsResult([makeHang(120)]),
    };
    const headline = buildHeadline(areas);
    expect(headline).toContain("120ms hang");
    expect(headline).toContain("Below the 250ms");
  });

  it("returns a no-issues string when all areas are empty", () => {
    const headline = buildHeadline(emptyAreas());
    expect(headline).toContain("No user-perceptible perf events");
  });
});

describe("correlateHangsAndHitches", () => {
  it("returns empty when either side is empty", () => {
    expect(correlateHangsAndHitches([], [])).toEqual([]);
    expect(
      correlateHangsAndHitches(
        [{ startNs: 1e9, durationNs: 1e9, durationMs: 1000 }],
        [],
      ),
    ).toEqual([]);
  });

  it("detects overlap when hitch falls inside hang window", () => {
    const r = correlateHangsAndHitches(
      [{ startNs: 1_000_000_000, durationNs: 1_000_000_000, durationMs: 1000 }],
      [
        {
          startNs: 1_200_000_000,
          durationNs: 100_000_000,
          durationMs: 100,
          hitchType: "RenderServerCommit",
        },
      ],
    );
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe("hangs+hitches");
    expect(r[0].narrative).toContain("Hang at t=1.00s");
    expect(r[0].narrative).toContain("RenderServerCommit");
  });

  it("excludes non-overlapping events", () => {
    const r = correlateHangsAndHitches(
      [{ startNs: 1_000_000_000, durationNs: 500_000_000, durationMs: 500 }],
      [
        {
          startNs: 2_000_000_000,
          durationNs: 100_000_000,
          durationMs: 100,
        },
      ],
    );
    expect(r).toEqual([]);
  });

  it("rates a >=250ms + >=250ms overlap >=100ms as HIGH confidence", () => {
    const r = correlateHangsAndHitches(
      [{ startNs: 1_000_000_000, durationNs: 500_000_000, durationMs: 500 }],
      [
        {
          startNs: 1_100_000_000,
          durationNs: 300_000_000,
          durationMs: 300,
        },
      ],
    );
    expect(r[0].confidence).toBe("high");
  });

  it("rates only-one-side->=250ms as MEDIUM confidence", () => {
    const r = correlateHangsAndHitches(
      [{ startNs: 1_000_000_000, durationNs: 500_000_000, durationMs: 500 }],
      [
        {
          startNs: 1_100_000_000,
          durationNs: 100_000_000,
          durationMs: 100,
        },
      ],
    );
    expect(r[0].confidence).toBe("medium");
  });

  it("rates both-sub-250ms-but-overlapping as LOW confidence", () => {
    const r = correlateHangsAndHitches(
      [{ startNs: 1_000_000_000, durationNs: 100_000_000, durationMs: 100 }],
      [
        {
          startNs: 1_050_000_000,
          durationNs: 50_000_000,
          durationMs: 50,
        },
      ],
    );
    expect(r[0].confidence).toBe("low");
  });

  it("sorts results by atSec ascending", () => {
    const r = correlateHangsAndHitches(
      [
        { startNs: 5_000_000_000, durationNs: 500_000_000, durationMs: 500 },
        { startNs: 1_000_000_000, durationNs: 500_000_000, durationMs: 500 },
      ],
      [
        { startNs: 5_100_000_000, durationNs: 300_000_000, durationMs: 300 },
        { startNs: 1_100_000_000, durationNs: 300_000_000, durationMs: 300 },
      ],
    );
    expect(r.map((c) => c.atSec)).toEqual([1, 5]);
  });
});

describe("buildMarkdownCard", () => {
  it("renders the empty-trace card without any analyzer sections", () => {
    const base = {
      ok: true as const,
      tracePath: "/tmp/empty.trace",
      inspection: emptyInspection(),
      areas: emptyAreas(),
      headline: "No user-perceptible perf events detected.",
    };
    const md = buildMarkdownCard(base, false);
    expect(md).toContain("# Trace summary: empty.trace");
    expect(md).toContain("Headline");
    expect(md).not.toContain("## Hangs");
    expect(md).not.toContain("## Animation hitches");
  });

  it("renders hangs section with mainThreadViolations enrichment", () => {
    const areas = emptyAreas();
    areas.hangs = {
      status: "ok",
      diagnosis: "",
      result: makeHangsResult([
        makeHang(1400, 4_200_000_000, { kind: "db-lock", topFrame: "sqlite3_step" }),
        makeHang(240, 18_700_000_000, {
          kind: "lock-contention",
          topFrame: "pthread_mutex_lock",
        }),
      ]),
    };
    const md = buildMarkdownCard(
      {
        ok: true,
        tracePath: "/tmp/run.trace",
        inspection: inspectionWith({ "potential-hangs": 2 }),
        areas,
        headline: buildHeadline(areas),
      },
      false,
    );
    expect(md).toContain("## Hangs (1, 1 user-visible, 1 microhang)");
    expect(md).toContain("1400ms at t=4.20s → db-lock (`sqlite3_step`)");
    expect(md).toContain("240ms at t=18.70s → lock-contention (`pthread_mutex_lock`)");
  });

  it("renders the device + template metadata line when inspection provides it", () => {
    const md = buildMarkdownCard(
      {
        ok: true,
        tracePath: "/tmp/run.trace",
        inspection: inspectionWith({ "potential-hangs": 0 }),
        areas: emptyAreas(),
        headline: "h",
      },
      false,
    );
    expect(md).toContain("iPhone 15 Pro Max");
    expect(md).toContain("iOS 18.0");
    expect(md).toContain("Template: `Time Profiler`");
  });

  it("verbose: true uses larger per-area top-N", () => {
    const entries = [];
    for (let i = 0; i < 10; i++) {
      entries.push(makeHang(120 + i, i * 1e9));
    }
    const areas = emptyAreas();
    areas.hangs = {
      status: "ok",
      diagnosis: "",
      result: makeHangsResult(entries),
    };
    const base = {
      ok: true as const,
      tracePath: "/tmp/run.trace",
      inspection: inspectionWith({ "potential-hangs": 10 }),
      areas,
      headline: "h",
    };
    const compact = buildMarkdownCard(base, false);
    const verbose = buildMarkdownCard(base, true);
    const compactHangLines = (compact.match(/^- \d+ms at /gm) ?? []).length;
    const verboseHangLines = (verbose.match(/^- \d+ms at /gm) ?? []).length;
    expect(compactHangLines).toBe(5);
    expect(verboseHangLines).toBe(10);
  });

  it("surfaces a failed-area diagnosis in place of the section data", () => {
    const areas = emptyAreas();
    areas.timeProfile = {
      status: "failed",
      diagnosis: "Analyzer failed: xctrace SIGSEGV exporting time-profile schema.",
    };
    const md = buildMarkdownCard(
      {
        ok: true,
        tracePath: "/tmp/run.trace",
        inspection: inspectionWith({ "time-profile": 50_000 }),
        areas,
        headline: "h",
      },
      false,
    );
    expect(md).toContain("## Time profile");
    expect(md).toContain("xctrace SIGSEGV");
  });

  it("renders allocation table with cumulative + persistent + count columns", () => {
    const areas = emptyAreas();
    areas.allocations = {
      status: "ok",
      diagnosis: "",
      result: {
        ok: true,
        tracePath: "/tmp/run.trace",
        totals: {
          rows: 100,
          cumulativeBytes: 50 * 1024 * 1024,
          cumulativeAllocations: 1000,
          persistentBytes: 30 * 1024 * 1024,
          transientBytes: 20 * 1024 * 1024,
        },
        topByBytes: [
          {
            category: "MyApp.DataModel",
            cumulativeBytes: 10 * 1024 * 1024,
            cumulativeCount: 100,
            averageBytes: 1024,
            lifecycle: "persistent",
          },
        ],
        topByCount: [],
        diagnosis: "synthetic",
        status: "available",
      } satisfies AnalyzeAllocationsResult,
    };
    const md = buildMarkdownCard(
      {
        ok: true,
        tracePath: "/tmp/run.trace",
        inspection: inspectionWith({ allocations: 100 }),
        areas,
        headline: "h",
      },
      false,
    );
    expect(md).toContain("## Allocations (50.0 MB cumulative, 30.0 MB persistent)");
    expect(md).toContain("| `MyApp.DataModel` | persistent | 10.00 MB | 100 |");
  });

  it("renders time-profile with a workaround notice block when present", () => {
    const areas = emptyAreas();
    areas.timeProfile = {
      status: "ok",
      diagnosis: "",
      result: {
        ok: true,
        tracePath: "/tmp/run.trace",
        totalSamples: 1234,
        topSymbols: [{ symbol: "MyApp.foo", samples: 500 }],
        topRows: [],
        notice: "Symbol table truncated; rerun with dSYM for full names.",
        diagnosis: "synthetic",
        status: "partial",
      } satisfies AnalyzeTimeProfileResult,
    };
    const md = buildMarkdownCard(
      {
        ok: true,
        tracePath: "/tmp/run.trace",
        inspection: inspectionWith({ "time-profile": 1234 }),
        areas,
        headline: "h",
      },
      false,
    );
    expect(md).toMatch(/## Time profile \(1[.,]234 samples/);
    expect(md).toContain("dSYM");
    expect(md).toContain("`MyApp.foo`");
  });

  it("renders correlations section with confidence badges and verbose toggle", () => {
    const baseAreas = emptyAreas();
    baseAreas.hangs = {
      status: "ok",
      diagnosis: "",
      result: makeHangsResult([
        makeHang(500, 1_000_000_000, { kind: "db-lock", topFrame: "sqlite3_step" }),
      ]),
    };
    baseAreas.hitches = {
      status: "ok",
      diagnosis: "",
      result: {
        ok: true,
        tracePath: "/tmp/run.trace",
        totals: {
          rows: 1,
          totalDurationMs: 200,
          longestMs: 200,
          averageMs: 200,
          perceptible: 1,
        },
        byType: {},
        top: [
          {
            startNs: 1_100_000_000,
            startFmt: "1.10s",
            durationNs: 200 * 1e6,
            durationMs: 200,
            durationFmt: "200ms",
            hitchType: "RenderServerCommit",
          },
        ],
        diagnosis: "synthetic",
        status: "available",
      },
    };
    const base = {
      ok: true as const,
      tracePath: "/tmp/run.trace",
      inspection: inspectionWith({ "potential-hangs": 1, "animation-hitches": 1 }),
      areas: baseAreas,
      correlations: buildCorrelations(baseAreas),
      headline: buildHeadline(baseAreas),
    };
    const md = buildMarkdownCard(base, false);
    expect(md).toContain("## Cross-correlations");
    // Hang 500ms (>=250) + hitch 200ms (<250) -> MEDIUM (only one event >=250).
    expect(md).toContain("MEDIUM");
    expect(md).toContain("Hang at t=1.00s");
    expect(md).toContain("hitch at t=1.10s");
  });

  it("suppresses Cross-correlations section when no correlations exist", () => {
    const md = buildMarkdownCard(
      {
        ok: true,
        tracePath: "/tmp/run.trace",
        inspection: inspectionWith({}),
        areas: emptyAreas(),
        correlations: [],
        headline: "h",
      },
      false,
    );
    expect(md).not.toContain("## Cross-correlations");
  });

  it("stays under 10 KB at default settings on a populated trace", () => {
    const areas = emptyAreas();
    const hangs = [];
    for (let i = 0; i < 5; i++) {
      hangs.push(
        makeHang(500 + i * 100, (i + 1) * 1e9, {
          kind: "db-lock",
          topFrame: `sqlite3_step_${i}`,
        }),
      );
    }
    areas.hangs = { status: "ok", diagnosis: "", result: makeHangsResult(hangs) };
    areas.hitches = { status: "ok", diagnosis: "", result: makeHitches(3) };
    areas.appLaunch = { status: "ok", diagnosis: "", result: makeAppLaunch(800) };
    const md = buildMarkdownCard(
      {
        ok: true,
        tracePath: "/tmp/run.trace",
        inspection: inspectionWith({
          "potential-hangs": 5,
          "animation-hitches": 3,
          "app-launch": 1,
        }),
        areas,
        headline: buildHeadline(areas),
      },
      false,
    );
    expect(md.length).toBeLessThan(10 * 1024);
  });
});

function makeNetwork(
  options: {
    rows: number;
    longestMs: number;
    topUrl?: string;
    topHost?: string;
  } = { rows: 3, longestMs: 1000 },
): AnalyzeNetworkActivityResult {
  return {
    ok: true,
    tracePath: "/tmp/run.trace",
    totals: {
      rows: options.rows,
      totalBytesIn: 12345,
      totalBytesOut: 678,
      longestMs: options.longestMs,
      averageMs: options.longestMs / 2,
      statusBuckets: { "2xx": options.rows },
    },
    topByDuration: [
      {
        startNs: 1_000_000_000,
        durationNs: options.longestMs * 1_000_000,
        durationMs: options.longestMs,
        url: options.topUrl ?? "https://api.example.com/v1/users",
        host: options.topHost ?? "api.example.com",
        method: "GET",
        statusCode: 200,
        bytesIn: 8000,
        bytesOut: 256,
      },
    ],
    topByBytes: [],
    byHost: [
      {
        host: options.topHost ?? "api.example.com",
        count: options.rows,
        bytesIn: 12345,
        bytesOut: 678,
        longestMs: options.longestMs,
      },
    ],
    diagnosis: `${options.rows} network requests captured.`,
    status: "available",
    supportStatus: [
      {
        kind: "network-connections",
        status: "available",
        sourceSchemas: ["network-connections"],
      },
    ],
  };
}

describe("summarizeTrace network chain (v1.15)", () => {
  it("renders Network section when network area is OK", () => {
    const areas = emptyAreas();
    areas.network = {
      status: "ok",
      diagnosis: "",
      result: makeNetwork({
        rows: 4,
        longestMs: 1200,
        topUrl: "https://api.example.com/v1/items",
        topHost: "api.example.com",
      }),
    };
    const md = buildMarkdownCard(
      {
        ok: true,
        tracePath: "/tmp/run.trace",
        inspection: inspectionWith({ "network-connections": 4 }),
        areas,
        headline: buildHeadline(areas),
      },
      false,
    );
    expect(md).toContain("## Network (4 requests");
    expect(md).toContain("1200ms");
    expect(md).toContain("api.example.com");
    expect(md).toContain("Top hosts by request count");
  });

  it("buildHeadline surfaces a slow network request when nothing else fired", () => {
    const areas = emptyAreas();
    areas.network = {
      status: "ok",
      diagnosis: "",
      result: makeNetwork({ rows: 2, longestMs: 4200 }),
    };
    const headline = buildHeadline(areas);
    expect(headline).toContain("4200ms");
    expect(headline).toMatch(/network/i);
  });

  it("network section is omitted when status is schema-absent (no noise)", () => {
    const areas = emptyAreas();
    // Network stays as empty schema-absent.
    const md = buildMarkdownCard(
      {
        ok: true,
        tracePath: "/tmp/run.trace",
        inspection: emptyInspection(),
        areas,
        headline: buildHeadline(areas),
      },
      false,
    );
    expect(md).not.toContain("## Network");
  });

  it("hangs still win over network in the headline ranking", () => {
    const areas = emptyAreas();
    areas.hangs = {
      status: "ok",
      diagnosis: "",
      result: makeHangsResult([makeHang(800)]),
    };
    areas.network = {
      status: "ok",
      diagnosis: "",
      result: makeNetwork({ rows: 1, longestMs: 5000 }),
    };
    const headline = buildHeadline(areas);
    expect(headline).toContain("hang");
    expect(headline).not.toContain("network request");
  });
});
