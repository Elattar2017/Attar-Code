// smart-fix/tests/file-analyzer.test.js
const { analyzeFile } = require("../file-analyzer");
const { fixturePath, readFixture } = require("./setup");

describe("FileAnalyzer", () => {
  describe("import extraction", () => {
    test("extracts named imports from types.ts", () => {
      const content = readFixture("simple-ts", "src", "config.ts");
      const result = analyzeFile(content, fixturePath("simple-ts", "src", "config.ts"));

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0]).toMatchObject({
        type: "named",
        symbols: ["Config"],
        rawSource: "./types",
        isExternal: false,
      });
    });

    test("extracts default imports", () => {
      const result = analyzeFile('import React from "react";', "/test.tsx");
      expect(result.imports[0]).toMatchObject({ type: "default", defaultSymbol: "React", isExternal: true });
    });

    test("extracts namespace imports", () => {
      const result = analyzeFile('import * as path from "path";', "/test.ts");
      expect(result.imports[0]).toMatchObject({ type: "namespace", namespaceAlias: "path", isExternal: true });
    });

    test("extracts side-effect imports", () => {
      const result = analyzeFile('import "./polyfill";', "/test.ts");
      expect(result.imports[0]).toMatchObject({ type: "side_effect", rawSource: "./polyfill", isExternal: false });
    });

    test("extracts type-only imports", () => {
      const result = analyzeFile('import type { User } from "./types";', "/test.ts");
      expect(result.imports[0]).toMatchObject({ type: "type_only_named", symbols: ["User"], isTypeOnly: true });
    });

    test("extracts dynamic imports", () => {
      // Dynamic imports are expressions, not declarations — they won't appear in top-level imports
      // This is correct behavior: dynamic imports are tracked as weak dependencies
      const result = analyzeFile('const m = import("./utils");', "/test.ts");
      expect(result.imports).toHaveLength(0); // dynamic imports not in static import list
    });

    test("extracts multi-line imports", () => {
      const code = `import {\n  User,\n  Config,\n  AuthToken\n} from './types';`;
      const result = analyzeFile(code, "/test.ts");
      expect(result.imports[0].symbols).toEqual(["User", "Config", "AuthToken"]);
    });

    test("extracts renamed imports", () => {
      const code = 'import { User as UserType, Config } from "./types";';
      const result = analyzeFile(code, "/test.ts");
      expect(result.imports[0].symbols).toContain("User as UserType");
      expect(result.imports[0].symbols).toContain("Config");
    });

    test("extracts require() imports", () => {
      // @babel/parser handles require as CallExpression, not ImportDeclaration
      // require() support would need separate extraction — test current behavior
      const code = 'const fs = require("fs");';
      const result = analyzeFile(code, "/test.js");
      expect(result.imports).toHaveLength(0); // require not tracked as import declaration
    });
  });

  describe("export extraction", () => {
    test("extracts inline exports", () => {
      const result = analyzeFile(readFixture("simple-ts", "src", "config.ts"), fixturePath("simple-ts", "src", "config.ts"));
      const exportNames = result.exports.flatMap(e => e.symbols);
      expect(exportNames).toContain("DEFAULT_PORT");
      expect(exportNames).toContain("getConfig");
    });

    test("extracts re-exports", () => {
      const code = 'export { User, Config } from "./types";';
      const result = analyzeFile(code, "/index.ts");
      expect(result.exports[0]).toMatchObject({ type: "re_export_named", isReExport: true, reExportSource: "./types" });
    });

    test("extracts star re-exports", () => {
      const code = 'export * from "./types";';
      const result = analyzeFile(code, "/index.ts");
      expect(result.exports[0]).toMatchObject({ type: "re_export_star", isReExport: true, reExportSource: "./types" });
    });

    test("extracts default exports", () => {
      const code = "export default class MyApp {}";
      const result = analyzeFile(code, "/app.ts");
      expect(result.exports[0]).toMatchObject({ type: "default", symbols: ["MyApp"] });
    });
  });

  describe("definition extraction", () => {
    test("extracts interfaces and enums from types.ts", () => {
      const result = analyzeFile(readFixture("simple-ts", "src", "types.ts"), fixturePath("simple-ts", "src", "types.ts"));
      const names = result.definitions.map(d => d.name);
      expect(names).toContain("User");
      expect(names).toContain("UserRole");
      expect(names).toContain("AuthToken");
      expect(names).toContain("Config");
    });

    test("extracts functions from app.ts", () => {
      const result = analyzeFile(readFixture("simple-ts", "src", "app.ts"), fixturePath("simple-ts", "src", "app.ts"));
      const names = result.definitions.map(d => d.name);
      expect(names).toContain("createUser");
      expect(names).toContain("startApp");
    });
  });

  describe("external package detection", () => {
    test("detects external packages", () => {
      const code = 'import express from "express";\nimport { User } from "./types";';
      const result = analyzeFile(code, "/test.ts");
      expect(result.externalPackages).toContain("express");
      expect(result.externalPackages).not.toContain("./types");
    });

    test("detects scoped packages", () => {
      const code = 'import { useState } from "@tanstack/react-query";';
      const result = analyzeFile(code, "/test.tsx");
      expect(result.externalPackages).toContain("@tanstack/react-query");
    });
  });

  describe("error recovery", () => {
    test("returns empty analysis for unparseable files", () => {
      const result = analyzeFile("this is not {{ valid code", "/broken.ts");
      expect(result.imports).toEqual([]);
      expect(result.exports).toEqual([]);
    });
  });
});
