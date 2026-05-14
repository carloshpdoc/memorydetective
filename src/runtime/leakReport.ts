/**
 * Self-contained HTML rendering for `detectLeaksInXCTest` and
 * `detectLeaksInXCUITest`.
 *
 * The rendered file embeds inline CSS (no external assets) so it renders the
 * same way in:
 *
 *   - GitHub's file preview after upload-artifact + download
 *   - PR-comment bots that link to the artifact URL
 *   - A local `open report.html` from a CI failure investigation
 *
 * The template lives at `src/templates/leak-report.html` and is substituted
 * with three placeholders: `{{TITLE}}`, `{{VERSION}}`, `{{TIMESTAMP}}`,
 * `{{BODY}}`. The body fragment is generated per-call and represents the
 * per-test sections (totals, new-cycles table, embedded steps log).
 *
 * Inputs are intentionally narrowed to the result shapes the two detect
 * tools share, so the renderer can be called from either tool without
 * conditional branches.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../version.js";

const here = dirname(fileURLToPath(import.meta.url));
// `dist/runtime/leakReport.js` -> `dist/templates/leak-report.html`
// (matches the `tsconfig.json` layout where src and dist are parallel).
const TEMPLATE_PATH = resolvePath(here, "..", "templates", "leak-report.html");

let cachedTemplate: string | null = null;
function loadTemplate(): string {
  if (cachedTemplate == null) {
    cachedTemplate = readFileSync(TEMPLATE_PATH, "utf8");
  }
  return cachedTemplate;
}

export interface LeakReportSection {
  /** Short label that goes at the top of the section (e.g. test identifier). */
  title: string;
  /** True when the section passed all checks (green verdict pill). */
  passed: boolean;
  /** Free-text reason rendered next to the pill when `passed` is false. */
  failureReason?: string;
  /** Absolute path to the baseline `.memgraph` (rendered as a `<code>` line). */
  baselineMemgraph?: string;
  /** Absolute path to the after `.memgraph`. */
  afterMemgraph?: string;
  totals: {
    baselineLeaks: number;
    afterLeaks: number;
    leakDelta: number;
  };
  newCycles: Array<{
    rootClass: string;
    chainLength: number;
    allowlisted: boolean;
  }>;
  /** Step-by-step log, rendered inside a collapsed `<details>` block. */
  steps?: string[];
}

export interface RenderLeakReportInput {
  title: string;
  /** Optional context line (e.g. scheme, destination) rendered under the H1. */
  subtitle?: string;
  sections: LeakReportSection[];
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderSection(section: LeakReportSection): string {
  const verdict = section.passed
    ? '<span class="verdict pass">PASS</span>'
    : '<span class="verdict fail">FAIL</span>';
  const failReason = section.failureReason
    ? `<p style="margin-top:.5rem;color:#ff3b30">${escapeHtml(section.failureReason)}</p>`
    : "";
  const baseline = section.baselineMemgraph
    ? `<div><span class="label">Baseline:</span> <code>${escapeHtml(section.baselineMemgraph)}</code></div>`
    : "";
  const after = section.afterMemgraph
    ? `<div><span class="label">After:</span> <code>${escapeHtml(section.afterMemgraph)}</code></div>`
    : "";

  const stats = `
    <div style="margin:.75rem 0">
      <div class="stat"><div class="n">${section.totals.baselineLeaks}</div><div class="label">Baseline</div></div>
      <div class="stat"><div class="n">${section.totals.afterLeaks}</div><div class="label">After</div></div>
      <div class="stat"><div class="n">${section.totals.leakDelta >= 0 ? "+" : ""}${section.totals.leakDelta}</div><div class="label">Delta</div></div>
    </div>`;

  const cyclesTable =
    section.newCycles.length === 0
      ? '<p style="opacity:.65;margin:.5rem 0">No new ROOT CYCLEs after the test.</p>'
      : `
    <table>
      <thead><tr><th>Root class</th><th>Chain length</th><th>Status</th></tr></thead>
      <tbody>${section.newCycles
        .map(
          (c) => `
        <tr>
          <td><code>${escapeHtml(c.rootClass)}</code></td>
          <td>${c.chainLength}</td>
          <td>${
            c.allowlisted
              ? '<span class="badge allow">allowlisted</span>'
              : '<span class="badge fail">new leak</span>'
          }</td>
        </tr>`,
        )
        .join("")}
      </tbody>
    </table>`;

  const stepsBlock =
    section.steps && section.steps.length > 0
      ? `<details><summary>Run log (${section.steps.length} step${section.steps.length === 1 ? "" : "s"})</summary><div class="steps">${section.steps.map(escapeHtml).join("\n")}</div></details>`
      : "";

  return `
  <section class="card">
    <h2 style="margin:0">${escapeHtml(section.title)} ${verdict}</h2>
    ${failReason}
    ${baseline}
    ${after}
    ${stats}
    ${cyclesTable}
    ${stepsBlock}
  </section>`;
}

export function renderLeakReportHtml(input: RenderLeakReportInput): string {
  const template = loadTemplate();
  const body =
    (input.subtitle
      ? `<div class="meta" style="margin-top:-1rem;margin-bottom:1.25rem">${escapeHtml(input.subtitle)}</div>`
      : "") + input.sections.map(renderSection).join("\n");
  return template
    .replace(/\{\{TITLE\}\}/g, escapeHtml(input.title))
    .replace(/\{\{VERSION\}\}/g, escapeHtml(VERSION))
    .replace(/\{\{TIMESTAMP\}\}/g, escapeHtml(new Date().toISOString()))
    .replace(/\{\{BODY\}\}/g, body);
}

/**
 * Render and persist the HTML report. Returns the absolute path it was
 * written to. The caller is responsible for choosing the path (so the same
 * helper drives both the XCTest and XCUITest tools without each tool having
 * to know about path conventions).
 */
export function writeLeakReportHtml(
  outputPath: string,
  input: RenderLeakReportInput,
): string {
  const absolute = resolvePath(outputPath);
  writeFileSync(absolute, renderLeakReportHtml(input), "utf8");
  return absolute;
}

// Exposed for tests so the cached template can be reset between cases.
export function _resetTemplateCacheForTests(): void {
  cachedTemplate = null;
}

export function _templatePathForTests(): string {
  return TEMPLATE_PATH;
}

// Build-time pin so `npm pack` ships the template alongside `dist/`. The
// `package.json` `files` field needs to include `src/templates/**` AND
// `dist/templates/**` after the build copies them. Verified in tests by
// reading `loadTemplate()` synchronously: if the template is missing, the
// first leak-report render throws an obvious ENOENT.
//
// Why pin the path instead of bundling the HTML as a string constant?
// Keeping the template as a real HTML file lets contributors preview it in
// a browser without going through a TS rebuild, and keeps the CSS-heavy
// section out of TypeScript's diagnostics.
const _BUILD_NOTE = "see comment block";
void _BUILD_NOTE;

// Re-export so other build steps can locate the template path without
// importing the private helper.
export const LEAK_REPORT_TEMPLATE_PATH = TEMPLATE_PATH;

// Type re-exports for downstream callers.
export type { LeakReportSection as LeakReportSectionType };
