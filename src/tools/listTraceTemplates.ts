import { z } from "zod";
import { runCommand } from "../runtime/exec.js";

export const listTraceTemplatesSchema = z.object({});

export type ListTraceTemplatesInput = z.infer<typeof listTraceTemplatesSchema>;

export interface TraceTemplate {
  name: string;
  /** "standard" for built-in templates, "custom" for user templates. */
  category: "standard" | "custom";
}

export interface ListTraceTemplatesResult {
  ok: boolean;
  templates: TraceTemplate[];
}

/** Pure: parse `xctrace list templates` output. */
export function parseTemplateListing(text: string): TraceTemplate[] {
  const lines = text.split(/\r?\n/);
  let category: TraceTemplate["category"] | null = null;
  const templates: TraceTemplate[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "== Standard Templates ==") {
      category = "standard";
      continue;
    }
    if (line === "== Custom Templates ==") {
      category = "custom";
      continue;
    }
    if (!category) continue;
    if (line.startsWith("==")) continue;
    templates.push({ name: line, category });
  }
  return templates;
}

export async function listTraceTemplates(
  _input: ListTraceTemplatesInput,
): Promise<ListTraceTemplatesResult> {
  const result = await runCommand("xcrun", ["xctrace", "list", "templates"], {
    timeoutMs: 15_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `xctrace list templates failed (code ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  return { ok: true, templates: parseTemplateListing(result.stdout) };
}
