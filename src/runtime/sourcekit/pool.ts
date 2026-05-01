/**
 * Pool of `sourcekit-lsp` clients, keyed by project root.
 *
 * Why a pool: starting `sourcekit-lsp` and waiting for it to be ready costs
 * ~2 seconds. Doing that on every tool call would kill the agent loop.
 * Instead we keep one client alive per project root and reuse it across
 * tool invocations. After an idle window we shut it down so we're not
 * blocking the user's build/test pipeline.
 */

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  createSourceKitClient,
  type InitializedClient,
} from "./client.js";

interface PoolEntry {
  client: InitializedClient;
  /** Last time this entry served a request, ms since epoch. */
  lastUsed: number;
  /** Idle shutdown timer. Reset on every use. */
  idleTimer?: NodeJS.Timeout;
}

const DEFAULT_IDLE_MS = 5 * 60_000; // 5 minutes
const pool = new Map<string, PoolEntry>();

/** Resolve a file path to its enclosing project root by walking up to the
 *  nearest `Package.swift`, `*.xcodeproj`, or `*.xcworkspace`. Falls back
 *  to the file's directory if nothing is found. */
export function projectRootFor(filePath: string): string {
  let dir = resolvePath(filePath);
  try {
    dir = realpathSync(dir);
  } catch {}
  let prev = "";
  while (dir !== prev) {
    if (
      dirHas(dir, "Package.swift") ||
      dirHasGlob(dir, ".xcodeproj") ||
      dirHasGlob(dir, ".xcworkspace")
    ) {
      return dir;
    }
    prev = dir;
    dir = resolvePath(dir, "..");
  }
  // No marker found — use the original directory.
  return resolvePath(filePath, "..");
}

function dirHas(dir: string, name: string): boolean {
  try {
    return existsSync(resolvePath(dir, name));
  } catch {
    return false;
  }
}

function dirHasGlob(dir: string, suffix: string): boolean {
  try {
    return readdirSync(dir).some((entry) => entry.endsWith(suffix));
  } catch {
    return false;
  }
}

export interface AcquireOptions {
  /** Override idle shutdown window, ms. Default 5min. */
  idleMs?: number;
}

/** Acquire an LSP client for a project root. Reuses an existing one if
 *  warm, spawns + initializes one otherwise. */
export async function acquireClient(
  projectRoot: string,
  opts: AcquireOptions = {},
): Promise<InitializedClient> {
  const key = resolvePath(projectRoot);
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;

  let entry = pool.get(key);
  if (!entry) {
    const client = await createSourceKitClient({ projectRoot: key });
    entry = { client, lastUsed: Date.now() };
    pool.set(key, entry);
  }

  entry.lastUsed = Date.now();
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    void shutdownClient(key);
  }, idleMs);
  return entry.client;
}

/** Manually shut down the client for a given project root. */
export async function shutdownClient(projectRoot: string): Promise<void> {
  const key = resolvePath(projectRoot);
  const entry = pool.get(key);
  if (!entry) return;
  pool.delete(key);
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  await entry.client.dispose();
}

/** Shut down all pooled clients. Useful in tests + on process exit. */
export async function shutdownAll(): Promise<void> {
  const keys = Array.from(pool.keys());
  for (const key of keys) {
    await shutdownClient(key);
  }
}

// Best-effort cleanup on process exit.
process.once("exit", () => {
  // Synchronous only — async cleanups won't run here, but the OS will
  // reap the subprocess.
});
process.once("SIGINT", () => {
  void shutdownAll().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdownAll().finally(() => process.exit(0));
});
