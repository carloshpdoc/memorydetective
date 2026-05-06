/**
 * Internal infrastructure for driving the iOS Simulator UI from inside leak/perf
 * workflows (replayScenario, captureScenarioState). NOT a generic UI automation
 * surface, the public tool contract stays scoped to leak/perf debug.
 *
 * Wraps Cameron Cooke's `axe` CLI (https://github.com/cameroncooke/AXe).
 * `axe` is a soft dependency: we detect it on first use and emit a structured
 * install hint when missing, instead of hard-failing or bundling it.
 */

import { runCommand } from "./exec.js";

export interface AxeAvailability {
  available: boolean;
  /** Absolute path to the `axe` binary when found. */
  binaryPath?: string;
  /** Human-readable install instructions when `available === false`. */
  installHint?: string;
}

const AXE_INSTALL_HINT =
  "axe CLI not found in PATH. Install with `brew install cameroncooke/axe/axe` (https://github.com/cameroncooke/AXe). axe is a soft dependency, only required for replayScenario and captureScenarioState.";

/**
 * Check whether `axe` is available on the system. Cached at module load via
 * `which` lookup so callers can skip the call when they already know.
 */
export async function checkAxeAvailable(): Promise<AxeAvailability> {
  const result = await runCommand("which", ["axe"], { timeoutMs: 5_000 });
  if (result.code !== 0) {
    return { available: false, installHint: AXE_INSTALL_HINT };
  }
  const binaryPath = result.stdout.trim();
  if (!binaryPath) {
    return { available: false, installHint: AXE_INSTALL_HINT };
  }
  return { available: true, binaryPath };
}

export interface AxFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UIElement {
  label?: string;
  identifier?: string;
  role?: string;
  frame?: AxFrame;
  /** Raw axe payload preserved so callers can extract additional fields. */
  raw?: Record<string, unknown>;
  children?: UIElement[];
}

/**
 * Run `axe describe-ui --udid <udid>` and parse the tree into normalized
 * `UIElement` nodes. Returns the root element.
 */
export async function describeUI(udid: string): Promise<UIElement> {
  const result = await runCommand("axe", ["describe-ui", "--udid", udid], {
    timeoutMs: 30_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `axe describe-ui --udid ${udid} failed (code ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  return parseAxeDescribeUI(result.stdout);
}

/** Pure: parse `axe describe-ui` JSON output into normalized UIElement tree. */
export function parseAxeDescribeUI(stdout: string): UIElement {
  const sliced = sliceJsonValue(stdout);
  if (!sliced) {
    throw new Error(
      "axe describe-ui output did not contain a JSON object/array. Stdout begins: " +
        stdout.slice(0, 200),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(sliced);
  } catch (err) {
    throw new Error(
      `axe describe-ui output failed JSON.parse: ${(err as Error).message}`,
    );
  }
  return normalizeAxeNode(parsed);
}

function sliceJsonValue(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // axe emits a JSON object as the root.
  const objStart = trimmed.indexOf("{");
  const objEnd = trimmed.lastIndexOf("}");
  if (objStart !== -1 && objEnd > objStart) {
    return trimmed.slice(objStart, objEnd + 1);
  }
  const arrStart = trimmed.indexOf("[");
  const arrEnd = trimmed.lastIndexOf("]");
  if (arrStart !== -1 && arrEnd > arrStart) {
    return trimmed.slice(arrStart, arrEnd + 1);
  }
  return null;
}

function normalizeAxeNode(raw: unknown): UIElement {
  if (raw == null || typeof raw !== "object") {
    return { raw: {} };
  }
  const obj = raw as Record<string, unknown>;
  const out: UIElement = { raw: obj };
  const labelKey = pickFirstString(obj, [
    "AXLabel",
    "label",
    "name",
    "title",
  ]);
  if (labelKey != null) out.label = labelKey;
  const idKey = pickFirstString(obj, ["AXIdentifier", "identifier", "id"]);
  if (idKey != null) out.identifier = idKey;
  const roleKey = pickFirstString(obj, ["AXRole", "role", "type"]);
  if (roleKey != null) out.role = roleKey;
  const frame = parseAxFrame(obj);
  if (frame) out.frame = frame;
  const childrenRaw =
    (obj.children as unknown) ??
    (obj.AXChildren as unknown) ??
    (obj.subviews as unknown);
  if (Array.isArray(childrenRaw)) {
    out.children = childrenRaw.map((c) => normalizeAxeNode(c));
  }
  return out;
}

function pickFirstString(
  obj: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * Pure: parse an `AXFrame`-style frame from a node. Accepts both AppKit-style
 * dictionaries `{AXX: 0, AXY: 0, AXWidth: 100, AXHeight: 100}` and CGRect
 * strings `"{{0,0},{100,100}}"`.
 */
export function parseAxFrame(
  obj: Record<string, unknown>,
): AxFrame | undefined {
  const direct = obj.frame ?? obj.AXFrame;
  if (typeof direct === "string") {
    return parseFrameString(direct);
  }
  if (direct && typeof direct === "object") {
    const f = direct as Record<string, unknown>;
    const x = pickFirstNumber(f, ["x", "AXX", "X"]);
    const y = pickFirstNumber(f, ["y", "AXY", "Y"]);
    const w = pickFirstNumber(f, ["width", "AXWidth", "Width"]);
    const h = pickFirstNumber(f, ["height", "AXHeight", "Height"]);
    if (x != null && y != null && w != null && h != null) {
      return { x, y, width: w, height: h };
    }
  }
  // Direct top-level keys, AppKit/AX style flat.
  const x = pickFirstNumber(obj, ["AXX", "frameX"]);
  const y = pickFirstNumber(obj, ["AXY", "frameY"]);
  const w = pickFirstNumber(obj, ["AXWidth", "frameWidth"]);
  const h = pickFirstNumber(obj, ["AXHeight", "frameHeight"]);
  if (x != null && y != null && w != null && h != null) {
    return { x, y, width: w, height: h };
  }
  return undefined;
}

function pickFirstNumber(
  obj: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function parseFrameString(s: string): AxFrame | undefined {
  const match = s.match(
    /\{\{\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\}\s*,\s*\{\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\}\s*\}/,
  );
  if (!match) return undefined;
  return {
    x: parseFloat(match[1]),
    y: parseFloat(match[2]),
    width: parseFloat(match[3]),
    height: parseFloat(match[4]),
  };
}

/**
 * Pure: find the first descendant whose label or identifier matches `query`
 * (exact match preferred, falls back to substring). Walks the tree
 * depth-first.
 */
export function findElementByLabel(
  root: UIElement,
  query: string,
): UIElement | null {
  const exact = findFirst(root, (el) => el.label === query || el.identifier === query);
  if (exact) return exact;
  return findFirst(
    root,
    (el) =>
      (el.label != null && el.label.includes(query)) ||
      (el.identifier != null && el.identifier.includes(query)),
  );
}

function findFirst(
  root: UIElement,
  predicate: (el: UIElement) => boolean,
): UIElement | null {
  if (predicate(root)) return root;
  if (!root.children) return null;
  for (const child of root.children) {
    const hit = findFirst(child, predicate);
    if (hit) return hit;
  }
  return null;
}

/** Pure: compute the center point of an `AxFrame` for tap targeting. */
export function centerOf(frame: AxFrame): { x: number; y: number } {
  return {
    x: Math.round(frame.x + frame.width / 2),
    y: Math.round(frame.y + frame.height / 2),
  };
}

export type TapTarget =
  | { kind: "label"; value: string }
  | { kind: "elementId"; value: string }
  | { kind: "coords"; x: number; y: number };

/**
 * Tap on the simulator. Resolves label/elementId targets via `describe-ui`
 * before issuing the tap.
 */
export async function tap(udid: string, target: TapTarget): Promise<void> {
  let coords: { x: number; y: number };
  if (target.kind === "coords") {
    coords = { x: target.x, y: target.y };
  } else {
    const tree = await describeUI(udid);
    const query = target.value;
    const el = findElementByLabel(tree, query);
    if (!el || !el.frame) {
      throw new Error(
        `Could not locate element matching "${query}" in the current UI tree, or the element has no frame metadata.`,
      );
    }
    coords = centerOf(el.frame);
  }
  const result = await runCommand(
    "axe",
    [
      "tap",
      "--udid",
      udid,
      "-x",
      String(coords.x),
      "-y",
      String(coords.y),
    ],
    { timeoutMs: 10_000 },
  );
  if (result.code !== 0) {
    throw new Error(
      `axe tap (${coords.x},${coords.y}) failed (code ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
}

/** Swipe between two coordinates with optional duration in milliseconds. */
export async function swipe(
  udid: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  durationMs = 250,
): Promise<void> {
  const result = await runCommand(
    "axe",
    [
      "swipe",
      "--udid",
      udid,
      "--from",
      `${from.x},${from.y}`,
      "--to",
      `${to.x},${to.y}`,
      "--duration",
      String(durationMs),
    ],
    { timeoutMs: 15_000 },
  );
  if (result.code !== 0) {
    throw new Error(
      `axe swipe failed (code ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
}

/** Type a string into the currently focused field. */
export async function typeText(udid: string, text: string): Promise<void> {
  const result = await runCommand(
    "axe",
    ["type", "--udid", udid, "--text", text],
    { timeoutMs: 15_000 },
  );
  if (result.code !== 0) {
    throw new Error(
      `axe type failed (code ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
}
