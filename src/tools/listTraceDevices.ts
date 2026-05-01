import { z } from "zod";
import { runCommand } from "../runtime/exec.js";

export const listTraceDevicesSchema = z.object({
  includeOffline: z
    .boolean()
    .default(false)
    .describe("Include devices listed under \"Devices Offline\" (default false)."),
});

export type ListTraceDevicesInput = z.infer<typeof listTraceDevicesSchema>;

export type DeviceKind = "device" | "device-offline" | "simulator";

export interface TraceDevice {
  kind: DeviceKind;
  name: string;
  /** OS version when the listing carries one (e.g. "26.3.1"). */
  osVersion?: string;
  udid: string;
}

export interface ListTraceDevicesResult {
  ok: boolean;
  devices: TraceDevice[];
}

const SECTION_TO_KIND: Record<string, DeviceKind> = {
  "== Devices ==": "device",
  "== Devices Offline ==": "device-offline",
  "== Simulators ==": "simulator",
};

const LINE_RE =
  /^(.+?)(?:\s*\(([0-9.]+)\))?\s*\(([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}|[0-9A-F]{8}-[0-9A-F]{16})\)\s*$/i;

/** Pure: parse `xctrace list devices` output. */
export function parseDeviceListing(text: string): TraceDevice[] {
  const lines = text.split(/\r?\n/);
  let kind: DeviceKind | null = null;
  const devices: TraceDevice[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line in SECTION_TO_KIND) {
      kind = SECTION_TO_KIND[line];
      continue;
    }
    if (!kind) continue;
    const m = line.match(LINE_RE);
    if (!m) continue;
    devices.push({
      kind,
      name: m[1].trim(),
      osVersion: m[2],
      udid: m[3],
    });
  }
  return devices;
}

export async function listTraceDevices(
  input: ListTraceDevicesInput,
): Promise<ListTraceDevicesResult> {
  const result = await runCommand("xcrun", ["xctrace", "list", "devices"], {
    timeoutMs: 30_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `xctrace list devices failed (code ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  let devices = parseDeviceListing(result.stdout);
  if (!input.includeOffline) {
    devices = devices.filter((d) => d.kind !== "device-offline");
  }
  return { ok: true, devices };
}
