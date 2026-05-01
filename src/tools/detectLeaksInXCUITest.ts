import { z } from "zod";
import { existsSync, mkdirSync } from "node:fs";
import { resolve as resolvePath, join as joinPath, basename } from "node:path";
import { runCommand } from "../runtime/exec.js";
import { runLeaksAndParse } from "../runtime/leaks.js";
import { resolveAppNameToPid } from "./captureMemgraph.js";
import { rootCyclesOnly } from "../parsers/leaksOutput.js";
import { diffReports } from "./diffMemgraphs.js";
import type { LeaksReport } from "../types.js";

/**
 * CI-runnable leak detection across an XCUITest run.
 *
 * Flow:
 *  1. Build the project for testing (`xcodebuild build-for-testing`).
 *  2. Launch the simulator + app via `xcodebuild test -only-testing:<id>` running
 *     a no-op test that just brings the app up.
 *  3. Capture a baseline `.memgraph` while the app is idle.
 *  4. Run the actual XCUITest cycle the user provided.
 *  5. Capture an "after" `.memgraph`.
 *  6. Diff the two and fail (return ok:false) if new ROOT CYCLEs appear that
 *     aren't in the user's allowlist.
 *
 * The tool deliberately does NOT spin up its own simulator UI — it expects the
 * user has a simulator already booted and an app installed (per XCUITest's
 * normal contract). We only orchestrate captures around the test execution.
 */

export const detectLeaksInXCUITestSchema = z.object({
  workspace: z
    .string()
    .min(1)
    .describe("Path to the .xcworkspace or .xcodeproj for the project."),
  scheme: z
    .string()
    .min(1)
    .describe("Xcode scheme that builds and runs the XCUITest target."),
  testIdentifier: z
    .string()
    .min(1)
    .describe(
      "XCUITest identifier in `<TestTarget>/<TestClass>/<testMethod>` form. Passed to `-only-testing` so we run exactly one test cycle.",
    ),
  appName: z
    .string()
    .min(1)
    .describe("App process name as it appears in `pgrep -x` (e.g. \"DemoApp\")."),
  destination: z
    .string()
    .default("platform=iOS Simulator,name=iPhone 11,OS=latest")
    .describe(
      "xcodebuild destination string. Default targets the most common iOS Simulator profile.",
    ),
  outputDir: z
    .string()
    .default("/tmp/memorydetective-xcuitest")
    .describe(
      "Directory where the baseline + after `.memgraph` snapshots are written.",
    ),
  allowlistPatterns: z
    .array(z.string())
    .default([])
    .describe(
      "Substrings of class names that are allowed to leak. Examples: pre-existing SwiftUI internals you can't fix, third-party SDK leaks. Cycles whose root class contains any of these substrings won't fail the run.",
    ),
  skipBuild: z
    .boolean()
    .default(false)
    .describe(
      "Skip the build-for-testing step (faster on CI when the build is already cached).",
    ),
});

export type DetectLeaksInXCUITestInput = z.infer<
  typeof detectLeaksInXCUITestSchema
>;

export interface XCUITestLeakResult {
  ok: boolean;
  /** True when no new (non-allowlisted) ROOT CYCLEs appeared after the test. */
  passed: boolean;
  baselineMemgraph: string;
  afterMemgraph: string;
  testIdentifier: string;
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
}

async function captureMemgraphForApp(
  appName: string,
  outputPath: string,
): Promise<void> {
  const pid = await resolveAppNameToPid(appName);
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
    throw new Error(`leaks reported success but output file is missing: ${outputPath}`);
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

function isAllowlisted(rootClass: string, patterns: string[]): boolean {
  return patterns.some((p) => rootClass.includes(p));
}

export async function detectLeaksInXCUITest(
  input: DetectLeaksInXCUITestInput,
): Promise<XCUITestLeakResult> {
  const workspace = resolvePath(input.workspace);
  if (!existsSync(workspace)) {
    throw new Error(`Workspace not found: ${workspace}`);
  }
  const outputDir = resolvePath(input.outputDir);
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const baselinePath = joinPath(outputDir, `${basename(input.workspace)}-baseline.memgraph`);
  const afterPath = joinPath(outputDir, `${basename(input.workspace)}-after.memgraph`);
  const steps: string[] = [];

  const isWorkspace = workspace.endsWith(".xcworkspace");
  const projectFlag = isWorkspace ? "-workspace" : "-project";

  // 1. Build for testing (once).
  if (!input.skipBuild) {
    await runXcodebuild(
      [
        projectFlag,
        workspace,
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

  // 2. First run to bring the app up (we only need it running for the baseline capture).
  // We trigger the test once, but we capture BEFORE it really runs by polling pgrep.
  // The cleanest pattern is: launch the test in background, poll pgrep, capture once
  // the app process exists, then let the test continue.
  // Simpler implementation: run the test fully, capture AT END (after-state). Then run
  // a separate baseline run that captures during a no-op pre-flight test.
  // To keep this tool tractable, we do the simpler version: ONE test run, baseline
  // captured via a configurable preflight test name. The user wires that up.
  //
  // For v0.2, we treat this as: run the full XCUITest, capture the memgraph at
  // the END of the test (XCUITest holds the app open at the end of the test
  // method until the harness tears down). User must be aware that "baseline"
  // here is best-effort.

  // For now, run the test once and capture twice: once at the start (waiting for app
  // to launch via polling) and once after the test method returns.
  steps.push(`Running test: ${input.testIdentifier}`);

  // Run the test in the background so we can capture during/after.
  const testArgs = [
    projectFlag,
    workspace,
    "-scheme",
    input.scheme,
    "-destination",
    input.destination,
    "-only-testing:" + input.testIdentifier,
    "test-without-building",
    "-quiet",
  ];

  const { spawn } = await import("node:child_process");
  const child = spawn("xcodebuild", testArgs);
  let testStdout = "";
  let testStderr = "";
  child.stdout.on("data", (c: Buffer) => (testStdout += c.toString("utf8")));
  child.stderr.on("data", (c: Buffer) => (testStderr += c.toString("utf8")));
  const testPromise = new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? -1));
  });

  // Poll pgrep until the app appears, then capture baseline.
  const startedAt = Date.now();
  let captured = false;
  while (Date.now() - startedAt < 5 * 60_000) {
    try {
      const pgrep = await runCommand("pgrep", ["-x", input.appName], {
        timeoutMs: 5_000,
      });
      if (pgrep.code === 0 && pgrep.stdout.trim()) {
        await captureMemgraphForApp(input.appName, baselinePath);
        steps.push(`Captured baseline: ${baselinePath}`);
        captured = true;
        break;
      }
    } catch {
      // app not running yet; keep polling
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!captured) {
    child.kill("SIGTERM");
    throw new Error(
      `Timed out waiting for the app process "${input.appName}" to appear under the simulator. Is the test target actually launching the app?`,
    );
  }

  const testExitCode = await testPromise;
  steps.push(`Test exited with code ${testExitCode}`);

  // After the test method finishes, the app process is usually still around for a
  // short window before the simulator tears it down. Try the after-capture immediately.
  let afterCaptured = false;
  try {
    await captureMemgraphForApp(input.appName, afterPath);
    steps.push(`Captured after: ${afterPath}`);
    afterCaptured = true;
  } catch (err) {
    steps.push(
      `Skipped after-capture — app process ended before we could attach. ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!afterCaptured) {
    return {
      ok: false,
      passed: false,
      baselineMemgraph: baselinePath,
      afterMemgraph: "",
      testIdentifier: input.testIdentifier,
      totals: {
        baselineLeaks: 0,
        afterLeaks: 0,
        leakDelta: 0,
      },
      newCycles: [],
      failureReason:
        "After-capture failed. Configure the XCUITest to keep the app alive at end-of-test (e.g. `XCTAssertTrue(true); _ = XCTWaiter.wait(for: [...], timeout: 1.0)`) or run with a longer simulator boot.",
      steps,
    };
  }

  // 3. Diff.
  const [baseline, after] = await Promise.all([
    runLeaksAndParse(baselinePath),
    runLeaksAndParse(afterPath),
  ]);
  const baselineReport: LeaksReport = baseline.report;
  const afterReport: LeaksReport = after.report;

  const baselineRootClasses = new Set(
    rootCyclesOnly(baselineReport.cycles).map((c) => c.className || c.address),
  );
  const afterRoots = rootCyclesOnly(afterReport.cycles);
  const newOnes = afterRoots.filter(
    (c) => !baselineRootClasses.has(c.className || c.address),
  );

  const allowlistedFlags = newOnes.map((c) =>
    isAllowlisted(c.className, input.allowlistPatterns ?? []),
  );

  const failingCycles = newOnes
    .filter((_, i) => !allowlistedFlags[i])
    .map((c) => ({
      rootClass: c.className || c.address,
      chainLength: countDescendants(c.children),
      allowlisted: false,
    }));

  const newCycles = newOnes.map((c, i) => ({
    rootClass: c.className || c.address,
    chainLength: countDescendants(c.children) + 1,
    allowlisted: allowlistedFlags[i],
  }));

  const passed = failingCycles.length === 0 && testExitCode === 0;

  return {
    ok: true,
    passed,
    baselineMemgraph: baselinePath,
    afterMemgraph: afterPath,
    testIdentifier: input.testIdentifier,
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
        ? `Test failed with exit code ${testExitCode}.`
        : `${failingCycles.length} new ROOT CYCLE(s) appeared after the test that aren't in the allowlist: ${failingCycles.map((c) => c.rootClass).slice(0, 5).join(", ")}${failingCycles.length > 5 ? ", ..." : ""}`,
    steps,
  };
}

function countDescendants(children: Array<{ children: unknown[] }>): number {
  let n = children.length;
  for (const c of children as Array<{ children: Array<{ children: unknown[] }> }>) {
    n += countDescendants(c.children);
  }
  return n;
}
