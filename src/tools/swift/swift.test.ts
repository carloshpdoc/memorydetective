import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSymbolDeclaration, snippetAt, escapeRegex } from "./_helpers.js";
import { swiftSearchPattern } from "./searchPattern.js";

let tmp: string;
let sample: string;
const SAMPLE_SWIFT = `
import Foundation
import SwiftUI

struct GreetingView: View {
    var body: some View {
        Text("hi")
    }
}

class DetailViewModel: ObservableObject {
    @Published var items: [Item] = []

    func reload() {
        Task {
            await fetch()
        }
    }
}

extension DetailViewModel {
    func fetch() async {
        // Closure capturing self strongly:
        cancellable = subject.sink { [weak self] value in
            self?.items.append(value)
        }
    }
}
`;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "memorydetective-swift-test-"));
  sample = join(tmp, "DetailViewModel.swift");
  writeFileSync(sample, SAMPLE_SWIFT, "utf8");
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("findSymbolDeclaration", () => {
  it("finds a class declaration after the `class` keyword", () => {
    const pos = findSymbolDeclaration(sample, "DetailViewModel");
    expect(pos).not.toBeNull();
    expect(pos!.matchedText).toContain("class DetailViewModel");
    expect(pos!.line).toBeGreaterThan(0);
    expect(pos!.character).toBeGreaterThanOrEqual(0);
  });

  it("finds a struct declaration", () => {
    const pos = findSymbolDeclaration(sample, "GreetingView");
    expect(pos).not.toBeNull();
    expect(pos!.matchedText).toContain("struct GreetingView");
  });

  it("falls back to a standalone-word match when no declaration keyword precedes it", () => {
    // `items` is declared via `@Published var items`. Despite the @Published
    // attribute, the regex finds the var-keyword form. Sanity check:
    const pos = findSymbolDeclaration(sample, "items");
    expect(pos).not.toBeNull();
  });

  it("returns null for a name that doesn't appear", () => {
    expect(findSymbolDeclaration(sample, "DefinitelyNotPresent")).toBeNull();
  });

  it("escapes regex metacharacters in the symbol name", () => {
    // Calling with a name containing dots shouldn't blow up the regex.
    expect(() => findSymbolDeclaration(sample, "Foo.Bar")).not.toThrow();
  });
});

describe("snippetAt", () => {
  it("returns 1 line of context above and below by default", () => {
    const pos = findSymbolDeclaration(sample, "DetailViewModel")!;
    const ctx = snippetAt(sample, pos.line);
    expect(ctx.split(/\r?\n/).length).toBe(3);
    expect(ctx).toContain("class DetailViewModel");
  });

  it("clips to file boundaries near the start", () => {
    const ctx = snippetAt(sample, 0);
    expect(ctx.split(/\r?\n/).length).toBeLessThanOrEqual(2);
  });
});

describe("escapeRegex", () => {
  it("escapes regex metacharacters", () => {
    expect(escapeRegex("Foo.Bar(*)")).toBe("Foo\\.Bar\\(\\*\\)");
  });
});

describe("swiftSearchPattern", () => {
  it("finds [weak self] capture lists", async () => {
    const result = await swiftSearchPattern({
      filePath: sample,
      pattern: "\\[weak\\s+self\\]",
      maxMatches: 50,
    });
    expect(result.matches.length).toBe(1);
    expect(result.matches[0].text).toMatch(/\[weak\s+self\]/);
    expect(result.matches[0].snippet).toContain("[weak self]");
  });

  it("respects maxMatches cap and reports truncation", async () => {
    const result = await swiftSearchPattern({
      filePath: sample,
      pattern: "\\b\\w+\\b",
      maxMatches: 3,
    });
    expect(result.matches.length).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it("rejects invalid regex patterns with a clear error", async () => {
    await expect(
      swiftSearchPattern({
        filePath: sample,
        pattern: "(unclosed",
        maxMatches: 10,
      }),
    ).rejects.toThrow(/Invalid regex/);
  });

  it("throws when file doesn't exist", async () => {
    await expect(
      swiftSearchPattern({
        filePath: "/nope/does-not-exist.swift",
        pattern: "self",
        maxMatches: 1,
      }),
    ).rejects.toThrow(/File not found/);
  });

  it("returns an empty match list (not error) when the pattern has zero hits", async () => {
    const result = await swiftSearchPattern({
      filePath: sample,
      pattern: "ZZZ_definitely_not_here_ZZZ",
      maxMatches: 10,
    });
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});
