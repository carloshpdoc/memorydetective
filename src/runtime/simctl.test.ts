import { describe, it, expect } from "vitest";
import {
  parseLaunchPid,
  parseSimctlDevices,
  runtimeSortKey,
} from "./simctl.js";

describe("parseLaunchPid", () => {
  it("extracts the PID from a typical launch line", () => {
    expect(
      parseLaunchPid("com.example.MyApp: 49581\n", "com.example.MyApp"),
    ).toBe(49581);
  });

  it("tolerates extra surrounding output", () => {
    const stdout = "warning: something\ncom.example.MyApp: 12345\n";
    expect(parseLaunchPid(stdout, "com.example.MyApp")).toBe(12345);
  });

  it("escapes dots in bundle ids when matching", () => {
    expect(
      parseLaunchPid("comZexampleZapp: 11111\n", "com.example.app"),
    ).toBeNull();
  });

  it("returns null when no PID line present", () => {
    expect(
      parseLaunchPid("Some unrelated output\n", "com.example.MyApp"),
    ).toBeNull();
  });

  it("returns null on non-positive PID", () => {
    expect(parseLaunchPid("com.example.MyApp: 0\n", "com.example.MyApp"))
      .toBeNull();
  });
});

describe("parseSimctlDevices", () => {
  it("flattens devices grouped by runtime", () => {
    const json = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
          {
            udid: "AAAA-1111",
            name: "iPhone 15",
            state: "Booted",
            isAvailable: true,
          },
          {
            udid: "BBBB-2222",
            name: "iPhone 15 Pro",
            state: "Shutdown",
            isAvailable: true,
          },
        ],
        "com.apple.CoreSimulator.SimRuntime.iOS-16-4": [
          {
            udid: "CCCC-3333",
            name: "iPhone 14",
            state: "Shutdown",
            isAvailable: true,
          },
        ],
      },
    });
    const devices = parseSimctlDevices(json);
    expect(devices.length).toBe(3);
    const booted = devices.find((d) => d.state === "Booted");
    expect(booted?.name).toBe("iPhone 15");
    expect(booted?.udid).toBe("AAAA-1111");
  });

  it("returns empty array when devices field missing", () => {
    expect(parseSimctlDevices(JSON.stringify({}))).toEqual([]);
  });

  it("skips entries without udid or name", () => {
    const json = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
          { udid: "AAAA-1111", state: "Booted" },
          { name: "Orphan", state: "Shutdown" },
          {
            udid: "CCCC-3333",
            name: "iPhone 14",
            state: "Shutdown",
          },
        ],
      },
    });
    const devices = parseSimctlDevices(json);
    expect(devices.length).toBe(1);
    expect(devices[0].name).toBe("iPhone 14");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseSimctlDevices("not json")).toThrow(/JSON.parse/);
  });
});

describe("runtimeSortKey", () => {
  it("orders newer runtimes higher than older", () => {
    expect(runtimeSortKey("iOS-17-5")).toBeGreaterThan(
      runtimeSortKey("iOS-16-4"),
    );
    expect(runtimeSortKey("iOS-18-0")).toBeGreaterThan(
      runtimeSortKey("iOS-17-9"),
    );
  });

  it("handles patch versions", () => {
    expect(runtimeSortKey("iOS-17-5-1")).toBeGreaterThan(
      runtimeSortKey("iOS-17-5"),
    );
  });

  it("returns 0 when no version digits found", () => {
    expect(runtimeSortKey("garbage")).toBe(0);
  });
});
