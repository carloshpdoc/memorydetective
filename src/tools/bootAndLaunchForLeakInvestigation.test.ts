import { describe, it, expect } from "vitest";
import {
  bootAndLaunchForLeakInvestigationSchema,
  pickHostPidFromPs,
} from "./bootAndLaunchForLeakInvestigation.js";

describe("bootAndLaunchForLeakInvestigation schema", () => {
  it("accepts a valid input with workspace + scheme", () => {
    const r = bootAndLaunchForLeakInvestigationSchema.safeParse({
      workspace: "/path/MyApp.xcworkspace",
      scheme: "MyApp",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a valid input with project + scheme", () => {
    const r = bootAndLaunchForLeakInvestigationSchema.safeParse({
      project: "/path/MyApp.xcodeproj",
      scheme: "MyApp",
    });
    expect(r.success).toBe(true);
  });

  it("rejects when neither workspace nor project is given", () => {
    const r = bootAndLaunchForLeakInvestigationSchema.safeParse({
      scheme: "MyApp",
    });
    expect(r.success).toBe(false);
  });

  it("rejects when both workspace and project are given", () => {
    const r = bootAndLaunchForLeakInvestigationSchema.safeParse({
      workspace: "/path/MyApp.xcworkspace",
      project: "/path/MyApp.xcodeproj",
      scheme: "MyApp",
    });
    expect(r.success).toBe(false);
  });

  it("rejects missing scheme", () => {
    const r = bootAndLaunchForLeakInvestigationSchema.safeParse({
      workspace: "/path/MyApp.xcworkspace",
    });
    expect(r.success).toBe(false);
  });

  it("applies defaults for configuration, buildBeforeLaunch, warmupSeconds, launchArgs", () => {
    const r = bootAndLaunchForLeakInvestigationSchema.safeParse({
      workspace: "/path/MyApp.xcworkspace",
      scheme: "MyApp",
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.configuration).toBe("Debug");
    expect(r.data.buildBeforeLaunch).toBe(true);
    expect(r.data.warmupSeconds).toBe(3);
    expect(r.data.launchArgs).toEqual([]);
  });

  it("accepts a simulator selector with udid", () => {
    const r = bootAndLaunchForLeakInvestigationSchema.safeParse({
      workspace: "/path/MyApp.xcworkspace",
      scheme: "MyApp",
      simulator: { udid: "AAAA-1111" },
    });
    expect(r.success).toBe(true);
  });

  it("accepts a simulator selector with name + os", () => {
    const r = bootAndLaunchForLeakInvestigationSchema.safeParse({
      workspace: "/path/MyApp.xcworkspace",
      scheme: "MyApp",
      simulator: { name: "iPhone 15", os: "latest" },
    });
    expect(r.success).toBe(true);
  });

  it("clamps warmupSeconds upper bound", () => {
    const r = bootAndLaunchForLeakInvestigationSchema.safeParse({
      workspace: "/path/MyApp.xcworkspace",
      scheme: "MyApp",
      warmupSeconds: 999,
    });
    expect(r.success).toBe(false);
  });
});

describe("pickHostPidFromPs", () => {
  const udid = "ABCD-1234-EFGH-5678";

  it("picks the host PID matching UDID + executable suffix", () => {
    const ps = `
  47512 /Applications/Safari.app/Contents/MacOS/Safari
  49581 /Users/me/Library/Developer/CoreSimulator/Devices/${udid}/data/Containers/Bundle/Application/UUID/MyApp.app/MyApp
  49600 /usr/sbin/cron
`;
    expect(pickHostPidFromPs(ps, udid, "MyApp")).toBe(49581);
  });

  it("ignores processes from other simulators", () => {
    const otherUdid = "0000-OTHER-9999";
    const ps = `
  49581 /Users/me/Library/Developer/CoreSimulator/Devices/${otherUdid}/data/Bundle/MyApp.app/MyApp
  49582 /Users/me/Library/Developer/CoreSimulator/Devices/${udid}/data/Bundle/MyApp.app/MyApp
`;
    expect(pickHostPidFromPs(ps, udid, "MyApp")).toBe(49582);
  });

  it("returns null when nothing matches", () => {
    const ps = `  47512 /Applications/Safari.app/Contents/MacOS/Safari\n`;
    expect(pickHostPidFromPs(ps, udid, "MyApp")).toBeNull();
  });

  it("returns null when multiple host processes match (ambiguous)", () => {
    const ps = `
  49581 /Users/me/Library/Developer/CoreSimulator/Devices/${udid}/data/Bundle/A/MyApp.app/MyApp
  49582 /Users/me/Library/Developer/CoreSimulator/Devices/${udid}/data/Bundle/B/MyApp.app/MyApp
`;
    expect(pickHostPidFromPs(ps, udid, "MyApp")).toBeNull();
  });

  it("matches long executable names that pgrep -x would silently miss", () => {
    const longName = "VeryLongExecutableNameThatExceedsFifteenChars";
    const ps = `
  49581 /Users/me/Library/Developer/CoreSimulator/Devices/${udid}/data/Bundle/MyApp.app/${longName}
`;
    expect(pickHostPidFromPs(ps, udid, longName)).toBe(49581);
  });

  it("does not match a substring that ends with the executable name", () => {
    const ps = `
  49581 /Users/me/Library/Developer/CoreSimulator/Devices/${udid}/data/Bundle/NotMyApp/NotMyApp
`;
    // suffix is "/MyApp" which doesn't end NotMyApp's path
    expect(pickHostPidFromPs(ps, udid, "MyApp")).toBeNull();
  });

  it("ignores leading whitespace and tolerates extra args after the binary path", () => {
    const ps = `
       49581    /Users/me/Library/Developer/CoreSimulator/Devices/${udid}/data/Bundle/MyApp.app/MyApp -someArg value
`;
    expect(pickHostPidFromPs(ps, udid, "MyApp")).toBe(49581);
  });
});
