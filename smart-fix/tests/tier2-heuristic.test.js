const { generateHeuristicCandidates } = require("../fix-engine/tier2-heuristic");

describe("Tier 2 Heuristic Candidates", () => {
  describe("add_null_check", () => {
    test("TypeScript generates 3 candidates (optional chain, guard, assertion)", () => {
      const error = {
        file: "/test.ts", line: 5, code: "TS2531",
        message: "Object is possibly 'null'",
        captures: { symbolName: "user" },
        fixHint: { primaryStrategy: "add_null_check" },
      };
      const content = "const x = 1;\nconst y = 2;\nconst z = 3;\nconst w = 4;\nconst name = user.name;\n";
      const result = generateHeuristicCandidates(error, content, error.captures, "TypeScript");

      expect(result).not.toBeNull();
      expect(result.candidates.length).toBe(3);
      expect(result.candidates[0].code).toContain("user?");
      expect(result.candidates[1].code).toContain("if (user)");
      expect(result.candidates[2].code).toContain("user!");
      expect(result.promptBlock).toContain("[CHOICE]");
    });

    test("Python generates 2 candidates", () => {
      const error = {
        file: "/test.py", line: 3, code: "PY_NONE",
        message: "value may be None",
        captures: { symbolName: "value" },
        fixHint: { primaryStrategy: "add_null_check" },
      };
      const content = "x = 1\ny = 2\nresult = value.process()\n";
      const result = generateHeuristicCandidates(error, content, error.captures, "Python");

      expect(result).not.toBeNull();
      expect(result.candidates.length).toBe(2);
      expect(result.candidates[0].code).toContain("is not None");
    });

    test("Rust generates 2 candidates (unwrap_or, ?)", () => {
      const error = {
        file: "/test.rs", line: 3, code: "RUST_UNWRAP",
        message: "called unwrap on None",
        captures: { symbolName: "result" },
        fixHint: { primaryStrategy: "add_null_check" },
      };
      const content = "let x = 1;\nlet y = 2;\nlet val = result.unwrap();\n";
      const result = generateHeuristicCandidates(error, content, error.captures, "Rust");

      expect(result).not.toBeNull();
      expect(result.candidates.length).toBe(2);
      expect(result.candidates[0].code).toContain("unwrap_or_default");
      expect(result.candidates[1].code).toContain("?");
    });

    test("Swift generates 3 candidates (if let, guard, ??)", () => {
      const error = {
        file: "/test.swift", line: 3, code: "SWIFT_NIL",
        message: "value of optional type must be unwrapped",
        captures: { symbolName: "user" },
        fixHint: { primaryStrategy: "add_null_check" },
      };
      const content = "let x = 1\nlet y = 2\nlet name = user.name\n";
      const result = generateHeuristicCandidates(error, content, error.captures, "Swift");

      expect(result).not.toBeNull();
      expect(result.candidates.length).toBe(3);
      expect(result.candidates[0].code).toContain("if let");
      expect(result.candidates[1].code).toContain("guard let");
    });
  });

  describe("cast_type", () => {
    test("TypeScript generates cast candidates", () => {
      const error = {
        file: "/test.ts", line: 3, code: "TS2345",
        message: "Argument of type 'string' is not assignable to 'number'",
        captures: { actualType: "string", expectedType: "number" },
        fixHint: { primaryStrategy: "cast_type" },
      };
      const content = "const a = 1;\nconst b = 2;\nconst c = getValue();\n";
      const result = generateHeuristicCandidates(error, content, error.captures, "TypeScript");

      expect(result).not.toBeNull();
      expect(result.candidates.length).toBe(2);
    });

    test("Rust generates .into() and .clone() candidates", () => {
      const error = {
        file: "/test.rs", line: 2, code: "E0308",
        message: "mismatched types expected String found &str",
        captures: { actualType: "&str", expectedType: "String" },
        fixHint: { primaryStrategy: "cast_type" },
      };
      const content = "let x = 1;\nlet s = &name;\n";
      const result = generateHeuristicCandidates(error, content, error.captures, "Rust");

      expect(result).not.toBeNull();
      expect(result.candidates.length).toBe(2);
      expect(result.candidates[0].code).toContain(".into()");
    });
  });

  describe("add_missing_return", () => {
    test("TypeScript generates return candidates", () => {
      const error = {
        file: "/test.ts", line: 2, code: "TS2355",
        message: "function must return a value",
        captures: {},
        fixHint: { primaryStrategy: "add_missing_return" },
      };
      const content = "function getUser() {\n  const user = db.find();\n}\n";
      const result = generateHeuristicCandidates(error, content, error.captures, "TypeScript");

      expect(result).not.toBeNull();
      expect(result.candidates.length).toBe(3);
      expect(result.candidates[0].code).toContain("return undefined");
      expect(result.candidates[2].code).toContain("throw new Error");
    });

    test("Python generates return candidates", () => {
      const error = {
        file: "/test.py", line: 2, code: "PY_RETURN",
        message: "missing return",
        captures: {},
        fixHint: { primaryStrategy: "add_missing_return" },
      };
      const content = "def get_user():\n  user = db.find()\n";
      const result = generateHeuristicCandidates(error, content, error.captures, "Python");

      expect(result).not.toBeNull();
      expect(result.candidates.length).toBe(2);
      expect(result.candidates[0].code).toContain("return None");
    });
  });

  describe("fix_syntax", () => {
    test("generates insert candidates for expected token", () => {
      const error = {
        file: "/test.ts", line: 3, code: "TS1005",
        message: "';' expected",
        captures: { expected: ";" },
        fixHint: { primaryStrategy: "fix_syntax" },
        column: 15,
      };
      const content = "const a = 1;\nconst b = 2;\nconst c = 3\nconst d = 4;\n";
      const result = generateHeuristicCandidates(error, content, error.captures, "TypeScript");

      expect(result).not.toBeNull();
      expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("prompt block", () => {
    test("generates structured [CHOICE] block", () => {
      const error = {
        file: "/test.ts", line: 5, code: "TS2531",
        message: "Object is possibly null",
        captures: { symbolName: "user" },
        fixHint: { primaryStrategy: "add_null_check" },
      };
      const content = "a\nb\nc\nd\nconst name = user.name;\nf\n";
      const result = generateHeuristicCandidates(error, content, error.captures, "TypeScript");

      expect(result.promptBlock).toContain("[CHOICE]");
      expect(result.promptBlock).toContain("TS2531");
      expect(result.promptBlock).toContain("[0]");
      expect(result.promptBlock).toContain("[1]");
      expect(result.promptBlock).toContain("Reply with the number");
    });
  });

  describe("unsupported", () => {
    test("returns null for unsupported strategy", () => {
      const error = {
        file: "/test.ts", line: 1, code: "X",
        message: "msg", captures: {},
        fixHint: { primaryStrategy: "restructure_code" },
      };
      const result = generateHeuristicCandidates(error, "code", {}, "TypeScript");
      expect(result).toBeNull();
    });
  });

  describe("codeBlock in prompt", () => {
    test("includes codeBlock example in choice prompt when available", () => {
      const error = {
        file: "test.ts", line: 5, code: "TS2322",
        message: "Type 'number' is not assignable to type 'string'",
        fixHint: { primaryStrategy: "cast_type" },
        codeBlock: "// Before: const x: string = 123;\n// After:  const x: string = String(123);",
      };
      const content = "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst x: string = 123;\nconst e = 5;";
      const result = generateHeuristicCandidates(error, content, {}, "TypeScript");
      expect(result).not.toBeNull();
      expect(result.promptBlock).toContain("Reference fix");
      expect(result.promptBlock).toContain("// Before");
    });
  });
});
