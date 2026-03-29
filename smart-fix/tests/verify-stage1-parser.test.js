const { extractHints } = require("../hint-extractor");

describe("Stage 1 Verification: Real Compiler Output", () => {
  test("Rust: multi-line error with decorators between hint and error", () => {
    const fullOutput = `error[E0425]: cannot find value \`prntln\` in this scope
  --> src/main.rs:12:5
   |
12 |     prntln!("Hello, world!");
   |     ^^^^^^ not found in this scope
   |
help: a macro with a similar name exists
   |
12 |     println!("Hello, world!");
   |     ~~~~~~~`;
    const hint = extractHints("cannot find value `prntln`", fullOutput, "Rust");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("println");
  });

  test("Rust: consider borrowing hint", () => {
    const fullOutput = `error[E0308]: mismatched types
help: consider borrowing here: \`&my_string\``;
    const hint = extractHints("expected &str, found String", fullOutput, "Rust");
    expect(hint).not.toBeNull();
    expect(hint.type).toBe("borrow_suggestion");
    expect(hint.suggestion).toBe("&my_string");
  });

  test("Python: NameError with Did you mean", () => {
    const msg = "NameError: name 'pritn' is not defined. Did you mean: 'print'?";
    const hint = extractHints(msg, msg, "Python");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("print");
    expect(hint.applicability).toBe("MachineApplicable");
  });

  test("Python: AttributeError suggestion", () => {
    const msg = "AttributeError: module 'os' has no attribute 'pathh'. Did you mean: 'path'?";
    const hint = extractHints(msg, msg, "Python");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("path");
  });

  test("Go: unused import with full package path", () => {
    const msg = '"github.com/gin-gonic/gin" imported and not used';
    const hint = extractHints(msg, msg, "Go");
    expect(hint).not.toBeNull();
    expect(hint.type).toBe("unused_import");
    expect(hint.suggestion).toBe("github.com/gin-gonic/gin");
  });

  test("Go: declared and not used", () => {
    const msg = "err declared and not used";
    const hint = extractHints(msg, msg, "Go");
    expect(hint).not.toBeNull();
    expect(hint.type).toBe("unused_variable");
    expect(hint.suggestion).toBe("err");
  });

  test("TypeScript: Did you mean to use suggestion", () => {
    const msg = "Cannot find name 'react'. Did you mean to use 'React'?";
    const hint = extractHints(msg, msg, "TypeScript");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("React");
  });

  test("C#: Are you missing suggestion", () => {
    const msg = "The type 'JsonConvert' could not be found. Are you missing 'Newtonsoft.Json' using directive?";
    const hint = extractHints(msg, msg, "CSharp");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("Newtonsoft.Json");
  });

  test("Swift: did you mean suggestion", () => {
    const msg = "use of unresolved identifier 'prnt'; did you mean 'print'?";
    const hint = extractHints(msg, msg, "Swift");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("print");
  });

  test("handles null message", () => {
    expect(extractHints(null, null, "TypeScript")).toBeNull();
  });

  test("handles empty string", () => {
    expect(extractHints("", "", "Python")).toBeNull();
  });

  test("handles undefined language", () => {
    const hint = extractHints("Did you mean 'test'?", "", undefined);
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("test");
  });

  test("no ReDoS on long output", () => {
    const longOutput = "error: something\n".repeat(500) + "cannot find symbol";
    const start = Date.now();
    extractHints("cannot find symbol", longOutput, "Java");
    expect(Date.now() - start).toBeLessThan(200);
  });

  test("Java: cannot find symbol with did you mean", () => {
    const msg = "error: cannot find symbol\n  symbol: variable prntln\n  did you mean 'println'?";
    const hint = extractHints(msg, msg, "Java");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("println");
  });
});
