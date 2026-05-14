/**
 * Redact sensitive substrings from tool responses before they leave the
 * MCP boundary.
 *
 * Tool outputs frequently include filesystem paths (with the user's home
 * directory in them), token-shaped strings, hostnames, IP addresses, and
 * bundle identifiers. None of those are useful to an AI agent reasoning
 * about an iOS leak, and all of them are footguns when the output ends
 * up in a Slack message, a PR comment, or a screenshot. This module
 * scrubs them at the formatter boundary so by-default outputs are safe
 * to share without manual sweeping.
 *
 * Three modes are selected via the `MEMORYDETECTIVE_REDACTION` env var:
 *
 * - `balanced` (default): home-directory absolute paths become `~/...`,
 *   common secret-shaped tokens (AWS keys, GitHub PATs, Stripe secrets,
 *   Slack tokens, Bearer auth) are masked. Hostnames, IPs, bundle IDs,
 *   process names, and class names are preserved (they are usually
 *   useful for debugging).
 *
 * - `strict`: everything in `balanced`, plus hostnames, IPv4 addresses,
 *   and bundle identifiers. Use when the output is going to be pasted
 *   into a public artifact (issue tracker, blog post, social) and you
 *   want a wide safety margin.
 *
 * - `off`: no redaction. Default behavior is preserved for legacy
 *   workflows and for local-only debugging where the noise is genuinely
 *   helpful. The startup banner logs the active mode so an operator
 *   running `off` knows the responses are unfiltered.
 *
 * Redaction is structural: the value passed in keeps its shape (same
 * object keys, same array lengths, same scalar types), only string
 * leaves are rewritten. Numbers, booleans, null/undefined, and dates
 * pass through unchanged.
 */

import os from "node:os";

export type RedactionMode = "balanced" | "strict" | "off";

const TOKEN_PATTERNS: Array<{ re: RegExp; keepPrefix: number }> = [
  // AWS access key id (AKIA + 16 chars)
  { re: /\bAKIA[0-9A-Z]{16}\b/g, keepPrefix: 4 },
  // GitHub classic PAT
  { re: /\bghp_[A-Za-z0-9]{36,}\b/g, keepPrefix: 4 },
  // GitHub fine-grained PAT
  { re: /\bgithub_pat_[A-Za-z0-9_]+\b/g, keepPrefix: 11 },
  // Stripe live + test secret
  { re: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/g, keepPrefix: 8 },
  // Slack tokens
  { re: /\bxox[bpoasr]-[A-Za-z0-9-]+\b/g, keepPrefix: 5 },
  // Bearer auth tokens
  { re: /\bBearer\s+[A-Za-z0-9._\-]{20,}\b/gi, keepPrefix: 7 },
];

// Hostnames: 1+ labels followed by a TLD (2+ alpha chars). Excludes the
// .swift / .ts / .js / .json / .trace / .memgraph "extensions" we see in
// paths, since those would false-positive otherwise.
const HOST_PATTERN =
  /\b(?!(?:[A-Za-z0-9-]+)\.(?:swift|ts|js|json|trace|memgraph|md|yaml|yml|html|png|jpg|jpeg|gif|m4v|mp4|mov|css|sh|py|rb|go|rs|c|cpp|h|hpp|m|mm|plist|xcframework|xcconfig|xcassets)\b)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/gi;

const IP_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const BUNDLE_ID_PATTERN = /\bcom\.[a-z0-9_-]+(?:\.[a-z0-9_-]+)+\b/gi;

/**
 * Pure: read the active redaction mode from an env-like object.
 * Defaults to `balanced` when unset or set to an unrecognized value.
 *
 * Threaded as a parameter for testability; production callers omit it
 * and get `process.env`.
 */
export function getRedactionMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RedactionMode {
  const raw = (env.MEMORYDETECTIVE_REDACTION ?? "balanced").toLowerCase();
  if (raw === "off" || raw === "strict" || raw === "balanced") {
    return raw;
  }
  return "balanced";
}

/**
 * Pure: scrub a single string per the active mode. `off` returns the
 * input unchanged; the other modes apply the rules described in the
 * module doc.
 *
 * Threaded `homeDir` for testability so unit tests can pass a fake
 * `/Users/test/` without depending on the real home directory.
 */
export function redactString(
  input: string,
  mode: RedactionMode,
  homeDir: string = os.homedir(),
): string {
  if (mode === "off") return input;
  let result = input;
  // Home dir collapse first so subsequent host/IP rules don't mistakenly
  // grab parts of paths.
  if (homeDir && homeDir.length > 1 && result.includes(homeDir)) {
    result = result.split(homeDir).join("~");
  }
  // Always mask token-shaped secrets, even in `balanced`.
  for (const { re, keepPrefix } of TOKEN_PATTERNS) {
    result = result.replace(re, (match) =>
      match.slice(0, keepPrefix) + "***REDACTED***",
    );
  }
  if (mode === "strict") {
    result = result.replace(BUNDLE_ID_PATTERN, "***BUNDLE_ID***");
    result = result.replace(IP_PATTERN, "***IP***");
    result = result.replace(HOST_PATTERN, "***HOST***");
  }
  return result;
}

/**
 * Pure: recursively redact strings inside an arbitrary JSON-shaped
 * value. Object key names are preserved unchanged (they are part of
 * the schema, not data); only string VALUES and string ARRAY items
 * are scrubbed.
 *
 * Non-string scalars (number, boolean, null) pass through. Functions,
 * symbols, and other non-JSON values are returned as-is.
 */
export function redact(
  value: unknown,
  mode: RedactionMode,
  homeDir: string = os.homedir(),
): unknown {
  if (mode === "off") return value;
  if (value == null) return value;
  if (typeof value === "string") return redactString(value, mode, homeDir);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, mode, homeDir));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redact(v, mode, homeDir);
    }
    return out;
  }
  return value;
}

/**
 * Side-effecting: log the active redaction mode once per server
 * startup so an operator running with `off` knows the responses
 * are unfiltered.
 */
let advisoryLogged = false;
export function maybeLogRedactionModeOnce(
  mode: RedactionMode,
  writer: (line: string) => void = (line) => process.stderr.write(line),
): void {
  if (advisoryLogged) return;
  writer(
    `[memorydetective] redaction mode: ${mode}. ` +
      `Set MEMORYDETECTIVE_REDACTION to balanced (default), strict, or off.\n`,
  );
  advisoryLogged = true;
}

/** Test-only: reset the once-per-instance log flag. */
export function resetRedactionAdvisoryFlagForTests(): void {
  advisoryLogged = false;
}
