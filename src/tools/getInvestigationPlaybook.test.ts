import { describe, it, expect } from "vitest";
import {
  getInvestigationPlaybook,
  PLAYBOOK_KINDS,
} from "./getInvestigationPlaybook.js";

describe("getInvestigationPlaybook", () => {
  it("returns a playbook for each declared kind", async () => {
    for (const kind of PLAYBOOK_KINDS) {
      const result = await getInvestigationPlaybook({ kind });
      expect(result.ok).toBe(true);
      expect(result.playbook.kind).toBe(kind);
      expect(result.playbook.steps.length).toBeGreaterThan(0);
    }
  });

  it("memgraph-leak playbook chains the right tools in order", async () => {
    const { playbook } = await getInvestigationPlaybook({ kind: "memgraph-leak" });
    const tools = playbook.steps.map((s) => s.tool);
    expect(tools[0]).toBe("analyzeMemgraph");
    expect(tools).toContain("classifyCycle");
    expect(tools).toContain("reachableFromCycle");
    expect(tools).toContain("swiftSearchPattern");
    expect(tools).toContain("swiftGetSymbolDefinition");
    expect(tools).toContain("swiftFindSymbolReferences");
  });

  it("each step has a numbered position, tool, purpose, and argsTemplate", async () => {
    const { playbook } = await getInvestigationPlaybook({ kind: "memgraph-leak" });
    for (let i = 0; i < playbook.steps.length; i++) {
      const step = playbook.steps[i];
      expect(step.step).toBe(i + 1);
      expect(step.tool.length).toBeGreaterThan(0);
      expect(step.purpose.length).toBeGreaterThan(0);
      expect(typeof step.argsTemplate).toBe("object");
    }
  });

  it("playbook summary is human-readable and non-empty", async () => {
    for (const kind of PLAYBOOK_KINDS) {
      const { playbook } = await getInvestigationPlaybook({ kind });
      expect(playbook.summary.length).toBeGreaterThan(20);
    }
  });

  it("verify-fix flow opens with a diff and ends with classifyCycle", async () => {
    const { playbook } = await getInvestigationPlaybook({ kind: "verify-fix" });
    expect(playbook.steps[0].tool).toBe("diffMemgraphs");
    expect(playbook.steps.at(-1)?.tool).toBe("classifyCycle");
  });
});
