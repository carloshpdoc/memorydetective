import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  parseBooleanEnv,
  resetParseBooleanEnvWarningsForTests,
} from "./parseBooleanEnv.js";

describe("parseBooleanEnv (v1.17 B-03)", () => {
  let stderrCalls: string[];
  const originalWrite = process.stderr.write.bind(process.stderr);

  beforeEach(() => {
    resetParseBooleanEnvWarningsForTests();
    stderrCalls = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrCalls.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    delete process.env.MEMORYDETECTIVE_SUPPRESS_PLATFORM_ADVISORY;
  });

  it("returns defaultValue when raw is undefined", () => {
    expect(parseBooleanEnv(undefined, true, "X")).toBe(true);
    expect(parseBooleanEnv(undefined, false, "X")).toBe(false);
  });

  it("returns defaultValue on empty / whitespace-only string", () => {
    expect(parseBooleanEnv("", true, "X")).toBe(true);
    expect(parseBooleanEnv("   ", false, "X")).toBe(false);
  });

  it("accepts the strtobool truthy set (case-insensitive)", () => {
    for (const v of ["1", "true", "TRUE", "True", "t", "T", "yes", "YES", "Yes", "y", "Y", "on", "ON"]) {
      expect(parseBooleanEnv(v, false, "X")).toBe(true);
    }
  });

  it("accepts the strtobool falsy set (case-insensitive)", () => {
    for (const v of ["0", "false", "FALSE", "False", "f", "F", "no", "NO", "No", "n", "N", "off", "OFF"]) {
      expect(parseBooleanEnv(v, true, "X")).toBe(false);
    }
  });

  it("tolerates leading and trailing whitespace", () => {
    expect(parseBooleanEnv("  true  ", false, "X")).toBe(true);
    expect(parseBooleanEnv("\toff\n", true, "X")).toBe(false);
  });

  it("falls back to default + warns once on unrecognized non-empty value", () => {
    expect(parseBooleanEnv("enabled", false, "MY_VAR")).toBe(false);
    expect(stderrCalls.length).toBe(1);
    expect(stderrCalls[0]).toContain("MY_VAR");
    expect(stderrCalls[0]).toContain('"enabled"');
    expect(stderrCalls[0]).toContain("not a recognized boolean");
  });

  it("only warns once per variable name", () => {
    parseBooleanEnv("enabled", false, "MY_VAR");
    parseBooleanEnv("yep", false, "MY_VAR");
    parseBooleanEnv("nope", false, "MY_VAR");
    expect(stderrCalls.length).toBe(1);
  });

  it("warns separately for different variable names", () => {
    parseBooleanEnv("enabled", false, "VAR_A");
    parseBooleanEnv("enabled", false, "VAR_B");
    expect(stderrCalls.length).toBe(2);
  });

  it("respects MEMORYDETECTIVE_SUPPRESS_PLATFORM_ADVISORY to silence warnings", () => {
    process.env.MEMORYDETECTIVE_SUPPRESS_PLATFORM_ADVISORY = "1";
    parseBooleanEnv("nope", false, "MY_VAR");
    expect(stderrCalls.length).toBe(0);
  });
});
