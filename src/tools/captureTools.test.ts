import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseDeviceListing } from "./listTraceDevices.js";
import { parseTemplateListing } from "./listTraceTemplates.js";
import {
  buildXctraceArgs,
  maybeOpenInInstruments,
  recordTimeProfileSchema,
  shouldPreflightXctrace,
} from "./recordTimeProfile.js";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureMemgraphSchema, classifyLeaksFailure } from "./captureMemgraph.js";

describe("parseDeviceListing", () => {
  it("groups devices, simulators, and offline devices", () => {
    const sample = `== Devices ==
MacBook Pro (D283C622-DE11-5668-8E1F-E6234E85E6C8)
iPhone 17 Pro Max (26.3.1) (00008150-001E449E1E99401C)

== Devices Offline ==
Apple Watch (26.3) (00008310-0005701C0E80E01E)

== Simulators ==
iPhone 11 Simulator (26.2) (4A78B3ED-E522-47D2-85BB-1B8869DEFFC1)
iPhone 17 Simulator (26.2) (0F4D5D74-A4FE-4261-9596-8073565E7927)`;
    const out = parseDeviceListing(sample);
    expect(out.length).toBe(5);
    expect(out.find((d) => d.kind === "device" && d.osVersion === "26.3.1"))
      .toBeDefined();
    expect(out.filter((d) => d.kind === "simulator").length).toBe(2);
    expect(out.filter((d) => d.kind === "device-offline").length).toBe(1);
    const phys = out.find((d) =>
      d.name.startsWith("iPhone 17 Pro Max"),
    );
    expect(phys?.udid).toBe("00008150-001E449E1E99401C");
  });

  it("handles devices without OS version (host Mac)", () => {
    const sample = `== Devices ==
Mac Studio (D283C622-DE11-5668-8E1F-E6234E85E6C8)`;
    const out = parseDeviceListing(sample);
    expect(out.length).toBe(1);
    expect(out[0].osVersion).toBeUndefined();
  });
});

describe("parseTemplateListing", () => {
  it("collects standard template names", () => {
    const sample = `== Standard Templates ==
Activity Monitor
Allocations
Animation Hitches
Time Profiler
== Custom Templates ==
My Custom Template`;
    const out = parseTemplateListing(sample);
    expect(out.length).toBe(5);
    expect(out.filter((t) => t.category === "standard").length).toBe(4);
    expect(out.find((t) => t.name === "Time Profiler")?.category).toBe(
      "standard",
    );
    expect(out.find((t) => t.name === "My Custom Template")?.category).toBe(
      "custom",
    );
  });
});

describe("recordTimeProfile schema validation", () => {
  it("rejects missing target (no deviceId or simulatorId)", () => {
    const r = recordTimeProfileSchema.safeParse({
      attachAppName: "DemoApp",
      output: "/tmp/foo.trace",
    });
    expect(r.success).toBe(false);
  });

  it("rejects providing both deviceId and simulatorId", () => {
    const r = recordTimeProfileSchema.safeParse({
      deviceId: "00008150-001E449E1E99401C",
      simulatorId: "4A78B3ED-E522-47D2-85BB-1B8869DEFFC1",
      attachAppName: "DemoApp",
      output: "/tmp/foo.trace",
    });
    expect(r.success).toBe(false);
  });

  it("rejects providing zero attach options", () => {
    const r = recordTimeProfileSchema.safeParse({
      deviceId: "00008150-001E449E1E99401C",
      output: "/tmp/foo.trace",
    });
    expect(r.success).toBe(false);
  });

  it("rejects providing two attach options", () => {
    const r = recordTimeProfileSchema.safeParse({
      deviceId: "00008150-001E449E1E99401C",
      attachAppName: "DemoApp",
      attachPid: 123,
      output: "/tmp/foo.trace",
    });
    expect(r.success).toBe(false);
  });

  it("rejects output not ending in .trace", () => {
    const r = recordTimeProfileSchema.safeParse({
      deviceId: "00008150-001E449E1E99401C",
      attachAppName: "DemoApp",
      output: "/tmp/foo.txt",
    });
    expect(r.success).toBe(false);
  });

  it("accepts a valid input and produces correct argv", () => {
    const r = recordTimeProfileSchema.safeParse({
      deviceId: "00008150-001E449E1E99401C",
      attachAppName: "DemoApp",
      durationSec: 90,
      output: "/tmp/run.trace",
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    const args = buildXctraceArgs(r.data);
    expect(args).toContain("--template");
    expect(args).toContain("Time Profiler");
    expect(args).toContain("--device");
    expect(args).toContain("00008150-001E449E1E99401C");
    expect(args).toContain("--attach");
    expect(args).toContain("DemoApp");
    expect(args).toContain("--time-limit");
    expect(args).toContain("90s");
    expect(args).toContain("--output");
    expect(args).toContain("/tmp/run.trace");
  });
});

describe("captureMemgraph schema validation", () => {
  it("rejects when neither pid nor appName given", () => {
    const r = captureMemgraphSchema.safeParse({ output: "/tmp/foo.memgraph" });
    expect(r.success).toBe(false);
  });

  it("rejects when both pid and appName given", () => {
    const r = captureMemgraphSchema.safeParse({
      pid: 123,
      appName: "DemoApp",
      output: "/tmp/foo.memgraph",
    });
    expect(r.success).toBe(false);
  });

  it("rejects output not ending in .memgraph", () => {
    const r = captureMemgraphSchema.safeParse({
      pid: 123,
      output: "/tmp/foo.trace",
    });
    expect(r.success).toBe(false);
  });

  it("accepts valid input with pid", () => {
    const r = captureMemgraphSchema.safeParse({
      pid: 123,
      output: "/tmp/foo.memgraph",
    });
    expect(r.success).toBe(true);
  });

  it("accepts valid input with appName", () => {
    const r = captureMemgraphSchema.safeParse({
      appName: "DemoApp",
      output: "/tmp/foo.memgraph",
    });
    expect(r.success).toBe(true);
  });
});

describe("classifyLeaksFailure", () => {
  it("returns null on success exit codes (0 = clean, 1 = leaks found)", () => {
    expect(
      classifyLeaksFailure({ code: 0, stdout: "", stderr: "" }),
    ).toBeNull();
    expect(
      classifyLeaksFailure({ code: 1, stdout: "", stderr: "" }),
    ).toBeNull();
  });

  it("flags minimal-corpse on macOS 26.x DYLD info failures", () => {
    const stderr =
      "leaks: Failed to get DYLD info for task from parent of minimal corpse";
    expect(classifyLeaksFailure({ code: 2, stdout: "", stderr })).toBe(
      "minimal-corpse",
    );
  });

  it("flags minimal-corpse on the corpse-task variant", () => {
    const stderr = "task_create_corpse failed: 0x5 (KERN_FAILURE)";
    expect(classifyLeaksFailure({ code: 2, stdout: "", stderr })).toBe(
      "minimal-corpse",
    );
  });

  it("flags permission-denied on task_for_pid failures", () => {
    const stderr = "task_for_pid(...) failed: insufficient privileges";
    expect(classifyLeaksFailure({ code: 2, stdout: "", stderr })).toBe(
      "permission-denied",
    );
  });

  it("flags leaks-not-found when shell exits 127", () => {
    expect(
      classifyLeaksFailure({
        code: 127,
        stdout: "",
        stderr: "leaks: command not found",
      }),
    ).toBe("leaks-not-found");
  });

  it("falls back to transient on unrecognized non-zero exits", () => {
    expect(
      classifyLeaksFailure({ code: 2, stdout: "", stderr: "weird error" }),
    ).toBe("transient");
  });

  it("upgrades minimal-corpse to macos-26-task-for-pid-broken when isMacOS26", () => {
    // Same stderr pattern as the standalone minimal-corpse case, but with
    // platform context: the caller (captureMemgraph) detected we are on
    // macOS 26.x and threads that signal through. The classifier swaps the
    // issue id so the workaround notice names the root cause (Apple-side
    // kernel regression) instead of implying it is a per-process config issue.
    const stderr =
      "leaks: Failed to get DYLD info for task from parent of minimal corpse";
    expect(classifyLeaksFailure({ code: 2, stdout: "", stderr }, true)).toBe(
      "macos-26-task-for-pid-broken",
    );
    expect(classifyLeaksFailure({ code: 2, stdout: "", stderr }, false)).toBe(
      "minimal-corpse",
    );
  });

  it("does not upgrade permission-denied or transient based on platform", () => {
    // Only the minimal-corpse signature gets the macOS 26 escalation. Other
    // failure modes (permission denied, leaks-not-found, transient) keep
    // their existing issue ids regardless of the platform context, because
    // those modes have causes orthogonal to the task_for_pid regression.
    const permStderr = "task_for_pid(...) failed: insufficient privileges";
    expect(
      classifyLeaksFailure({ code: 2, stdout: "", stderr: permStderr }, true),
    ).toBe("permission-denied");
    expect(
      classifyLeaksFailure({ code: 2, stdout: "", stderr: "weird error" }, true),
    ).toBe("transient");
  });
});

describe("maybeOpenInInstruments (v1.14 item J)", () => {
  // The helper is the env-gate + filesystem-exists check around `open -a
  // Instruments`. We assert behavior without actually launching Instruments
  // by toggling the env flag and pointing at trace paths that may or may
  // not exist on disk. The `spawn` call returns immediately via detached +
  // unref so even when the env flag is set the test still completes
  // synchronously; on a sandboxed CI runner the open invocation will fail
  // harmlessly (the helper swallows the error).

  const ORIGINAL_ENV = process.env.MEMORYDETECTIVE_AUTO_OPEN_INSTRUMENTS;
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = join(tmpdir(), `md-auto-open-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(scratchDir, { recursive: true });
  });

  afterEach(() => {
    process.env.MEMORYDETECTIVE_AUTO_OPEN_INSTRUMENTS = ORIGINAL_ENV;
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  });

  it("returns false when env flag is unset (default behavior, no GUI spam)", () => {
    delete process.env.MEMORYDETECTIVE_AUTO_OPEN_INSTRUMENTS;
    const tracePath = join(scratchDir, "phantom.trace");
    expect(maybeOpenInInstruments(tracePath)).toBe(false);
  });

  it("returns false when env flag is set but trace bundle does not exist", () => {
    process.env.MEMORYDETECTIVE_AUTO_OPEN_INSTRUMENTS = "1";
    const tracePath = join(scratchDir, "phantom.trace");
    expect(maybeOpenInInstruments(tracePath)).toBe(false);
  });

  it("returns true when env flag is set AND trace bundle exists on disk", () => {
    process.env.MEMORYDETECTIVE_AUTO_OPEN_INSTRUMENTS = "1";
    const tracePath = join(scratchDir, "real.trace");
    mkdirSync(tracePath); // trace bundle is a directory
    expect(maybeOpenInInstruments(tracePath)).toBe(true);
  });

  it("rejects values other than '1' for the env flag (no accidental opt-in)", () => {
    process.env.MEMORYDETECTIVE_AUTO_OPEN_INSTRUMENTS = "true";
    const tracePath = join(scratchDir, "real.trace");
    mkdirSync(tracePath);
    expect(maybeOpenInInstruments(tracePath)).toBe(false);

    process.env.MEMORYDETECTIVE_AUTO_OPEN_INSTRUMENTS = "0";
    expect(maybeOpenInInstruments(tracePath)).toBe(false);

    process.env.MEMORYDETECTIVE_AUTO_OPEN_INSTRUMENTS = "yes";
    expect(maybeOpenInInstruments(tracePath)).toBe(false);
  });
});

describe("shouldPreflightXctrace (v1.14 item H)", () => {
  // The gating helper decides whether to fire the 2s probe before the
  // user's actual recording. We test the three control axes: env flag,
  // platform, and target/mode combination. Platform detection is
  // injectable via osPlatform/osRelease params so tests can simulate
  // non-macOS-26 hosts even when running on a real macOS 26.x machine.

  const SIM_ATTACH_INPUT = {
    template: "Time Profiler",
    simulatorId: "ABCDEF12-3456",
    attachPid: 4321,
    durationSec: 30,
    output: "/tmp/x.trace",
  } as const;
  const macOS26 = () => "darwin" as NodeJS.Platform;
  const release26 = () => "25.4.0"; // Darwin 25.x = macOS 26.x
  const macOS25 = () => "darwin" as NodeJS.Platform;
  const release25 = () => "24.4.0"; // Darwin 24.x = macOS 25 / Sequoia

  it("env=1 forces preflight ON regardless of platform or target", () => {
    const env = { MEMORYDETECTIVE_PREFLIGHT_XCTRACE: "1" };
    expect(
      shouldPreflightXctrace(SIM_ATTACH_INPUT, env, macOS25, release25),
    ).toBe(true);
  });

  it("env=0 forces preflight OFF even on macOS 26.x sim attach", () => {
    const env = { MEMORYDETECTIVE_PREFLIGHT_XCTRACE: "0" };
    expect(
      shouldPreflightXctrace(SIM_ATTACH_INPUT, env, macOS26, release26),
    ).toBe(false);
  });

  it("default auto-enables on macOS 26.x sim attach (the known-broken combo)", () => {
    expect(
      shouldPreflightXctrace(SIM_ATTACH_INPUT, {}, macOS26, release26),
    ).toBe(true);
  });

  it("default skips on macOS 25 (no regression there)", () => {
    expect(
      shouldPreflightXctrace(SIM_ATTACH_INPUT, {}, macOS25, release25),
    ).toBe(false);
  });

  it("default skips on physical device targets even on macOS 26.x", () => {
    const physicalDeviceInput = {
      ...SIM_ATTACH_INPUT,
      simulatorId: undefined,
      deviceId: "00008150-001E449E1E99401C",
    };
    expect(
      shouldPreflightXctrace(physicalDeviceInput, {}, macOS26, release26),
    ).toBe(false);
  });

  it("default skips --launch mode (would double-launch the app)", () => {
    const launchInput = {
      template: "Time Profiler",
      simulatorId: "ABCDEF12-3456",
      launchBundleId: "com.example.MyApp",
      durationSec: 30,
      output: "/tmp/x.trace",
    };
    expect(shouldPreflightXctrace(launchInput, {}, macOS26, release26)).toBe(
      false,
    );
  });

  it("MEMORYDETECTIVE_SUPPRESS_PLATFORM_ADVISORY=1 disables the auto-enable path", () => {
    // The macOS advisory short-circuits when the suppress flag is set,
    // so the auto-enable arm also short-circuits. Useful for users who
    // have decided on a workaround and want to keep recordTimeProfile
    // fast-path.
    const env = { MEMORYDETECTIVE_SUPPRESS_PLATFORM_ADVISORY: "1" };
    expect(
      shouldPreflightXctrace(SIM_ATTACH_INPUT, env, macOS26, release26),
    ).toBe(false);
  });
});
