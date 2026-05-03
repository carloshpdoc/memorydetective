import { describe, it, expect } from "vitest";
import { PROMPTS, findPrompt } from "./prompts.js";
import { PLAYBOOK_KINDS } from "../tools/getInvestigationPlaybook.js";

describe("MCP Prompts — investigation playbooks as slash commands", () => {
  it("ships exactly 5 prompts, one per playbook kind", () => {
    expect(PROMPTS.length).toBe(5);
    expect(PROMPTS.length).toBe(PLAYBOOK_KINDS.length);
  });

  it("prompt names follow the investigate-* / verify-* convention", () => {
    const names = PROMPTS.map((p) => p.name);
    expect(names).toContain("investigate-leak");
    expect(names).toContain("investigate-hangs");
    expect(names).toContain("investigate-jank");
    expect(names).toContain("investigate-launch");
    expect(names).toContain("verify-cycle-fix");
  });

  it("each prompt declares title, description, and at least one argument", () => {
    for (const p of PROMPTS) {
      expect(p.title).toBeTruthy();
      expect(p.description.length).toBeGreaterThan(20);
      expect(p.arguments.length).toBeGreaterThan(0);
      for (const arg of p.arguments) {
        expect(arg.name).toBeTruthy();
        expect(arg.description).toBeTruthy();
      }
    }
  });

  it("findPrompt resolves by name", () => {
    expect(findPrompt("investigate-leak")?.title).toBe(
      "Investigate a memgraph leak",
    );
    expect(findPrompt("verify-cycle-fix")?.arguments).toHaveLength(2);
    expect(findPrompt("does-not-exist")).toBeUndefined();
  });

  it("investigate-leak render substitutes the memgraph path into the brief", () => {
    const prompt = findPrompt("investigate-leak")!;
    const text = prompt.render({ memgraphPath: "/Users/me/Desktop/x.memgraph" });
    expect(text).toContain("/Users/me/Desktop/x.memgraph");
    expect(text).toContain("memgraph-leak");
    expect(text).toContain("analyzeMemgraph");
    expect(text).toContain("classifyCycle");
    // Discipline directive should be present.
    expect(text).toContain("Do not propose architectural changes before evidence");
  });

  it("verify-cycle-fix render substitutes both before and after paths", () => {
    const prompt = findPrompt("verify-cycle-fix")!;
    const text = prompt.render({
      before: "/tmp/before.memgraph",
      after: "/tmp/after.memgraph",
    });
    expect(text).toContain("/tmp/before.memgraph");
    expect(text).toContain("/tmp/after.memgraph");
    expect(text).toContain("diffMemgraphs");
  });

  it("investigate-hangs / -jank / -launch take a tracePath and embed it", () => {
    for (const name of ["investigate-hangs", "investigate-jank", "investigate-launch"] as const) {
      const prompt = findPrompt(name)!;
      const text = prompt.render({ tracePath: "/tmp/run.trace" });
      expect(text).toContain("/tmp/run.trace");
    }
  });
});
