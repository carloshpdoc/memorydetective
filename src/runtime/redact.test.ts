import { describe, it, expect, beforeEach } from "vitest";
import {
  getRedactionMode,
  redact,
  redactString,
  maybeLogRedactionModeOnce,
  resetRedactionAdvisoryFlagForTests,
} from "./redact.js";

const FAKE_HOME = "/Users/test";

describe("getRedactionMode", () => {
  it("defaults to 'balanced' when env var is unset", () => {
    expect(getRedactionMode({})).toBe("balanced");
  });

  it("respects explicit 'off' / 'strict' / 'balanced' (case-insensitive)", () => {
    expect(getRedactionMode({ MEMORYDETECTIVE_REDACTION: "off" })).toBe("off");
    expect(getRedactionMode({ MEMORYDETECTIVE_REDACTION: "STRICT" })).toBe(
      "strict",
    );
    expect(getRedactionMode({ MEMORYDETECTIVE_REDACTION: "Balanced" })).toBe(
      "balanced",
    );
  });

  it("falls back to 'balanced' on unknown values", () => {
    expect(getRedactionMode({ MEMORYDETECTIVE_REDACTION: "paranoid" })).toBe(
      "balanced",
    );
    expect(getRedactionMode({ MEMORYDETECTIVE_REDACTION: "" })).toBe(
      "balanced",
    );
  });
});

describe("redactString balanced", () => {
  it("collapses home-directory paths to ~", () => {
    const input = `${FAKE_HOME}/Desktop/leak.memgraph`;
    expect(redactString(input, "balanced", FAKE_HOME)).toBe(
      "~/Desktop/leak.memgraph",
    );
  });

  it("masks AWS access keys (AKIA prefix preserved)", () => {
    const input = "use AKIAIOSFODNN7EXAMPLE for auth";
    const out = redactString(input, "balanced", FAKE_HOME);
    expect(out).toMatch(/AKIA\*\*\*REDACTED\*\*\*/);
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("masks GitHub PATs", () => {
    const input = "token=ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345abcd";
    const out = redactString(input, "balanced", FAKE_HOME);
    expect(out).toContain("ghp_");
    expect(out).toContain("***REDACTED***");
    expect(out).not.toContain("aBcDeFgHiJkLmNoPqRsTuVwXyZ012345abcd");
  });

  it("masks Stripe secrets", () => {
    // Built by concatenation so GitHub's secret scanner does not flag the
    // file as containing a Stripe key literal. The runtime value is the
    // same shape the redact regex expects (`sk_live_` + 28 alphanumerics).
    const stripePrefix = "sk_" + "live_";
    const input = `key=${stripePrefix}abcdefghijklmnopqrstuvwxyz0123`;
    expect(redactString(input, "balanced", FAKE_HOME)).toContain(
      "***REDACTED***",
    );
  });

  it("masks Slack tokens", () => {
    const input = "auth: xoxb-1234-5678-abcdef";
    expect(redactString(input, "balanced", FAKE_HOME)).toContain(
      "***REDACTED***",
    );
  });

  it("masks Bearer auth headers", () => {
    const input = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz";
    expect(redactString(input, "balanced", FAKE_HOME)).toContain(
      "***REDACTED***",
    );
  });

  it("does NOT redact hostnames in balanced mode", () => {
    const input = "DNS resolved api.example.com";
    expect(redactString(input, "balanced", FAKE_HOME)).toContain(
      "api.example.com",
    );
  });

  it("does NOT redact IPs in balanced mode", () => {
    expect(
      redactString("ping 192.168.1.1", "balanced", FAKE_HOME),
    ).toContain("192.168.1.1");
  });

  it("does NOT redact bundle IDs in balanced mode", () => {
    expect(
      redactString("com.example.myapp launched", "balanced", FAKE_HOME),
    ).toContain("com.example.myapp");
  });

  it("preserves filename-with-extension patterns (not mistaken for hosts)", () => {
    expect(
      redactString("leak.memgraph and run.trace", "balanced", FAKE_HOME),
    ).toContain("leak.memgraph");
  });
});

describe("redactString strict", () => {
  it("also redacts hostnames", () => {
    expect(
      redactString("connected to api.example.com", "strict", FAKE_HOME),
    ).toContain("***HOST***");
  });

  it("also redacts IPv4 addresses", () => {
    expect(redactString("from 192.168.1.1", "strict", FAKE_HOME)).toContain(
      "***IP***",
    );
  });

  it("also redacts bundle identifiers", () => {
    expect(
      redactString("launched com.example.app", "strict", FAKE_HOME),
    ).toContain("***BUNDLE_ID***");
  });

  it("still masks tokens like balanced does", () => {
    expect(
      redactString("AKIAIOSFODNN7EXAMPLE", "strict", FAKE_HOME),
    ).toContain("***REDACTED***");
  });

  it("does NOT touch file extensions in strict mode either", () => {
    expect(
      redactString("leak.memgraph", "strict", FAKE_HOME),
    ).toContain("leak.memgraph");
  });
});

describe("redactString off", () => {
  it("returns the input unchanged", () => {
    const input = `${FAKE_HOME}/secret/AKIAIOSFODNN7EXAMPLE/api.example.com`;
    expect(redactString(input, "off", FAKE_HOME)).toBe(input);
  });
});

describe("redact (recursive)", () => {
  it("walks objects and redacts string values", () => {
    const out = redact(
      { path: `${FAKE_HOME}/Desktop/leak.memgraph`, count: 42 },
      "balanced",
      FAKE_HOME,
    ) as { path: string; count: number };
    expect(out.path).toBe("~/Desktop/leak.memgraph");
    expect(out.count).toBe(42);
  });

  it("walks arrays", () => {
    const out = redact(
      [`${FAKE_HOME}/a`, `${FAKE_HOME}/b`, "static"],
      "balanced",
      FAKE_HOME,
    ) as string[];
    expect(out).toEqual(["~/a", "~/b", "static"]);
  });

  it("preserves object keys (only values are redacted)", () => {
    const out = redact(
      { [`${FAKE_HOME}/maybe`]: "value" },
      "balanced",
      FAKE_HOME,
    ) as Record<string, string>;
    // Key name is preserved verbatim; only the value would be scrubbed.
    // (We intentionally do not redact keys: they are schema, not data.)
    expect(Object.keys(out)).toEqual([`${FAKE_HOME}/maybe`]);
  });

  it("preserves null and undefined and number/boolean leaves", () => {
    const out = redact(
      { a: null, b: undefined, c: 0, d: false, e: 3.14 },
      "balanced",
      FAKE_HOME,
    ) as Record<string, unknown>;
    expect(out.a).toBe(null);
    expect(out.b).toBe(undefined);
    expect(out.c).toBe(0);
    expect(out.d).toBe(false);
    expect(out.e).toBe(3.14);
  });

  it("returns input unchanged when mode is off (no walk)", () => {
    const original = { path: `${FAKE_HOME}/a`, list: [1, 2, 3] };
    const out = redact(original, "off", FAKE_HOME);
    expect(out).toBe(original);
  });

  it("handles deeply nested structures", () => {
    const out = redact(
      { outer: { inner: { path: `${FAKE_HOME}/x` } } },
      "balanced",
      FAKE_HOME,
    ) as { outer: { inner: { path: string } } };
    expect(out.outer.inner.path).toBe("~/x");
  });
});

describe("maybeLogRedactionModeOnce", () => {
  beforeEach(() => {
    resetRedactionAdvisoryFlagForTests();
  });

  it("logs the active mode on first call", () => {
    const lines: string[] = [];
    maybeLogRedactionModeOnce("balanced", (l) => lines.push(l));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/redaction mode: balanced/);
  });

  it("does not log again on subsequent calls", () => {
    const lines: string[] = [];
    maybeLogRedactionModeOnce("balanced", (l) => lines.push(l));
    maybeLogRedactionModeOnce("balanced", (l) => lines.push(l));
    expect(lines.length).toBe(1);
  });

  it("logs different mode after reset", () => {
    const lines: string[] = [];
    maybeLogRedactionModeOnce("balanced", (l) => lines.push(l));
    resetRedactionAdvisoryFlagForTests();
    maybeLogRedactionModeOnce("strict", (l) => lines.push(l));
    expect(lines[1]).toMatch(/strict/);
  });
});
