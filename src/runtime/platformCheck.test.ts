import { describe, it, expect, beforeEach } from "vitest";
import {
  getPlatformAdvisory,
  maybeLogPlatformAdvisoryOnce,
  resetPlatformAdvisoryFlagForTests,
} from "./platformCheck.js";

const NO_ENV = {} as Readonly<Record<string, string | undefined>>;
const SUPPRESS_ENV = {
  MEMORYDETECTIVE_SUPPRESS_PLATFORM_ADVISORY: "1",
} as Readonly<Record<string, string | undefined>>;

describe("getPlatformAdvisory", () => {
  it("returns the macOS 26 advisory when Darwin major is 25", () => {
    const advisory = getPlatformAdvisory(
      NO_ENV,
      () => "darwin",
      () => "25.4.0",
    );
    expect(advisory).not.toBeNull();
    expect(advisory!.issue).toBe("macos-26-task-for-pid-broken");
    expect(advisory!.message).toMatch(/macOS 26\.x/);
    expect(advisory!.recommendedActions.length).toBeGreaterThan(0);
    expect(advisory!.recommendedActions.join("\n")).toMatch(/iOS 18/);
  });

  it("returns null on macOS 25.x / Sequoia (Darwin 24)", () => {
    const advisory = getPlatformAdvisory(
      NO_ENV,
      () => "darwin",
      () => "24.6.0",
    );
    expect(advisory).toBeNull();
  });

  it("returns null on macOS 27.x / Darwin 26 (verification pending)", () => {
    // When macOS 27 lands and we confirm Apple's kernel fix status, this
    // test will need to be revisited along with the helper. Until then,
    // be conservative and emit no advisory.
    const advisory = getPlatformAdvisory(
      NO_ENV,
      () => "darwin",
      () => "26.0.0",
    );
    expect(advisory).toBeNull();
  });

  it("returns null on Linux", () => {
    const advisory = getPlatformAdvisory(
      NO_ENV,
      () => "linux",
      () => "5.15.0",
    );
    expect(advisory).toBeNull();
  });

  it("returns null when MEMORYDETECTIVE_SUPPRESS_PLATFORM_ADVISORY=1", () => {
    const advisory = getPlatformAdvisory(
      SUPPRESS_ENV,
      () => "darwin",
      () => "25.4.0",
    );
    expect(advisory).toBeNull();
  });

  it("returns null when Darwin release string is unparseable", () => {
    const advisory = getPlatformAdvisory(
      NO_ENV,
      () => "darwin",
      () => "unknown",
    );
    expect(advisory).toBeNull();
  });
});

describe("maybeLogPlatformAdvisoryOnce", () => {
  beforeEach(() => {
    resetPlatformAdvisoryFlagForTests();
  });

  it("writes the advisory to the writer on first call", () => {
    const lines: string[] = [];
    const advisory = {
      issue: "macos-26-task-for-pid-broken" as const,
      message: "test message",
      recommendedActions: [],
    };
    maybeLogPlatformAdvisoryOnce(advisory, (l) => lines.push(l));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/platform advisory: test message/);
  });

  it("does not write on subsequent calls in the same instance", () => {
    const lines: string[] = [];
    const advisory = {
      issue: "macos-26-task-for-pid-broken" as const,
      message: "first",
      recommendedActions: [],
    };
    maybeLogPlatformAdvisoryOnce(advisory, (l) => lines.push(l));
    maybeLogPlatformAdvisoryOnce(advisory, (l) => lines.push(l));
    maybeLogPlatformAdvisoryOnce(advisory, (l) => lines.push(l));
    expect(lines.length).toBe(1);
  });

  it("does not write when advisory is null", () => {
    const lines: string[] = [];
    maybeLogPlatformAdvisoryOnce(null, (l) => lines.push(l));
    expect(lines.length).toBe(0);
  });

  it("resetPlatformAdvisoryFlagForTests lets a fresh write happen", () => {
    const lines: string[] = [];
    const advisory = {
      issue: "macos-26-task-for-pid-broken" as const,
      message: "first",
      recommendedActions: [],
    };
    maybeLogPlatformAdvisoryOnce(advisory, (l) => lines.push(l));
    resetPlatformAdvisoryFlagForTests();
    maybeLogPlatformAdvisoryOnce(advisory, (l) => lines.push(l));
    expect(lines.length).toBe(2);
  });
});
