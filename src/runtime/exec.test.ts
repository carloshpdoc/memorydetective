import { describe, it, expect } from "vitest";
import { runCommand } from "./exec.js";

describe("runCommand", () => {
  it("resolves with captured stdout and exit code on success", async () => {
    const result = await runCommand("/bin/echo", ["hello"], {
      timeoutMs: 5000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.timedOut).toBeUndefined();
  });

  it("does NOT throw on non-zero exit (callers decide what is acceptable)", async () => {
    const result = await runCommand("/bin/sh", ["-c", "exit 2"], {
      timeoutMs: 5000,
    });
    expect(result.code).toBe(2);
  });

  it("rejects on timeout when gracefulKillAfterMs is not set (legacy behavior)", async () => {
    // Default SIGTERM kill + reject path. Preserved for backwards compat.
    await expect(
      runCommand("/bin/sleep", ["10"], { timeoutMs: 200 }),
    ).rejects.toThrow(/timed out after 200ms/);
  });

  it("resolves with timedOut=true when gracefulKillAfterMs is set", async () => {
    // New path: graceful escalation. Used by recordTimeProfile so xctrace
    // gets SIGINT (flushes the trace) before SIGKILL (escalation).
    const result = await runCommand("/bin/sleep", ["10"], {
      timeoutMs: 200,
      timeoutSignal: "SIGINT",
      gracefulKillAfterMs: 2000,
    });
    expect(result.timedOut).toBe(true);
    // sleep responds to SIGINT (and SIGTERM) by exiting with a non-zero code.
    expect(result.code).not.toBe(0);
  });

  it("respects custom timeoutSignal (SIGINT vs default SIGTERM)", async () => {
    // sleep exits on either signal. The point of this test is that the helper
    // does not throw or hang when the caller picks a non-default signal.
    const result = await runCommand("/bin/sleep", ["10"], {
      timeoutMs: 200,
      timeoutSignal: "SIGINT",
      gracefulKillAfterMs: 2000,
    });
    expect(result.timedOut).toBe(true);
  });

  it("merges env on top of process.env when env option is provided", async () => {
    const result = await runCommand(
      "/bin/sh",
      ["-c", "echo $MEMORYDETECTIVE_TEST_VAR"],
      { timeoutMs: 5000, env: { MEMORYDETECTIVE_TEST_VAR: "set-by-test" } },
    );
    expect(result.stdout.trim()).toBe("set-by-test");
  });
});
