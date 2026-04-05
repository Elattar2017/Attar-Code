"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

// ---------------------------------------------------------------------------
// Fix 6: normalizeHeadings extracted to own module
// ---------------------------------------------------------------------------
describe("Fix 6 — normalizeHeadings module", () => {
  const { normalizeHeadings } = require("../ingestion/heading-normalizer");

  test("module loads and exports normalizeHeadings function", () => {
    expect(typeof normalizeHeadings).toBe("function");
  });

  test("normalizes bold chapter headings", () => {
    const input = "**Chapter 3: Error Handling**";
    const output = normalizeHeadings(input);
    expect(output).toBe("# Chapter 3: Error Handling");
  });

  test("normalizes ALL CAPS headings", () => {
    const input = "GETTING STARTED WITH PYTHON";
    const output = normalizeHeadings(input);
    expect(output).toBe("## GETTING STARTED WITH PYTHON");
  });

  test("normalizes numbered section headings", () => {
    const input = "3. Installation Guide";
    const output = normalizeHeadings(input);
    expect(output).toContain("## 3. Installation Guide");
  });

  test("normalizes bold N.N headings", () => {
    const input = "**3.2 Configuration Options**";
    const output = normalizeHeadings(input);
    expect(output).toContain("## 3.2 Configuration Options");
  });

  test("does NOT normalize code-like bold text", () => {
    const input = "**def my_function(arg)**";
    const output = normalizeHeadings(input);
    // Should remain unchanged — contains snake_case + programming keyword
    expect(output).toBe(input);
  });

  test("same function is re-exported from ingestion/index.js", () => {
    const { normalizeHeadings: fromIndex } = require("../ingestion");
    expect(typeof fromIndex).toBe("function");
    // Both should produce identical output
    const testInput = "**Chapter 1: Introduction**\nSome text\n**2.1 Overview**";
    expect(fromIndex(testInput)).toBe(normalizeHeadings(testInput));
  });
});

// ---------------------------------------------------------------------------
// Fix 7: content_type heuristic uses actual code line counting
// ---------------------------------------------------------------------------
describe("Fix 7 — content_type with actual code lines", () => {
  const { extractMetadata } = require("../ingestion/metadata");

  test("200-line prose with 5-line code block → prose (not mixed)", () => {
    const proseLines = Array.from({ length: 195 }, (_, i) => `Line ${i}: Lorem ipsum dolor sit amet.`);
    const content = [
      ...proseLines.slice(0, 100),
      "```python",
      "def hello():",
      "    print('hi')",
      "    return True",
      "    # comment",
      "```",
      ...proseLines.slice(100),
    ].join("\n");

    const meta = extractMetadata(content, "test.md");
    // 5 code lines out of ~202 total = 2.5% → prose (< 10%)
    expect(meta.content_type).toBe("prose");
  });

  test("chunk with 80% code lines → code", () => {
    const codeLines = Array.from({ length: 80 }, (_, i) => `    x${i} = ${i}`);
    const content = [
      "Here is some code:",
      "```python",
      ...codeLines,
      "```",
      "That was the code.",
    ].join("\n");

    const meta = extractMetadata(content, "test.md");
    // 80 code lines out of ~84 total ≈ 95% → code (> 50%)
    expect(meta.content_type).toBe("code");
  });

  test("chunk with ~30% code lines → mixed", () => {
    const prose = Array.from({ length: 70 }, (_, i) => `Explanation ${i}: some text here.`);
    const code = Array.from({ length: 30 }, (_, i) => `  step_${i}()`);
    const content = [
      ...prose.slice(0, 35),
      "```",
      ...code,
      "```",
      ...prose.slice(35),
    ].join("\n");

    const meta = extractMetadata(content, "test.md");
    // 30 code lines out of ~102 total ≈ 29% → mixed (> 10%, < 50%)
    expect(meta.content_type).toBe("mixed");
  });

  test("no code blocks → prose", () => {
    const content = "This is plain text without any code blocks.\nJust paragraphs.\nNothing else.";
    const meta = extractMetadata(content, "test.md");
    expect(meta.content_type).toBe("prose");
  });
});

// ---------------------------------------------------------------------------
// Fix 8: Import header only on first code chunk
// ---------------------------------------------------------------------------
describe("Fix 8 — import header deduplication", () => {
  const { preprocessCode } = require("../ingestion/preprocessors/code");
  const tmpDir = path.join(os.tmpdir(), `attar-import-test-${Date.now()}`);

  beforeAll(() => { fs.mkdirSync(tmpDir, { recursive: true }); });
  afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {} });

  test("first chunk has imports, subsequent chunks do NOT", () => {
    const fp = path.join(tmpDir, "multi_func.py");
    fs.writeFileSync(fp, `
import os
import sys
from pathlib import Path

def func_a():
    print("a")
    return 1

def func_b():
    print("b")
    return 2

def func_c():
    print("c")
    return 3
`, "utf-8");

    const result = preprocessCode(fp);
    expect(result.chunks.length).toBe(3);

    // First chunk should have imports
    expect(result.chunks[0].content).toContain("import os");
    expect(result.chunks[0].content).toContain("import sys");
    expect(result.chunks[0].content).toContain("func_a");

    // Second and third chunks should NOT have imports
    expect(result.chunks[1].content).not.toContain("import os");
    expect(result.chunks[1].content).toContain("func_b");

    expect(result.chunks[2].content).not.toContain("import os");
    expect(result.chunks[2].content).toContain("func_c");
  });

  test("importHeader is returned for metadata storage", () => {
    const fp = path.join(tmpDir, "with_imports.js");
    fs.writeFileSync(fp, `
const fs = require('fs');
const path = require('path');

function hello() { return 1; }
function world() { return 2; }
`, "utf-8");

    const result = preprocessCode(fp);
    expect(result.importHeader).toContain("require('fs')");
    expect(result.importHeader).toContain("require('path')");
  });

  test("file with no imports: all chunks have content, no empty prefix", () => {
    const fp = path.join(tmpDir, "no_imports.py");
    fs.writeFileSync(fp, `
def func_x():
    return 42

def func_y():
    return 99
`, "utf-8");

    const result = preprocessCode(fp);
    expect(result.chunks.length).toBe(2);
    // No import header at all
    expect(result.chunks[0].content).toContain("func_x");
    expect(result.chunks[1].content).toContain("func_y");
    expect(result.importHeader).toBe("");
  });
});
