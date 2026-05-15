/**
 * MCP Prompts surface — exposes the canonical investigation playbooks as
 * named prompts (slash commands in clients that support them).
 *
 * Each prompt corresponds to a `Playbook` from `getInvestigationPlaybook`,
 * but takes user-provided args (e.g. memgraph path, before/after pair) and
 * fills the placeholders so the agent receives a ready-to-execute brief.
 *
 * Prompt names follow `investigate-*` / `verify-*` convention; surfaces in
 * Claude Code as `/investigate-leak`, `/investigate-hangs`, etc.
 */

import { PLAYBOOKS, type Playbook } from "../tools/getInvestigationPlaybook.js";

export interface PromptArg {
  name: string;
  description: string;
  required: boolean;
}

export interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  arguments: PromptArg[];
  /** Substitutes args into the playbook to produce the user message text. */
  render: (args: Record<string, string>) => string;
}

export const PROMPTS: PromptDefinition[] = [
  {
    name: "investigate-leak",
    title: "Investigate a memgraph leak",
    description:
      "Run the canonical 6-step memgraph-leak investigation: analyzeMemgraph → classifyCycle → reachableFromCycle → swiftSearchPattern → swiftGetSymbolDefinition → swiftFindSymbolReferences.",
    arguments: [
      {
        name: "memgraphPath",
        description: "Absolute path to the .memgraph file",
        required: true,
      },
    ],
    render: ({ memgraphPath }) =>
      renderPlaybookPrompt(PLAYBOOKS["memgraph-leak"], {
        path: memgraphPath,
      }),
  },
  {
    name: "investigate-hangs",
    title: "Investigate user-visible hangs",
    description:
      "Diagnose main-thread hangs from a `.trace` recorded with the Time Profiler or Hangs template.",
    arguments: [
      {
        name: "tracePath",
        description: "Absolute path to the .trace bundle",
        required: true,
      },
    ],
    render: ({ tracePath }) =>
      renderPlaybookPrompt(PLAYBOOKS["perf-hangs"], { tracePath }),
  },
  {
    name: "investigate-jank",
    title: "Investigate UI jank / animation hitches",
    description:
      "Diagnose dropped frames from a `.trace` recorded with the Animation Hitches template.",
    arguments: [
      {
        name: "tracePath",
        description: "Absolute path to the .trace bundle",
        required: true,
      },
    ],
    render: ({ tracePath }) =>
      renderPlaybookPrompt(PLAYBOOKS["ui-jank"], { tracePath }),
  },
  {
    name: "investigate-launch",
    title: "Investigate slow app launch",
    description:
      "Diagnose cold/warm launch slowness from a `.trace` recorded with the App Launch template.",
    arguments: [
      {
        name: "tracePath",
        description: "Absolute path to the .trace bundle",
        required: true,
      },
    ],
    render: ({ tracePath }) =>
      renderPlaybookPrompt(PLAYBOOKS["app-launch-slow"], { tracePath }),
  },
  {
    name: "summarize-trace",
    title: "Single-call cross-schema summary card for a .trace",
    description:
      "Call `summarizeTrace` on the user-supplied .trace and present the markdown card. Surfaces hangs, hitches, time-profile hotspots, allocations, app launch, and cross-correlations in one pass. Use this as the FIRST step on any new .trace.",
    arguments: [
      {
        name: "tracePath",
        description: "Absolute path to the .trace bundle",
        required: true,
      },
    ],
    render: ({ tracePath }) => renderSummarizeTracePrompt(tracePath),
  },
  {
    name: "verify-cycle-fix",
    title: "Verify a fix closed a known cycle",
    description:
      "Diff a before/after pair of `.memgraph` snapshots to confirm a fix actually closed the originally-classified cycle.",
    arguments: [
      {
        name: "before",
        description: "Path to the before-fix .memgraph",
        required: true,
      },
      {
        name: "after",
        description: "Path to the after-fix .memgraph",
        required: true,
      },
    ],
    render: ({ before, after }) =>
      renderPlaybookPrompt(PLAYBOOKS["verify-fix"], { before, after }),
  },
];

export function findPrompt(name: string): PromptDefinition | undefined {
  return PROMPTS.find((p) => p.name === name);
}

/**
 * v1.13: summarize-trace prompt. Unlike the other prompts (which render
 * multi-step playbooks), this one wraps a single tool call. The brief
 * tells the agent to (1) call `summarizeTrace`, (2) present the
 * pre-rendered markdown card to the user verbatim, (3) offer to drill
 * in via the response's `suggestedNextCalls[]`.
 */
function renderSummarizeTracePrompt(tracePath: string): string {
  return [
    `Run the **trace-summary** flow on \`${tracePath}\`.`,
    "",
    "## Step 1: `summarizeTrace`",
    "",
    "Call this tool first:",
    "",
    "```json",
    `{ "tracePath": "${tracePath}" }`,
    "```",
    "",
    "The response carries a structured per-area summary PLUS a pre-rendered markdown card (`result.markdown`).",
    "",
    "## Step 2: present the markdown card",
    "",
    "Show the user the `markdown` field verbatim. Do NOT re-summarize what it already says. It's been tuned for direct presentation.",
    "",
    "## Step 3: offer to drill in",
    "",
    "Each populated area carries `result.areas.<area>.result.suggestedNextCalls[]` (when present) plus `result.inspection.suggestedNextCalls[]` for the analyzer level. Surface these as concrete follow-up offers (e.g. \"Want me to run `analyzeTimeProfile` to see the top 30 symbols instead of just 15?\").",
    "",
    "## Do NOT",
    "",
    "- Propose architectural changes before the user has seen the summary.",
    "- Re-call `summarizeTrace` to refine; pass `verbose: true` to expand or `focus: \"hangs\"` to bias instead.",
    "- Re-call individual analyzers if the summary already answered the question.",
  ].join("\n");
}

/**
 * Substitutes user-provided values into a playbook's argsTemplate slots and
 * renders a markdown brief the agent can act on directly.
 */
function renderPlaybookPrompt(
  playbook: Playbook,
  values: Record<string, string>,
): string {
  const lines: string[] = [];
  lines.push(`Run the **${playbook.kind}** investigation playbook.`);
  lines.push("");
  lines.push(playbook.summary);
  lines.push("");
  lines.push("## User-provided values");
  for (const [key, value] of Object.entries(values)) {
    lines.push(`- \`${key}\`: \`${value}\``);
  }
  lines.push("");
  lines.push("## Steps");
  lines.push("");
  for (const step of playbook.steps) {
    const argsRendered = renderArgsTemplate(step.argsTemplate, values);
    lines.push(`### ${step.step}. \`${step.tool}\``);
    lines.push("");
    lines.push(step.purpose);
    lines.push("");
    lines.push("```json");
    lines.push(argsRendered);
    lines.push("```");
    if (step.resultGuidance) {
      lines.push("");
      lines.push(`> ${step.resultGuidance}`);
    }
    lines.push("");
  }
  lines.push("Execute the steps in order. After each tool call, follow any");
  lines.push("`suggestedNextCalls` returned by the tool — they're the canonical");
  lines.push("chain. Do not propose architectural changes before evidence.");
  return lines.join("\n");
}

function renderArgsTemplate(
  template: Record<string, unknown>,
  values: Record<string, string>,
): string {
  // Substitute values where keys match — e.g. {path: "<absolute path...>"}
  // becomes {path: "<actual user value>"} when values has matching key.
  // For slots we don't have, leave the template placeholder so the agent
  // can fill it from result chaining (e.g. step 2's class name).
  const filled: Record<string, unknown> = {};
  for (const [key, slot] of Object.entries(template)) {
    if (typeof slot === "string" && values[key]) {
      filled[key] = values[key];
    } else {
      filled[key] = slot;
    }
  }
  return JSON.stringify(filled, null, 2);
}
