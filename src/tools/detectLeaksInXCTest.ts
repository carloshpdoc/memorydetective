import { z } from "zod";
import { existsSync, mkdirSync } from "node:fs";
import { resolve as resolvePath, join as joinPath, basename } from "node:path";
import { runCommand } from "../runtime/exec.js";
import { runLeaksAndParse } from "../runtime/leaks.js";
import { resolveAppNameToPid } from "./captureMemgraph.js";
import { rootCyclesOnly } from "../parsers/leaksOutput.js";
import { writeLeakReportHtml } from "../runtime/leakReport.js";
import type { LeaksReport } from "../types.js";

/**
 * CI-runnable leak detection for XCTest unit-test bundles.
 *
 * Sibling to `detectLeaksInXCUITest`. The orchestration model is the same:
 * build-for-testing -> launch test bundle -> poll for the runner process ->
 * capture baseline memgraph -> wait for test to finish -> capture after
 * memgraph -> diff. The difference is the target process: unit tests run
 * inside an `xctest` runner (or the app process if a host app is configured),
 * not the XCUITest host app. Default `processName` reflects that.
 *
 * Per-test granularity is achieved by the CALLER invoking the tool once per
 * test method (passing a different `testCaseFilter` each time). The tool
 * itself runs ONE `xcodebuild test` invocation per call so the result is
 * always tied to a single, well-defined before/after pair.
 */

export const detectLeaksInXCTestSchema = z
  .object({
    workspace: z
      .string()
      .min(1)
      .optional()
      .describe("Path to the `.xcworkspace`. Mutually exclusive with `project`."),
    project: z
      .string()
      .min(1)
      .optional()
      .describe("Path to the `.xcodeproj`. Mutually exclusive with `workspace`."),
    scheme: z
      .string()
      .min(1)
      .describe("Xcode scheme that builds and runs the XCTest unit-test target."),
    destination: z
      .string()
      .default("platform=iOS Simulator,name=iPhone 11,OS=latest")
      .describe(
        "xcodebuild destination string. Default targets the most common iOS Simulator profile.",
      ),
    testCaseFilter: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional `-only-testing` filter in `<TestTarget>/<TestClass>` or `<TestTarget>/<TestClass>/<testMethod>` form. Omit to run every test in the scheme (slower; produces one before/after pair for the entire run).",
      ),
    processName: z
      .string()
      .default("xctest")
      .describe(
        "Process name to attach `leaks` against. `xctest` is the default unit-test runner on the simulator. If your tests are hosted in an app, pass the host app's process name instead (the same value `pgrep -x` would match).",
      ),
    outputDir: z
      .string()
      .default("/tmp/memorydetective-xctest")
      .describe(
        "Directory where the baseline + after `.memgraph` snapshots are written.",
      ),
    allowlistPatterns: z
      .array(z.string())
      .default([])
      .describe(
        "Substrings of class names that are allowed to leak. Cycles whose root class contains any of these substrings will not fail the run.",
      ),
    skipBuild: z
      .boolean()
      .default(false)
      .describe(
        "Skip the `build-for-testing` step (faster on CI when the build is cached).",
      ),
    runnerStartTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(5 * 60_000)
      .describe(
        "How long to wait for the test runner process to appear under `pgrep -x <processName>` before giving up. Default 5 minutes.",
      ),
    outputHtmlPath: z
      .string()
      .optional()
      .describe(
        "Absolute path to write a self-contained HTML report (inline CSS, no external assets). When set, the response also gains an `htmlReportPath` field pointing at the same file. Designed for CI artifact upload + PR-comment attachment.",
      ),
  })
  .superRefine((val, ctx) => {
    const targets = [val.workspace, val.project].filter(Boolean).length;
    if (targets !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of `workspace` or `project`.",
      });
    }
  });

export type DetectLeaksInXCTestInput = z.infer<typeof detectLeaksInXCTestSchema>;

export interface XCTestLeakResult {
  ok: boolean;
  /** True when no new (non-allowlisted) ROOT CYCLEs appeared after the test. */
  passed: boolean;
  baselineMemgraph: string;
  afterMemgraph: string;
  testCaseFilter?: string;
  totals: {
    baselineLeaks: number;
    afterLeaks: number;
    leakDelta: number;
  };
  newCycles: Array<{
    rootClass: string;
    chainLength: number;
    /** True when this cycle matches an allowlist pattern. */
    allowlisted: boolean;
  }>;
  failureReason?: string;
  steps: string[];
  /** Absolute path to the rendered HTML report when `outputHtmlPath` was set. */
  htmlReportPath?: string;
}

async function captureMemgraphForProcess(
  processName: string,
  outputPath: string,
): Promise<void> {
  const pid = await resolveAppNameToPid(processName);
  const result = await runCommand(
    "leaks",
    ["--outputGraph", outputPath, String(pid)],
    { timeoutMs: 120_000 },
  );
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(
      `leaks --outputGraph failed (code ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  if (!existsSync(outputPath)) {
    throw new Error(
      `leaks reported success but output file is missing: ${outputPath}`,
    );
  }
}

async function runXcodebuild(
  args: string[],
  step: string,
  steps: string[],
): Promise<void> {
  steps.push(`$ xcodebuild ${args.join(" ")}`);
  const result = await runCommand("xcodebuild", args, { timeoutMs: 30 * 60_000 });
  if (result.code !== 0) {
    throw new Error(
      `${step} failed (code ${result.code}): ${result.stderr || result.stdout || "<no output>"}`,
    );
  }
}

export function isAllowlisted(rootClass: string, patterns: string[]): boolean {
  return patterns.some((p) => rootClass.includes(p));
}

export function countDescendants(
  children: Array<{ children: unknown[] }>,
): number {
  let n = children.length;
  for (const c of children as Array<{ children: Array<{ children: unknown[] }> }>) {
    n += countDescendants(c.children);
  }
  return n;
}

/**
 * Build the new-cycles summary by diffing baseline + after reports against the
 * allowlist. Exposed for testing so the diff logic can be exercised without
 * spinning up xcodebuild.
 */
export function summarizeNewCycles(
  baseline: LeaksReport,
  after: LeaksReport,
  allowlistPatterns: string[],
): { newCycles: XCTestLeakResult["newCycles"]; failingCount: number } {
  const baselineRootClasses = new Set(
    rootCyclesOnly(baseline.cycles).map((c) => c.className || c.address),
  );
  const afterRoots = rootCyclesOnly(after.cycles);
  const newOnes = afterRoots.filter(
    (c) => !baselineRootClasses.has(c.className || c.address),
  );
  const allowlistedFlags = newOnes.map((c) =>
    isAllowlisted(c.className, allowlistPatterns),
  );
  const newCycles = newOnes.map((c, i) => ({
    rootClass: c.className || c.address,
    chainLength: countDescendants(c.children) + 1,
    allowlisted: allowlistedFlags[i],
  }));
  const failingCount = newCycles.filter((c) => !c.allowlisted).length;
  return { newCycles, failingCount };
}

function attachHtmlReportIfRequested(
  result: XCTestLeakResult,
  outputHtmlPath: string | undefined,
  schemeLabel: string,
): XCTestLeakResult {
  if (!outputHtmlPath) return result;
  const path = writeLeakReportHtml(outputHtmlPath, {
    title: `Leak report: ${schemeLabel}`,
    subtitle: result.testCaseFilter
      ? `Filter: ${result.testCaseFilter}`
      : "No -only-testing filter (entire scheme).",
    sections: [
      {
        title: result.testCaseFilter ?? schemeLabel,
        passed: result.passed,
        failureReason: result.failureReason,
        baselineMemgraph: result.baselineMemgraph || undefined,
        afterMemgraph: result.afterMemgraph || undefined,
        totals: result.totals,
        newCycles: result.newCycles,
        steps: result.steps,
      },
    ],
  });
  return { ...result, htmlReportPath: path };
}

export async function detectLeaksInXCTest(
  input: DetectLeaksInXCTestInput,
): Promise<XCTestLeakResult> {
  const projectPath = resolvePath((input.workspace ?? input.project)!);
  if (!existsSync(projectPath)) {
    throw new Error(`Workspace/project not found: ${projectPath}`);
  }
  const outputDir = resolvePath(input.outputDir);
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const filterTag = input.testCaseFilter
    ? input.testCaseFilter.replace(/[^A-Za-z0-9._-]/g, "_")
    : "all";
  const baselinePath = joinPath(
    outputDir,
    `${basename(projectPath)}-${filterTag}-baseline.memgraph`,
  );
  const afterPath = joinPath(
    outputDir,
    `${basename(projectPath)}-${filterTag}-after.memgraph`,
  );
  const steps: string[] = [];

  const projectFlag = input.workspace ? "-workspace" : "-project";

  // 1. Build for testing (once).
  if (!input.skipBuild) {
    await runXcodebuild(
      [
        projectFlag,
        projectPath,
        "-scheme",
        input.scheme,
        "-destination",
        input.destination,
        "build-for-testing",
        "-quiet",
      ],
      "build-for-testing",
      steps,
    );
  } else {
    steps.push("(skipped build-for-testing)");
  }

  // 2. Run the test bundle in the background so we can attach `leaks` to the
  // runner process while it is alive. Captures baseline once the runner shows
  // up under pgrep, then after the test finishes (best-effort: the xctest
  // runner exits quickly at end-of-bundle).
  const testArgs: string[] = [
    projectFlag,
    projectPath,
    "-scheme",
    input.scheme,
    "-destination",
    input.destination,
    "test-without-building",
    "-quiet",
  ];
  if (input.testCaseFilter) {
    testArgs.splice(testArgs.length - 2, 0, "-only-testing:" + input.testCaseFilter);
    steps.push(`Filter: -only-testing:${input.testCaseFilter}`);
  } else {
    steps.push("No filter — running the entire test scheme.");
  }

  const { spawn } = await import("node:child_process");
  const child = spawn("xcodebuild", testArgs);
  let testStdout = "";
  let testStderr = "";
  child.stdout.on("data", (c: Buffer) => (testStdout += c.toString("utf8")));
  child.stderr.on("data", (c: Buffer) => (testStderr += c.toString("utf8")));
  const testPromise = new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? -1));
  });

  // Poll pgrep for the runner process. xctest typically appears within
  // a few seconds of `xcodebuild test` starting.
  const startedAt = Date.now();
  let captured = false;
  while (Date.now() - startedAt < input.runnerStartTimeoutMs) {
    try {
      const pgrep = await runCommand("pgrep", ["-x", input.processName], {
        timeoutMs: 5_000,
      });
      if (pgrep.code === 0 && pgrep.stdout.trim()) {
        await captureMemgraphForProcess(input.processName, baselinePath);
        steps.push(`Captured baseline: ${baselinePath}`);
        captured = true;
        break;
      }
    } catch {
      // Runner not up yet; keep polling.
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!captured) {
    child.kill("SIGTERM");
    return attachHtmlReportIfRequested(
      {
        ok: false,
        passed: false,
        baselineMemgraph: "",
        afterMemgraph: "",
        testCaseFilter: input.testCaseFilter,
        totals: { baselineLeaks: 0, afterLeaks: 0, leakDelta: 0 },
        newCycles: [],
        failureReason: `Timed out (${input.runnerStartTimeoutMs}ms) waiting for the test runner process "${input.processName}" to appear under pgrep. Check that the scheme actually builds a runnable test bundle, and that \`processName\` matches the runner's process name on this simulator runtime.`,
        steps,
      },
      input.outputHtmlPath,
      input.scheme,
    );
  }

  const testExitCode = await testPromise;
  steps.push(`Test exited with code ${testExitCode}`);

  // After-capture is best-effort. The xctest runner exits quickly at end of
  // the test bundle; if we miss the window the user can either configure a
  // post-test sleep in their test setup, or use a host app whose lifetime
  // outlives the test bundle.
  let afterCaptured = false;
  let afterCaptureError: string | undefined;
  try {
    await captureMemgraphForProcess(input.processName, afterPath);
    steps.push(`Captured after: ${afterPath}`);
    afterCaptured = true;
  } catch (err) {
    afterCaptureError = err instanceof Error ? err.message : String(err);
    steps.push(
      `Skipped after-capture — runner process ended before we could attach. ${afterCaptureError}`,
    );
  }

  if (!afterCaptured) {
    return attachHtmlReportIfRequested(
      {
        ok: false,
        passed: false,
        baselineMemgraph: baselinePath,
        afterMemgraph: "",
        testCaseFilter: input.testCaseFilter,
        totals: { baselineLeaks: 0, afterLeaks: 0, leakDelta: 0 },
        newCycles: [],
        failureReason:
          "After-capture failed because the test runner exited before `leaks` could attach. Configure the test to keep the process alive briefly at end-of-run (e.g. `_ = XCTWaiter.wait(for: [.init()], timeout: 0.5)` in `tearDown`) or run with a host app whose lifetime outlives the test bundle.",
        steps,
      },
      input.outputHtmlPath,
      input.scheme,
    );
  }

  const [baseline, after] = await Promise.all([
    runLeaksAndParse(baselinePath),
    runLeaksAndParse(afterPath),
  ]);
  const baselineReport: LeaksReport = baseline.report;
  const afterReport: LeaksReport = after.report;

  const { newCycles, failingCount } = summarizeNewCycles(
    baselineReport,
    afterReport,
    input.allowlistPatterns ?? [],
  );

  const passed = failingCount === 0 && testExitCode === 0;

  return attachHtmlReportIfRequested(
    {
      ok: true,
      passed,
      baselineMemgraph: baselinePath,
      afterMemgraph: afterPath,
      testCaseFilter: input.testCaseFilter,
      totals: {
        baselineLeaks: baselineReport.totals.leakCount,
        afterLeaks: afterReport.totals.leakCount,
        leakDelta:
          afterReport.totals.leakCount - baselineReport.totals.leakCount,
      },
      newCycles,
      failureReason: passed
        ? undefined
        : testExitCode !== 0
          ? `Test run failed with exit code ${testExitCode}. stderr: ${testStderr.slice(0, 500)}`
          : `${failingCount} new ROOT CYCLE(s) appeared after the test that are not in the allowlist: ${newCycles
              .filter((c) => !c.allowlisted)
              .map((c) => c.rootClass)
              .slice(0, 5)
              .join(", ")}${failingCount > 5 ? ", ..." : ""}`,
      steps,
    },
    input.outputHtmlPath,
    input.scheme,
  );
}
