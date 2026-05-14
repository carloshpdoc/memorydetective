import { describe, it, expect } from "vitest";
import {
  getSecurityFlags,
  defaultTraceRoot,
  DEFAULT_MAX_RECORDING_SECONDS,
  ALLOW_LAUNCH_REQUIRED_MESSAGE,
  maxRecordingExceededMessage,
} from "./securityFlags.js";

const FAKE_HOME = "/Users/test";

describe("getSecurityFlags", () => {
  describe("allowLaunch", () => {
    it("defaults to false when env var is unset", () => {
      expect(getSecurityFlags({}, FAKE_HOME).allowLaunch).toBe(false);
    });

    it("is true only when MEMORYDETECTIVE_ALLOW_LAUNCH=1", () => {
      expect(
        getSecurityFlags(
          { MEMORYDETECTIVE_ALLOW_LAUNCH: "1" },
          FAKE_HOME,
        ).allowLaunch,
      ).toBe(true);
    });

    it("stays false on common-but-non-literal-1 truthy values", () => {
      // Deliberately strict: the gate is explicit, not "anything truthy".
      // Operators reading their shell history should see exactly the value
      // that turned the gate on.
      expect(
        getSecurityFlags(
          { MEMORYDETECTIVE_ALLOW_LAUNCH: "true" },
          FAKE_HOME,
        ).allowLaunch,
      ).toBe(false);
      expect(
        getSecurityFlags(
          { MEMORYDETECTIVE_ALLOW_LAUNCH: "yes" },
          FAKE_HOME,
        ).allowLaunch,
      ).toBe(false);
      expect(
        getSecurityFlags(
          { MEMORYDETECTIVE_ALLOW_LAUNCH: "0" },
          FAKE_HOME,
        ).allowLaunch,
      ).toBe(false);
    });
  });

  describe("maxRecordingSeconds", () => {
    it("defaults to 300 when env var is unset", () => {
      expect(getSecurityFlags({}, FAKE_HOME).maxRecordingSeconds).toBe(300);
      expect(DEFAULT_MAX_RECORDING_SECONDS).toBe(300);
    });

    it("respects a custom positive integer", () => {
      expect(
        getSecurityFlags(
          { MEMORYDETECTIVE_MAX_RECORDING_SECONDS: "60" },
          FAKE_HOME,
        ).maxRecordingSeconds,
      ).toBe(60);
    });

    it("clamps at 3600 (1 hour) to prevent absurd configs from disabling the gate", () => {
      expect(
        getSecurityFlags(
          { MEMORYDETECTIVE_MAX_RECORDING_SECONDS: "999999" },
          FAKE_HOME,
        ).maxRecordingSeconds,
      ).toBe(3600);
    });

    it("falls back to default on non-positive / non-numeric values", () => {
      expect(
        getSecurityFlags(
          { MEMORYDETECTIVE_MAX_RECORDING_SECONDS: "0" },
          FAKE_HOME,
        ).maxRecordingSeconds,
      ).toBe(300);
      expect(
        getSecurityFlags(
          { MEMORYDETECTIVE_MAX_RECORDING_SECONDS: "-10" },
          FAKE_HOME,
        ).maxRecordingSeconds,
      ).toBe(300);
      expect(
        getSecurityFlags(
          { MEMORYDETECTIVE_MAX_RECORDING_SECONDS: "abc" },
          FAKE_HOME,
        ).maxRecordingSeconds,
      ).toBe(300);
      expect(
        getSecurityFlags(
          { MEMORYDETECTIVE_MAX_RECORDING_SECONDS: "" },
          FAKE_HOME,
        ).maxRecordingSeconds,
      ).toBe(300);
    });
  });

  describe("traceRoot", () => {
    it("defaults to ~/Library/Application Support/memorydetective/traces", () => {
      expect(getSecurityFlags({}, FAKE_HOME).traceRoot).toBe(
        `${FAKE_HOME}/Library/Application Support/memorydetective/traces`,
      );
    });

    it("respects MEMORYDETECTIVE_TRACE_ROOT when set", () => {
      expect(
        getSecurityFlags(
          { MEMORYDETECTIVE_TRACE_ROOT: "/tmp/my-traces" },
          FAKE_HOME,
        ).traceRoot,
      ).toBe("/tmp/my-traces");
    });

    it("falls back to default on empty string", () => {
      expect(
        getSecurityFlags(
          { MEMORYDETECTIVE_TRACE_ROOT: "" },
          FAKE_HOME,
        ).traceRoot,
      ).toBe(`${FAKE_HOME}/Library/Application Support/memorydetective/traces`);
    });
  });
});

describe("defaultTraceRoot", () => {
  it("joins the standard path under the given home dir", () => {
    expect(defaultTraceRoot("/Users/alice")).toBe(
      "/Users/alice/Library/Application Support/memorydetective/traces",
    );
  });
});

describe("ALLOW_LAUNCH_REQUIRED_MESSAGE", () => {
  it("mentions the env var name and the underlying commands", () => {
    expect(ALLOW_LAUNCH_REQUIRED_MESSAGE).toContain(
      "MEMORYDETECTIVE_ALLOW_LAUNCH=1",
    );
    expect(ALLOW_LAUNCH_REQUIRED_MESSAGE).toContain("xcodebuild");
  });
});

describe("maxRecordingExceededMessage", () => {
  it("references the requested + capped values plus the env var", () => {
    const msg = maxRecordingExceededMessage(600, 300);
    expect(msg).toContain("600");
    expect(msg).toContain("300");
    expect(msg).toContain("MEMORYDETECTIVE_MAX_RECORDING_SECONDS");
  });
});
