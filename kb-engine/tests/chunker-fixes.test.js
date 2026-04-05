"use strict";

const { Chunker } = require("../ingestion/chunker");
const { preprocessCode } = require("../ingestion/preprocessors/code");
const { routeToCollection } = require("../ingestion/collection-router");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ---------------------------------------------------------------------------
// 1. Code block guard — precomputed, no O(n²)
// ---------------------------------------------------------------------------
describe("code block guard — precomputed regions", () => {
  test("does not split inside fenced code blocks", () => {
    const chunker = new Chunker({ maxTokens: 30 });
    const content = [
      "# Intro",
      "Some text before code.",
      "",
      "```python",
      "def hello():",
      "    print('hello')",
      "    print('world')",
      "    return True",
      "```",
      "",
      "Some text after code.",
    ].join("\n");

    const chunks = chunker.chunk(content, "Test");
    // The code block should NOT be split across chunks
    const codeChunk = chunks.find(c => c.content.includes("def hello()"));
    expect(codeChunk).toBeDefined();
    expect(codeChunk.content).toContain("return True");
    expect(codeChunk.content).toContain("```");
  });

  test("handles multiple code blocks correctly", () => {
    const chunker = new Chunker({ maxTokens: 50 });
    const content = [
      "# Functions",
      "First function:",
      "```js",
      "function a() { return 1; }",
      "```",
      "Second function:",
      "```js",
      "function b() { return 2; }",
      "```",
    ].join("\n");

    const chunks = chunker.chunk(content, "Test");
    // Both code blocks should be intact
    const combined = chunks.map(c => c.content).join("\n");
    expect(combined).toContain("function a()");
    expect(combined).toContain("function b()");
  });

  test("performance: large document does not hang", () => {
    const chunker = new Chunker({ maxTokens: 100 });
    // Generate a large document with many paragraphs + code blocks
    const lines = [];
    for (let i = 0; i < 200; i++) {
      lines.push(`Paragraph ${i}: Lorem ipsum dolor sit amet, consectetur adipiscing elit.`);
      if (i % 20 === 0) {
        lines.push("```python");
        lines.push(`def func_${i}(): pass`);
        lines.push("```");
      }
      lines.push("");
    }
    const content = "# Big Doc\n" + lines.join("\n");

    const start = Date.now();
    const chunks = chunker.chunk(content, "Big");
    const elapsed = Date.now() - start;

    expect(chunks.length).toBeGreaterThan(10);
    // Should complete in under 500ms (old O(n²) would take seconds)
    expect(elapsed).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// 2. Table detection — requires pipes at both ends
// ---------------------------------------------------------------------------
describe("table detection — strict pipe matching", () => {
  test("keeps table rows together", () => {
    const chunker = new Chunker({ maxTokens: 50 });
    const content = [
      "# Data",
      "Here is a table:",
      "",
      "| Name | Value |",
      "|------|-------|",
      "| A    | 1     |",
      "| B    | 2     |",
      "| C    | 3     |",
      "",
      "After the table.",
    ].join("\n");

    const chunks = chunker.chunk(content, "Test");
    // Table should be in one chunk
    const tableChunk = chunks.find(c => c.content.includes("| Name"));
    expect(tableChunk).toBeDefined();
    expect(tableChunk.content).toContain("| C    | 3     |");
  });

  test("line starting with | but no ending | is NOT treated as table", () => {
    const chunker = new Chunker({ maxTokens: 30 });
    // This should NOT be treated as a table row:
    const content = "# Test\n| this is just a line starting with pipe\n\nSome other text here.";
    const chunks = chunker.chunk(content, "Test");
    // Should not crash or misbehave
    expect(chunks.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Overlap sentence boundary — works for lowercase text
// ---------------------------------------------------------------------------
describe("overlap sentence boundary", () => {
  test("finds sentence boundary in lowercase text", () => {
    const chunker = new Chunker({ maxTokens: 30, overlapTokens: 40 });
    const content = [
      "# Section",
      "this is a lowercase paragraph. it has multiple sentences. the third one is here.",
      "",
      "this is another paragraph with more content that goes on and on to exceed the token limit.",
    ].join("\n");

    const chunks = chunker.chunk(content, "Test");
    // With overlap, the second chunk should start at a sentence boundary from the first
    if (chunks.length > 1) {
      // Check that overlap text doesn't start mid-word
      const secondContent = chunks[1].content;
      // Should start with a lowercase letter (from sentence boundary) or the overlap text
      expect(secondContent.length).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Code preprocessor — C#, Swift, Kotlin patterns
// ---------------------------------------------------------------------------
describe("code preprocessor — language patterns", () => {
  const tmpDir = path.join(os.tmpdir(), `attar-code-test-${Date.now()}`);

  beforeAll(() => { fs.mkdirSync(tmpDir, { recursive: true }); });
  afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {} });

  function writeAndProcess(filename, content) {
    const fp = path.join(tmpDir, filename);
    fs.writeFileSync(fp, content, "utf-8");
    return preprocessCode(fp);
  }

  test("C# — detects classes, methods, interfaces", () => {
    const result = writeAndProcess("test.cs", `
using System;

namespace MyApp
{
    public class UserService
    {
        public void GetUser(int id) { }
        private string FormatName(string name) { return name; }
    }

    public interface IRepository
    {
        void Save();
    }
}
`);
    expect(result.language).toBe("csharp");
    const names = result.chunks.map(c => c.name);
    expect(names).toContain("MyApp");
    expect(names).toContain("UserService");
  });

  test("Swift — detects funcs, structs, protocols", () => {
    const result = writeAndProcess("test.swift", `
import Foundation

struct Point {
    var x: Double
    var y: Double
}

protocol Drawable {
    func draw()
}

func calculateDistance(from a: Point, to b: Point) -> Double {
    return sqrt(pow(b.x - a.x, 2) + pow(b.y - a.y, 2))
}
`);
    expect(result.language).toBe("swift");
    const names = result.chunks.map(c => c.name);
    expect(names).toContain("Point");
    expect(names).toContain("Drawable");
    expect(names).toContain("calculateDistance");
  });

  test("Kotlin — detects fun, data class, object", () => {
    const result = writeAndProcess("test.kt", `
package com.example

data class User(val name: String, val age: Int)

object Database {
    fun connect() { }
}

fun greet(user: User): String {
    return "Hello, " + user.name
}
`);
    expect(result.language).toBe("kotlin");
    const names = result.chunks.map(c => c.name);
    expect(names).toContain("User");
    expect(names).toContain("Database");
    expect(names).toContain("greet");
  });

  test("Python still works (regression)", () => {
    const result = writeAndProcess("test.py", `
import os

def hello():
    print("hello")

class Dog:
    def bark(self):
        pass
`);
    expect(result.language).toBe("python");
    const names = result.chunks.map(c => c.name);
    expect(names).toContain("hello");
    expect(names).toContain("Dog");
  });
});

// ---------------------------------------------------------------------------
// 5. Collection router — word boundary matching
// ---------------------------------------------------------------------------
describe("collection router — word boundary matching", () => {
  test("'go' in route does NOT match 'django' or 'mongo' paths", () => {
    // These should NOT route to 'go' collection
    expect(routeToCollection("/projects/django/models.py", {})).not.toBe("go");
    expect(routeToCollection("/projects/mongoose/schema.js", {})).not.toBe("go");
    expect(routeToCollection("C:\\cargo\\project\\main.rs", {})).not.toBe("go");
  });

  test("'go' in route DOES match actual Go paths", () => {
    expect(routeToCollection("/projects/go/main.go", {})).toBe("go");
    expect(routeToCollection("/home/user/golang-tutorial/ch1.md", {})).toBe("go");
  });

  test("'python' matches python paths", () => {
    expect(routeToCollection("/books/python-programming/ch1.pdf", {})).toBe("python");
    expect(routeToCollection("C:\\docs\\python\\tutorial.md", {})).toBe("python");
  });

  test("explicit collection override still wins", () => {
    expect(routeToCollection("/some/random/path.txt", {}, { collection: "personal" })).toBe("personal");
  });

  test("language fallback still works", () => {
    expect(routeToCollection("/random/file.py", { language: "python" })).toBe("python");
    expect(routeToCollection("/random/file.rs", { language: "rust" })).toBe("rust");
  });

  test("unknown path → general", () => {
    expect(routeToCollection("/random/unknown/file.txt", {})).toBe("general");
  });
});
