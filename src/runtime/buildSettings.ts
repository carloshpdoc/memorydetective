/**
 * Pure parser for `xcodebuild -showBuildSettings -json` output.
 *
 * `xcodebuild` emits a JSON array of `{action, target, buildSettings}` objects
 * on stdout, but may print non-JSON warnings on stderr/stdout before or after
 * the array. We slice from the first `[` to the last `]` to extract the JSON
 * payload defensively.
 *
 * When multiple targets exist (e.g. an aggregate target alongside the app
 * target), we pick the one whose build settings declare `WRAPPER_EXTENSION === "app"`,
 * which is the actual application bundle.
 */

export interface BuildSettings {
  /** Absolute path to the build products directory (where the .app lands). */
  builtProductsDir: string;
  /** Bundle wrapper name, e.g. `MyApp.app`. */
  wrapperName: string;
  /** Executable name inside the bundle, e.g. `MyApp`. Used for `pgrep -ax`. */
  executableName: string;
  /** App bundle identifier, e.g. `com.example.MyApp`. */
  productBundleIdentifier: string;
}

interface XcodebuildSettingsEntry {
  action?: string;
  target?: string;
  buildSettings?: Record<string, string>;
}

const REQUIRED_KEYS: Array<keyof BuildSettings> = [
  "builtProductsDir",
  "wrapperName",
  "executableName",
  "productBundleIdentifier",
];

const KEY_MAP: Record<keyof BuildSettings, string> = {
  builtProductsDir: "BUILT_PRODUCTS_DIR",
  wrapperName: "WRAPPER_NAME",
  executableName: "EXECUTABLE_NAME",
  productBundleIdentifier: "PRODUCT_BUNDLE_IDENTIFIER",
};

/**
 * Parse `xcodebuild -showBuildSettings -json` stdout. Throws when the output
 * cannot be parsed or when the matched target is missing required keys.
 */
export function parseBuildSettingsJson(stdout: string): BuildSettings {
  const sliced = sliceJsonArray(stdout);
  if (!sliced) {
    throw new Error(
      "xcodebuild -showBuildSettings -json output did not contain a JSON array. Stdout begins: " +
        stdout.slice(0, 200),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(sliced);
  } catch (err) {
    throw new Error(
      `xcodebuild -showBuildSettings -json output failed JSON.parse: ${(err as Error).message}`,
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      "xcodebuild -showBuildSettings -json returned an empty array — no targets found for the given scheme/destination.",
    );
  }
  const entries = parsed as XcodebuildSettingsEntry[];
  const appEntry = pickAppTarget(entries);
  if (!appEntry || !appEntry.buildSettings) {
    throw new Error(
      "Could not find a target with WRAPPER_EXTENSION=app in -showBuildSettings output. Verify the scheme builds an iOS application bundle.",
    );
  }
  const settings = appEntry.buildSettings;
  const result: Partial<BuildSettings> = {};
  for (const key of REQUIRED_KEYS) {
    const xcodeKey = KEY_MAP[key];
    const value = settings[xcodeKey];
    if (!value || value.length === 0) {
      throw new Error(
        `xcodebuild -showBuildSettings missing required key '${xcodeKey}' for target '${appEntry.target ?? "<unknown>"}'. Cannot proceed without this value.`,
      );
    }
    result[key] = value;
  }
  return result as BuildSettings;
}

/**
 * Locate the JSON array within stdout. Returns the substring `[...]` or null
 * when no balanced array is found.
 */
function sliceJsonArray(stdout: string): string | null {
  const start = stdout.indexOf("[");
  if (start === -1) return null;
  const end = stdout.lastIndexOf("]");
  if (end === -1 || end <= start) return null;
  return stdout.slice(start, end + 1);
}

/**
 * Pick the entry whose build settings indicate an application bundle. When
 * multiple match, the first wins — this is rare in practice and the caller
 * can always pass a more specific scheme to disambiguate.
 */
function pickAppTarget(
  entries: XcodebuildSettingsEntry[],
): XcodebuildSettingsEntry | null {
  for (const entry of entries) {
    if (entry.buildSettings?.WRAPPER_EXTENSION === "app") {
      return entry;
    }
  }
  return null;
}
