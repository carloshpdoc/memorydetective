/**
 * Parse a string env var value into a boolean using the strtobool set:
 *
 *   truthy: 1 / true / t / yes / y / on
 *   falsy:  0 / false / f / no / n / off
 *
 * Case-insensitive. Leading / trailing whitespace tolerated. The set
 * is the same one Python's `distutils.util.strtobool` uses and that
 * envalid's `bool()` accepts. v1.17 B-03.
 *
 * On unrecognized non-empty input, emits a one-time stderr warning
 * naming the env var and falls back to `defaultValue`. The warning is
 * suppressed when `MEMORYDETECTIVE_SUPPRESS_PLATFORM_ADVISORY=1` is set
 * (consistent with the rest of our advisory plumbing).
 *
 * `varName` is required so the warning surfaces a useful message; pass
 * the literal env var name (e.g. "MEMORYDETECTIVE_AUTO_OPEN_INSTRUMENTS")
 * even if you read it from another source.
 */

const TRUTHY = new Set(["1", "true", "t", "yes", "y", "on"]);
const FALSY = new Set(["0", "false", "f", "no", "n", "off"]);

const warnedVars = new Set<string>();

export function parseBooleanEnv(
  raw: string | undefined,
  defaultValue: boolean,
  varName: string,
): boolean {
  if (raw == null) return defaultValue;
  const trimmed = raw.trim();
  if (trimmed === "") return defaultValue;
  const lc = trimmed.toLowerCase();
  if (TRUTHY.has(lc)) return true;
  if (FALSY.has(lc)) return false;
  // Unrecognized non-empty value: warn once per var.
  if (
    !warnedVars.has(varName) &&
    process.env.MEMORYDETECTIVE_SUPPRESS_PLATFORM_ADVISORY !== "1"
  ) {
    warnedVars.add(varName);
    const accepted = "1 / true / t / yes / y / on | 0 / false / f / no / n / off";
    process.stderr.write(
      `[memorydetective] ${varName}="${raw}" is not a recognized boolean. Accepted (case-insensitive): ${accepted}. Falling back to default (${defaultValue}).\n`,
    );
  }
  return defaultValue;
}

/** Test-only: reset the once-per-var warning flag set. */
export function resetParseBooleanEnvWarningsForTests(): void {
  warnedVars.clear();
}
