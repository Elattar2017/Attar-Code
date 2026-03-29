const { fixturePath, readFixture } = require("./setup");
const fs = require("fs");

describe("Test infrastructure", () => {
  test("fixture files exist", () => {
    expect(fs.existsSync(fixturePath("simple-ts", "src", "types.ts"))).toBe(true);
    expect(fs.existsSync(fixturePath("simple-ts", "src", "config.ts"))).toBe(true);
    expect(fs.existsSync(fixturePath("simple-ts", "src", "app.ts"))).toBe(true);
  });

  test("readFixture reads file content", () => {
    const content = readFixture("simple-ts", "src", "types.ts");
    expect(content).toContain("export interface User");
    expect(content).toContain("UserRole");
  });

  test("@babel/parser is installed", () => {
    const { parse } = require("@babel/parser");
    expect(typeof parse).toBe("function");
  });
});
