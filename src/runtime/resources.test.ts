import { describe, it, expect } from "vitest";
import { PATTERNS } from "../tools/classifyCycle.js";
import {
  listPatternResources,
  readPatternResource,
  patternUri,
  patternIdFromUri,
} from "./resources.js";

describe("MCP Resources — pattern catalog", () => {
  it("listPatternResources returns one entry per PATTERN", () => {
    const list = listPatternResources();
    expect(list.length).toBe(PATTERNS.length);
  });

  it("each list entry has uri, name, description, and markdown mimeType", () => {
    const list = listPatternResources();
    for (const r of list) {
      expect(r.uri).toMatch(/^memorydetective:\/\/patterns\//);
      expect(r.name).toBeTruthy();
      expect(r.description).toBeTruthy();
      expect(r.mimeType).toBe("text/markdown");
    }
  });

  it("readPatternResource returns markdown body for a known pattern URI", () => {
    const id = "swiftui.tag-index-projection";
    const body = readPatternResource(patternUri(id));
    expect(body).not.toBeNull();
    expect(body?.uri).toBe(`memorydetective://patterns/${id}`);
    expect(body?.mimeType).toBe("text/markdown");
    expect(body?.text).toContain("Pattern ID:");
    expect(body?.text).toContain(id);
    // Body should include the fixHint somewhere.
    const pattern = PATTERNS.find((p) => p.id === id);
    expect(pattern).toBeDefined();
    expect(body?.text).toContain(pattern!.fixHint.slice(0, 30));
  });

  it("readPatternResource returns null for unknown URIs", () => {
    expect(readPatternResource("memorydetective://patterns/does-not-exist")).toBeNull();
    expect(readPatternResource("https://example.com/foo")).toBeNull();
    expect(readPatternResource("memorydetective://something-else/foo")).toBeNull();
  });

  it("patternUri and patternIdFromUri are inverse", () => {
    const id = "combine.sink-store-self-capture";
    expect(patternIdFromUri(patternUri(id))).toBe(id);
  });

  it("patternIdFromUri returns null for malformed URIs", () => {
    expect(patternIdFromUri("memorydetective://patterns/")).toBeNull();
    expect(patternIdFromUri("memorydetective://other/foo")).toBeNull();
    expect(patternIdFromUri("not-a-uri")).toBeNull();
  });

  it("every PATTERN has a unique resource URI (id collision regression guard)", () => {
    const list = listPatternResources();
    const uris = new Set(list.map((r) => r.uri));
    expect(uris.size).toBe(list.length);
  });
});
