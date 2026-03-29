// smart-fix/tests/hint-extractor.test.js
const { extractHints } = require("../hint-extractor");

describe("Hint Extractor", () => {
  test("extracts Rust 'did you mean' hint", () => {
    const message = "cannot find value `prnt` in this scope";
    const fullOutput = `error[E0425]: cannot find value \`prnt\` in this scope
 --> src/main.rs:5:9
  |
5 |         prnt!("hello");
  |         ^^^^ help: a macro with a similar name exists: \`print\``;
    const hint = extractHints(message, fullOutput, "Rust");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("print");
    expect(hint.applicability).toBe("MaybeIncorrect");
    expect(hint.type).toBe("did_you_mean");
  });

  test("extracts TypeScript suggestion", () => {
    const message = "Property 'forEch' does not exist on type 'any[]'. Did you mean 'forEach'?";
    const hint = extractHints(message, message, "TypeScript");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("forEach");
    expect(hint.type).toBe("did_you_mean");
    expect(hint.applicability).toBe("MachineApplicable");
  });

  test("extracts Python ImportError suggestion", () => {
    const message = "cannot import name 'Listt' from 'typing'. Did you mean: 'List'?";
    const hint = extractHints(message, message, "Python");
    expect(hint.suggestion).toBe("List");
  });

  test("extracts Go unused import hint", () => {
    const message = '"fmt" imported and not used';
    const hint = extractHints(message, message, "Go");
    expect(hint.type).toBe("unused_import");
    expect(hint.suggestion).toBe("fmt");
  });

  test("extracts Java 'cannot find symbol' hint", () => {
    const message = "error: cannot find symbol\n  symbol: variable prntln\n  did you mean 'println'?";
    const hint = extractHints(message, message, "Java");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("println");
  });

  test("extracts PHP undefined variable", () => {
    const message = "Undefined variable $ustName";
    const hint = extractHints(message, message, "PHP");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("ustName");
    expect(hint.type).toBe("undefined_variable");
  });

  test("extracts Kotlin unresolved reference hint", () => {
    const message = "Unresolved reference: prntln. Did you mean 'println'?";
    const hint = extractHints(message, message, "Kotlin");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("println");
  });

  test("C/C++: GCC suggested alternative", () => {
    const msg = "error: 'prntf' was not declared in this scope; note: suggested alternative: 'printf'";
    const hint = extractHints(msg, msg, "C++");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("printf");
  });

  test("Ruby: Did you mean? format", () => {
    const msg = "undefined method 'lengthh' for String\nDid you mean? length";
    const hint = extractHints(msg, msg, "Ruby");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("length");
  });

  test("Dart: Try correcting the name", () => {
    const msg = "The method 'prnt' isn't defined. Try correcting the name to 'print'";
    const hint = extractHints(msg, msg, "Dart");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("print");
  });

  test("Elixir: did you mean format", () => {
    const msg = "undefined function prnt/1\ndid you mean:\n  * print/1";
    const hint = extractHints(msg, msg, "Elixir");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("print");
  });

  test("returns null when no hint present", () => {
    const hint = extractHints("syntax error", "syntax error", "TypeScript");
    expect(hint).toBeNull();
  });
});
