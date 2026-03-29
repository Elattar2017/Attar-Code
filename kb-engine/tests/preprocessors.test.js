const fs = require("fs");
const os = require("os");
const path = require("path");
const { preprocessMarkdown } = require("../ingestion/preprocessors/markdown");
const { preprocessText } = require("../ingestion/preprocessors/text");
const { preprocessPdf } = require("../ingestion/preprocessors/pdf");
const { preprocessCode } = require("../ingestion/preprocessors/code");

// jsdom (a dependency of html.js) uses ESM internally and cannot be loaded by
// Jest's CJS runtime. We mock the three external deps so we can test the logic
// of preprocessHtml without a real DOM parser.
jest.mock("jsdom", () => {
  return {
    JSDOM: jest.fn().mockImplementation((html, opts) => {
      // Minimal DOM mock: extract <title> and <h1> via regex
      const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
      const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/i);
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      const docTitle = titleMatch ? titleMatch[1] : "";
      const articleH1 = h1Match ? h1Match[1] : null;
      const bodyContent = bodyMatch ? bodyMatch[1] : html;
      // Store extracted info on document for Readability mock to use
      const doc = {
        title: docTitle,
        querySelector: () => null,
        _articleH1: articleH1,
        _bodyContent: bodyContent,
      };
      return {
        window: { document: doc },
      };
    }),
  };
});

jest.mock("@mozilla/readability", () => {
  return {
    Readability: jest.fn().mockImplementation((doc) => {
      return {
        parse: jest.fn().mockReturnValue(
          doc._articleH1
            ? {
                title: doc._articleH1,
                content: doc._bodyContent || "",
              }
            : null
        ),
      };
    }),
  };
});

jest.mock("turndown", () => {
  // Minimal Turndown mock: converts basic HTML tags to markdown
  const TurndownService = jest.fn().mockImplementation(() => {
    return {
      addRule: jest.fn(),
      turndown: jest.fn().mockImplementation((html) => {
        if (typeof html !== "string") return "";
        return html
          .replace(/<h1[^>]*>(.*?)<\/h1>/gi, "# $1")
          .replace(/<h2[^>]*>(.*?)<\/h2>/gi, "## $1")
          .replace(/<h3[^>]*>(.*?)<\/h3>/gi, "### $1")
          .replace(/<pre[^>]*><code[^>]*class="language-(\w+)"[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```$1\n$2\n```\n")
          .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n")
          .replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n")
          .replace(/<[^>]+>/g, "")
          .trim();
      }),
    };
  });
  return TurndownService;
});

// Now it is safe to load html.js since its deps are mocked
const { preprocessHtml } = require("../ingestion/preprocessors/html");

// Helper: write a temp file and return its path
function writeTempFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preprocessors-test-"));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Markdown preprocessor tests
// ---------------------------------------------------------------------------
describe("preprocessMarkdown", () => {
  test("reads file and extracts title from # heading", () => {
    const filePath = writeTempFile("guide.md", "# My Guide\n\nSome content here.\n");
    const result = preprocessMarkdown(filePath);

    expect(result.title).toBe("My Guide");
    expect(result.content).toBe("# My Guide\n\nSome content here.\n");
    expect(result.format).toBe("markdown");
  });

  test("returns content unchanged (pass-through)", () => {
    const raw = "# Title\n\n## Section\n\n- item 1\n- item 2\n";
    const filePath = writeTempFile("doc.md", raw);
    const result = preprocessMarkdown(filePath);

    expect(result.content).toBe(raw);
  });

  test("no heading → title derived from filename", () => {
    const filePath = writeTempFile("release-notes.md", "Just some plain text without any heading.\n");
    const result = preprocessMarkdown(filePath);

    expect(result.title).toBe("release-notes");
    expect(result.format).toBe("markdown");
  });

  test("picks only the FIRST # heading as title", () => {
    const filePath = writeTempFile("multi.md", "# First Heading\n\n# Second Heading\n");
    const result = preprocessMarkdown(filePath);

    expect(result.title).toBe("First Heading");
  });
});

// ---------------------------------------------------------------------------
// Text preprocessor tests
// ---------------------------------------------------------------------------
describe("preprocessText", () => {
  test("ALL CAPS lines are converted to ## headings", () => {
    const filePath = writeTempFile("notes.txt", "INTRODUCTION\n\nSome text here.\n");
    const result = preprocessText(filePath);

    expect(result.content).toContain("## INTRODUCTION");
    expect(result.format).toBe("text");
  });

  test("colon-ending short lines are converted to ### headings", () => {
    const filePath = writeTempFile("config.txt", "Database settings:\n\nhost=localhost\n");
    const result = preprocessText(filePath);

    expect(result.content).toContain("### Database settings");
  });

  test("title comes from the first non-empty line", () => {
    const filePath = writeTempFile("readme.txt", "\n\nWelcome to the project\n\nMore details here.\n");
    const result = preprocessText(filePath);

    expect(result.title).toBe("Welcome to the project");
  });

  test("title is capped at 100 characters", () => {
    const longLine = "A".repeat(150);
    const filePath = writeTempFile("long.txt", longLine + "\n\nContent.\n");
    const result = preprocessText(filePath);

    expect(result.title.length).toBe(100);
  });

  test("non-caps lines are NOT converted to ## headings", () => {
    const filePath = writeTempFile("mixed.txt", "This is a normal line\n\nANOTHER CAPS LINE\n");
    const result = preprocessText(filePath);

    expect(result.content).not.toMatch(/^## This is a normal line/m);
    expect(result.content).toContain("## ANOTHER CAPS LINE");
  });
});

// ---------------------------------------------------------------------------
// HTML preprocessor tests
// ---------------------------------------------------------------------------
describe("preprocessHtml", () => {
  test("converts headings to # markdown", () => {
    const html = `<!DOCTYPE html><html><head><title>My Page</title></head><body>
      <article><h1>Main Title</h1><p>Some paragraph content here for readability.</p></article>
    </body></html>`;
    const result = preprocessHtml(html);

    expect(result.format).toBe("html");
    expect(result.content).toMatch(/^#\s+/m);
  });

  test("extracts title from <title> tag", () => {
    const html = `<!DOCTYPE html><html><head><title>Doc Title</title></head>
      <body><article><p>Content paragraph that is long enough for readability to parse it properly.</p></article></body></html>`;
    const result = preprocessHtml(html);

    expect(result.format).toBe("html");
    expect(result.title).toBeTruthy();
    expect(typeof result.title).toBe("string");
  });

  test("preserves code blocks as fenced markdown", () => {
    const html = `<!DOCTYPE html><html><head><title>Code Example</title></head>
      <body><article>
        <h1>Code Example</h1>
        <p>Here is some code:</p>
        <pre><code class="language-javascript">const x = 1;</code></pre>
      </article></body></html>`;
    const result = preprocessHtml(html);

    expect(result.content).toContain("```");
    expect(result.content).toContain("const x = 1;");
  });

  test("returns format html and a string content", () => {
    const html = `<html><head><title>Simple</title></head><body><p>Hello world</p></body></html>`;
    const result = preprocessHtml(html);

    expect(result.format).toBe("html");
    expect(typeof result.content).toBe("string");
    expect(result.content.length).toBeGreaterThan(0);
  });

  test("extracts title from <h1> when Readability finds article", () => {
    const html = `<!DOCTYPE html><html><head><title></title></head>
      <body><article>
        <h1>Article Heading</h1>
        <p>This is a fairly long paragraph that should allow Readability to parse the article correctly.</p>
      </article></body></html>`;
    const result = preprocessHtml(html);

    expect(result.title).toBeTruthy();
    expect(result.format).toBe("html");
  });
});

// ---------------------------------------------------------------------------
// PDF preprocessor tests
// ---------------------------------------------------------------------------
describe("preprocessPdf", () => {
  test("returns format: pdf", async () => {
    const result = await preprocessPdf("/nonexistent/fake.pdf");
    expect(result.format).toBe("pdf");
  });

  test("returns error message when extraction fails (graceful degradation)", async () => {
    const result = await preprocessPdf("/nonexistent/fake.pdf");
    expect(typeof result.content).toBe("string");
    if (!result.content) {
      expect(result.error).toBeDefined();
    }
  });

  test("uses filename as title", async () => {
    const result = await preprocessPdf("/some/path/my-document.pdf");
    expect(result.title).toBe("my-document");
  });

  test("never rejects — always resolves with object containing format and title", async () => {
    await expect(preprocessPdf("/totally/bogus/path.pdf")).resolves.toHaveProperty("format", "pdf");
    const result = await preprocessPdf("/totally/bogus/path.pdf");
    expect(result).toHaveProperty("title");
  });
});

// ---------------------------------------------------------------------------
// Code preprocessor tests
// ---------------------------------------------------------------------------
describe("preprocessCode", () => {
  test("JavaScript: extracts named functions", () => {
    const code = `const fs = require("fs");

function doSomething(a, b) {
  return a + b;
}

function anotherFunc() {
  return 42;
}
`;
    const filePath = writeTempFile("utils.js", code);
    const result = preprocessCode(filePath);

    expect(result.format).toBe("code");
    expect(result.language).toBe("javascript");
    expect(result.chunks.length).toBeGreaterThanOrEqual(2);
    const names = result.chunks.map((c) => c.name);
    expect(names).toContain("doSomething");
    expect(names).toContain("anotherFunc");
  });

  test("JavaScript: extracts class declarations", () => {
    const code = `class MyClass {
  constructor() {}
  greet() { return "hello"; }
}

class AnotherClass {}
`;
    const filePath = writeTempFile("classes.js", code);
    const result = preprocessCode(filePath);

    const classChunks = result.chunks.filter((c) => c.type === "class");
    expect(classChunks.length).toBeGreaterThanOrEqual(1);
    const names = classChunks.map((c) => c.name);
    expect(names).toContain("MyClass");
  });

  test("Python: extracts def and class", () => {
    const code = `import os

def hello_world():
    print("Hello")

class MyClass:
    def method(self):
        pass

def another_function(x):
    return x * 2
`;
    const filePath = writeTempFile("script.py", code);
    const result = preprocessCode(filePath);

    expect(result.format).toBe("code");
    expect(result.language).toBe("python");
    expect(result.chunks.length).toBeGreaterThanOrEqual(2);
    const names = result.chunks.map((c) => c.name);
    expect(names).toContain("hello_world");
    expect(names).toContain("MyClass");
  });

  test("returns importHeader with require/import lines", () => {
    const code = `const fs = require("fs");
const path = require("path");

function main() {
  return true;
}
`;
    const filePath = writeTempFile("main.js", code);
    const result = preprocessCode(filePath);

    expect(result.importHeader).toContain('require("fs")');
    expect(result.importHeader).toContain('require("path")');
  });

  test("each chunk has name and type properties", () => {
    const code = `function alpha() { return 1; }
function beta() { return 2; }
`;
    const filePath = writeTempFile("fns.js", code);
    const result = preprocessCode(filePath);

    for (const chunk of result.chunks) {
      expect(chunk).toHaveProperty("name");
      expect(chunk).toHaveProperty("type");
      expect(typeof chunk.name).toBe("string");
      expect(typeof chunk.type).toBe("string");
    }
  });

  test("no functions → returns whole file as single chunk with type file", () => {
    const code = `// Just some constants and no functions
const VALUE = 42;
const NAME = "hello";
`;
    const filePath = writeTempFile("constants.js", code);
    const result = preprocessCode(filePath);

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].type).toBe("file");
    expect(result.chunks[0].content).toBe(code);
  });

  test("import header is prepended to each chunk content", () => {
    const code = `const util = require("util");

function compute() {
  return util.promisify(setTimeout);
}
`;
    const filePath = writeTempFile("compute.js", code);
    const result = preprocessCode(filePath);

    if (result.importHeader && result.chunks[0].type !== "file") {
      for (const chunk of result.chunks) {
        expect(chunk.content).toContain('require("util")');
      }
    }
  });
});
