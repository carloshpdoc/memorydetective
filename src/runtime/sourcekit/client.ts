/**
 * Persistent `sourcekit-lsp` subprocess client.
 *
 * One client per project root. Talks LSP over JSON-RPC stdio using
 * `vscode-jsonrpc` for framing. Lifecycle:
 *
 *   spawn -> initialize -> initialized -> [lots of requests] -> shutdown -> exit
 *
 * Used by the Swift source-bridging tools (`getSymbolDefinition`,
 * `findSymbolReferences`, etc.). The pool (`./pool.ts`) keeps one client
 * alive per project root and shuts it down after an idle window so we
 * don't hold onto resources or stall builds.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";

export interface SourceKitClientOptions {
  projectRoot: string;
  /** Override the binary path. Defaults to `xcrun sourcekit-lsp`. */
  command?: string;
  args?: string[];
  /** Initialization timeout, ms. Default 30s. */
  initTimeoutMs?: number;
}

export interface InitializedClient {
  projectRoot: string;
  /** Send an arbitrary LSP request by method name. */
  sendRequest<R = unknown>(method: string, params?: unknown): Promise<R>;
  /** Send a notification (no response). */
  sendNotification(method: string, params?: unknown): void;
  /** Track a document as open with the server. Idempotent per uri. */
  didOpen(filePath: string, languageId?: string): void;
  /** Stop the server gracefully. Once called, the client cannot be reused. */
  dispose(): Promise<void>;
}

const DEFAULT_INIT_TIMEOUT = 30_000;

interface OpenDocs {
  set: Set<string>; // uris
}

/**
 * Spawn `sourcekit-lsp`, drive the LSP handshake, and return a client
 * that exposes typed request/notification helpers.
 */
export async function createSourceKitClient(
  opts: SourceKitClientOptions,
): Promise<InitializedClient> {
  const command = opts.command ?? "xcrun";
  const args = opts.args ?? ["sourcekit-lsp"];
  const projectRoot = resolvePath(opts.projectRoot);

  const child: ChildProcessWithoutNullStreams = spawn(command, args, {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const connection: MessageConnection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );

  // Forward stderr to our stderr so SourceKit warnings/errors are visible.
  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(`[sourcekit-lsp] ${chunk.toString("utf8")}`);
  });

  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  connection.listen();

  const projectUri = pathToFileURL(projectRoot).href;

  const initTimeoutMs = opts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT;
  await withTimeout(
    connection.sendRequest("initialize", {
      processId: process.pid,
      rootUri: projectUri,
      workspaceFolders: [{ uri: projectUri, name: projectRoot }],
      capabilities: {
        textDocument: {
          definition: { linkSupport: true },
          references: {},
          hover: { contentFormat: ["plaintext", "markdown"] },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        },
        workspace: { workspaceFolders: true },
      },
      initializationOptions: {
        // sourcekit-lsp picks up .build/index/store automatically when present.
      },
    }),
    initTimeoutMs,
    "sourcekit-lsp initialize",
  );

  connection.sendNotification("initialized", {});

  const openDocs: OpenDocs = { set: new Set() };

  const client: InitializedClient = {
    projectRoot,
    async sendRequest<R = unknown>(method: string, params?: unknown): Promise<R> {
      if (exited) throw new Error("sourcekit-lsp client has exited");
      return await connection.sendRequest<R>(method, params);
    },
    sendNotification(method: string, params?: unknown): void {
      if (exited) throw new Error("sourcekit-lsp client has exited");
      connection.sendNotification(method, params);
    },
    didOpen(filePath: string, languageId = "swift"): void {
      const uri = pathToFileURL(resolvePath(filePath)).href;
      if (openDocs.set.has(uri)) return;
      openDocs.set.add(uri);
      // We don't ship the file's text here — sourcekit-lsp reads from disk
      // when version === 1. This works for read-only operations
      // (definition, references, hover, documentSymbol).
      connection.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId,
          version: 1,
          text: "",
        },
      });
    },
    async dispose(): Promise<void> {
      if (exited) return;
      try {
        await withTimeout(
          connection.sendRequest("shutdown"),
          5_000,
          "sourcekit-lsp shutdown",
        );
        connection.sendNotification("exit");
      } catch {
        // best effort — kill the process if shutdown didn't complete
      }
      try {
        connection.dispose();
      } catch {}
      if (!exited) {
        child.kill("SIGTERM");
        // Give it a moment to die gracefully, then SIGKILL.
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {}
            resolve();
          }, 2_000);
          child.once("exit", () => {
            clearTimeout(t);
            resolve();
          });
        });
      }
    },
  };

  return client;
}

async function withTimeout<T>(
  p: Promise<T> | Thenable<T>,
  ms: number,
  label: string,
): Promise<T> {
  return await Promise.race([
    Promise.resolve(p as Promise<T>),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}
