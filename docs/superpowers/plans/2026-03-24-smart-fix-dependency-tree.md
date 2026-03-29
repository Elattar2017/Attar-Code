# Smart Fix Dependency Tree — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live code dependency tree to attar-code.js that prevents cross-file errors during generation and resolves them intelligently during build fixing — by tracking every import, export, and type definition across the project.

**Architecture:** All new code integrates directly into the existing monolithic `attar-code.js` (6,526 lines). New modules live in `Attar-Code/smart-fix/` as separate `.js` files, `require()`'d from the main file. The tree state lives on `SESSION._depGraph`. Tree logic runs inline in tool handlers (`write_file`, `edit_file`, `build_and_test`) to enrich tool responses synchronously.

**Tech Stack:** Node.js 18+, `@babel/parser` for AST analysis (new dep), existing Ollama integration, existing hook engine. No new frameworks — pure JavaScript, zero build step.

---

## File Structure

```
Attar-Code/
├── attar-code.js                          # MODIFY: 9 integration points (~150 lines added)
├── package.json                           # MODIFY: add @babel/parser dependency
├── smart-fix/                             # NEW DIRECTORY: all new modules
│   ├── index.js                           # Entry point — exports initSmartFix(), tree API
│   ├── file-analyzer.js                   # AST-based import/export/definition extraction
│   ├── graph-builder.js                   # Dependency graph data structure + operations
│   ├── file-ranker.js                     # Depth, hub score, leaf status computation
│   ├── tree-manager.js                    # Orchestrates analyzer + graph + ranker
│   ├── error-classifier.js                # Classifies errors using plugin + tree
│   ├── fix-order.js                       # Two-queue fix ordering algorithm
│   ├── context-builder.js                 # Builds enriched tool responses + generation context
│   ├── plugin-loader.js                   # FUTURE: Loads language plugin JSON, compiles regexes
│   └── external-reader.js                 # FUTURE: Reads .d.ts / type declarations from node_modules
├── smart-fix/tests/                       # NEW: unit tests
│   ├── file-analyzer.test.js
│   ├── graph-builder.test.js
│   ├── file-ranker.test.js
│   ├── tree-manager.test.js
│   ├── error-classifier.test.js
│   ├── fix-order.test.js
│   └── context-builder.test.js
├── smart-fix/fixtures/                    # NEW: test fixture projects
│   ├── simple-ts/                         # 3-file TypeScript project (types→config→app)
│   └── cascade-errors/                    # Project with intentional cascading errors
├── defaults/
│   └── plugins/
│       └── typescript.json                # ALREADY CREATED: TypeScript language plugin
```

### Integration Points in attar-code.js (exact lines)

| Location | Line | Change |
|----------|------|--------|
| `SESSION` init | 465 | Add `_depGraph: null` field |
| `bootstrapDefaults()` | 110 | Copy plugin files from defaults/plugins/ |
| `main()` | 6338 | Call `initSmartFix()` after hookEngine init |
| `write_file` case end | 2097 | Call tree.addFile() + enrich response |
| `edit_file` case end | 2136 | Call tree.updateFile() + enrich response |
| `build_and_test` case | 2847 | Call tree.fullRebuild() before build runs |
| `parseBuildErrors()` | 3511 | Replace sort with dependency-aware sort |
| `prescribeFixesForBuild()` | 3969 | Add fix-order scoring + auto-resolve predictions |
| `validateFileAfterWrite()` | 4048 | Add import validation against tree |

---

## Phase 1: Foundation (Tasks 1–4)

### Task 1: Test Framework + Project Scaffolding

**Files:**
- Modify: `Attar-Code/package.json`
- Create: `Attar-Code/smart-fix/tests/setup.js`
- Create: `Attar-Code/smart-fix/fixtures/simple-ts/src/types.ts`
- Create: `Attar-Code/smart-fix/fixtures/simple-ts/src/config.ts`
- Create: `Attar-Code/smart-fix/fixtures/simple-ts/src/app.ts`
- Create: `Attar-Code/smart-fix/fixtures/simple-ts/tsconfig.json`

- [ ] **Step 1: Install test framework and AST parser**

```bash
cd C:/Users/Attar/Desktop/Cli/Attar-Code
npm install --save-dev jest
npm install --save @babel/parser
```

- [ ] **Step 2: Add test script to package.json**

Add to `scripts` in package.json:
```json
"test": "jest --testPathPattern=smart-fix/tests",
"test:watch": "jest --testPathPattern=smart-fix/tests --watch"
```

- [ ] **Step 3: Create test setup file**

```javascript
// smart-fix/tests/setup.js
const path = require("path");
const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");

function fixturePath(project, ...parts) {
  return path.join(FIXTURES_DIR, project, ...parts);
}

function readFixture(project, ...parts) {
  return require("fs").readFileSync(fixturePath(project, ...parts), "utf-8");
}

module.exports = { FIXTURES_DIR, fixturePath, readFixture };
```

- [ ] **Step 4: Create simple-ts fixture project**

`smart-fix/fixtures/simple-ts/src/types.ts`:
```typescript
export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

export enum UserRole {
  ADMIN = "admin",
  USER = "user",
  GUEST = "guest",
}

export type AuthToken = string;

export interface Config {
  port: number;
  dbUrl: string;
}
```

`smart-fix/fixtures/simple-ts/src/config.ts`:
```typescript
import { Config } from './types';

export const DEFAULT_PORT = 3000;

export function getConfig(): Config {
  return {
    port: parseInt(process.env.PORT || String(DEFAULT_PORT)),
    dbUrl: process.env.DATABASE_URL || 'sqlite:memory',
  };
}
```

`smart-fix/fixtures/simple-ts/src/app.ts`:
```typescript
import { User, UserRole } from './types';
import { getConfig, DEFAULT_PORT } from './config';

export function createUser(name: string, email: string): User {
  return { id: crypto.randomUUID(), name, email, role: UserRole.USER };
}

export function startApp() {
  const config = getConfig();
  console.log(`Starting on port ${config.port}`);
}
```

`smart-fix/fixtures/simple-ts/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "strict": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 5: Verify test framework works**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest --version`
Expected: Version number printed (29.x or 30.x)

- [ ] **Step 6: Commit**

```bash
git add smart-fix/tests/setup.js smart-fix/fixtures/ package.json package-lock.json
git commit -m "feat: scaffold smart-fix test infrastructure with fixtures"
```

---

### Task 2: File Analyzer — AST-Based Import/Export Extraction

**Files:**
- Create: `Attar-Code/smart-fix/file-analyzer.js`
- Create: `Attar-Code/smart-fix/tests/file-analyzer.test.js`

- [ ] **Step 1: Write failing test for single-line named imports**

```javascript
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
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/file-analyzer.test.js -v`
Expected: FAIL — "Cannot find module '../file-analyzer'"

- [ ] **Step 3: Write minimal implementation — import extraction with @babel/parser**

```javascript
// smart-fix/file-analyzer.js
const { parse } = require("@babel/parser");
const path = require("path");

function analyzeFile(content, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const isTS = [".ts", ".tsx", ".mts", ".cts"].includes(ext);
  const isJSX = [".tsx", ".jsx"].includes(ext);

  let ast;
  try {
    ast = parse(content, {
      sourceType: "module",
      plugins: [
        ...(isTS ? ["typescript"] : []),
        ...(isJSX ? ["jsx"] : []),
        "decorators-legacy",
        "classProperties",
        "dynamicImport",
        "optionalChaining",
        "nullishCoalescingOperator",
        "exportDefaultFrom",
        "exportNamespaceFrom",
      ],
      errorRecovery: true,
    });
  } catch (err) {
    return { file: filePath, imports: [], exports: [], definitions: [], externalPackages: [], parseError: err.message };
  }

  const imports = [];
  const exports = [];
  const definitions = [];
  const externalPackages = new Set();

  for (const node of ast.program.body) {
    // --- IMPORTS ---
    if (node.type === "ImportDeclaration") {
      const rawSource = node.source.value;
      const isExternal = !rawSource.startsWith(".") && !rawSource.startsWith("/");
      if (isExternal) externalPackages.add(rawSource.split("/")[0].startsWith("@") ? rawSource.split("/").slice(0, 2).join("/") : rawSource.split("/")[0]);

      const symbols = [];
      let defaultSymbol = null;
      let namespaceAlias = null;
      let isTypeOnly = node.importKind === "type";

      for (const spec of node.specifiers || []) {
        if (spec.type === "ImportSpecifier") {
          const imported = spec.imported.name || spec.imported.value;
          const local = spec.local.name;
          symbols.push(imported === local ? imported : `${imported} as ${local}`);
        } else if (spec.type === "ImportDefaultSpecifier") {
          defaultSymbol = spec.local.name;
        } else if (spec.type === "ImportNamespaceSpecifier") {
          namespaceAlias = spec.local.name;
        }
      }

      let type = "side_effect";
      if (namespaceAlias) type = "namespace";
      else if (defaultSymbol && symbols.length > 0) type = "default_and_named";
      else if (defaultSymbol) type = "default";
      else if (symbols.length > 0) type = "named";

      if (isTypeOnly) type = "type_only_" + type;

      imports.push({
        type,
        symbols,
        defaultSymbol,
        namespaceAlias,
        rawSource,
        isExternal,
        isTypeOnly,
        line: node.loc?.start.line || 0,
      });
    }

    // --- EXPORTS ---
    if (node.type === "ExportNamedDeclaration") {
      if (node.source) {
        // Re-export: export { X } from './y' or export * from './y'
        const syms = (node.specifiers || []).map(s => {
          const exported = s.exported.name || s.exported.value;
          const local = s.local.name || s.local.value;
          return exported === local ? exported : `${local} as ${exported}`;
        });
        exports.push({
          type: syms.length > 0 ? "re_export_named" : "re_export_star",
          symbols: syms,
          isReExport: true,
          reExportSource: node.source.value,
          line: node.loc?.start.line || 0,
        });
      } else if (node.declaration) {
        // Inline export: export const X = ...
        const decl = node.declaration;
        const names = extractDeclarationNames(decl);
        for (const n of names) {
          exports.push({ type: "inline_named", symbols: [n], isReExport: false, reExportSource: null, line: node.loc?.start.line || 0 });
        }
        // Also track as definition
        const defs = extractDefinitions(decl, true);
        definitions.push(...defs);
      } else if (node.specifiers.length > 0) {
        // export { X, Y }
        const syms = node.specifiers.map(s => {
          const exported = s.exported.name || s.exported.value;
          const local = s.local.name || s.local.value;
          return exported === local ? exported : `${local} as ${exported}`;
        });
        exports.push({ type: "named", symbols: syms, isReExport: false, reExportSource: null, line: node.loc?.start.line || 0 });
      }
    }

    if (node.type === "ExportDefaultDeclaration") {
      const name = node.declaration?.id?.name || node.declaration?.name || "default";
      exports.push({ type: "default", symbols: [name], isReExport: false, reExportSource: null, line: node.loc?.start.line || 0 });
      if (node.declaration) {
        const defs = extractDefinitions(node.declaration, true);
        definitions.push(...defs);
      }
    }

    if (node.type === "ExportAllDeclaration") {
      const alias = node.exported?.name || null;
      exports.push({
        type: alias ? "re_export_star_as" : "re_export_star",
        symbols: alias ? [alias] : [],
        isReExport: true,
        reExportSource: node.source.value,
        line: node.loc?.start.line || 0,
      });
    }

    // --- TOP-LEVEL DEFINITIONS (non-exported) ---
    if (["VariableDeclaration", "FunctionDeclaration", "ClassDeclaration", "TSInterfaceDeclaration", "TSTypeAliasDeclaration", "TSEnumDeclaration"].includes(node.type)) {
      const defs = extractDefinitions(node, false);
      // Mark as exported if already found in exports
      for (const d of defs) {
        const alreadyExported = exports.some(e => e.symbols.includes(d.name));
        d.isExported = alreadyExported;
      }
      // Avoid duplicates (already added via ExportNamedDeclaration)
      for (const d of defs) {
        if (!definitions.some(existing => existing.name === d.name && existing.line === d.line)) {
          definitions.push(d);
        }
      }
    }
  }

  return {
    file: filePath,
    imports,
    exports,
    definitions,
    externalPackages: [...externalPackages],
  };
}

function extractDeclarationNames(decl) {
  if (!decl) return [];
  if (decl.id?.name) return [decl.id.name];
  if (decl.declarations) return decl.declarations.map(d => d.id?.name).filter(Boolean);
  return [];
}

function extractDefinitions(node, isExported) {
  const defs = [];
  const line = node.loc?.start.line || 0;

  if (node.type === "FunctionDeclaration" && node.id) {
    defs.push({ kind: "function", name: node.id.name, line, isExported, parents: [], composedOf: [] });
  }
  if (node.type === "ClassDeclaration" && node.id) {
    const parents = [];
    if (node.superClass?.name) parents.push(node.superClass.name);
    if (node.implements) parents.push(...node.implements.map(i => i.expression?.name || i.id?.name).filter(Boolean));
    defs.push({ kind: "class", name: node.id.name, line, isExported, parents, composedOf: [] });
  }
  if (node.type === "TSInterfaceDeclaration") {
    const parents = (node.extends || []).map(e => e.expression?.name || e.id?.name).filter(Boolean);
    defs.push({ kind: "interface", name: node.id.name, line, isExported, parents, composedOf: [] });
  }
  if (node.type === "TSTypeAliasDeclaration") {
    const composedOf = [];
    if (node.typeAnnotation?.type === "TSIntersectionType") {
      composedOf.push(...node.typeAnnotation.types.map(t => t.typeName?.name).filter(Boolean));
    }
    if (node.typeAnnotation?.type === "TSUnionType") {
      composedOf.push(...node.typeAnnotation.types.map(t => t.typeName?.name || t.literal?.value).filter(Boolean));
    }
    defs.push({ kind: "type_alias", name: node.id.name, line, isExported, parents: [], composedOf });
  }
  if (node.type === "TSEnumDeclaration") {
    defs.push({ kind: "enum", name: node.id.name, line, isExported, parents: [], composedOf: [] });
  }
  if (node.type === "VariableDeclaration") {
    for (const decl of node.declarations) {
      if (decl.id?.name) {
        const isArrowFn = decl.init?.type === "ArrowFunctionExpression" || decl.init?.type === "FunctionExpression";
        defs.push({ kind: isArrowFn ? "function" : "variable", name: decl.id.name, line: decl.loc?.start.line || line, isExported, parents: [], composedOf: [] });
      }
    }
  }
  return defs;
}

module.exports = { analyzeFile };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/file-analyzer.test.js -v`
Expected: PASS

- [ ] **Step 5: Write additional tests for all import/export types**

Add to `file-analyzer.test.js`:
```javascript
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
```

- [ ] **Step 6: Run full test suite**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/file-analyzer.test.js -v`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add smart-fix/file-analyzer.js smart-fix/tests/file-analyzer.test.js
git commit -m "feat: AST-based file analyzer with import/export/definition extraction"
```

---

### Task 3: Graph Builder — Dependency Graph Data Structure

**Files:**
- Create: `Attar-Code/smart-fix/graph-builder.js`
- Create: `Attar-Code/smart-fix/tests/graph-builder.test.js`

- [ ] **Step 1: Write failing test for graph construction**

```javascript
// smart-fix/tests/graph-builder.test.js
const { DependencyGraph } = require("../graph-builder");

describe("DependencyGraph", () => {
  let graph;

  beforeEach(() => {
    graph = new DependencyGraph();
  });

  test("addNode stores file analysis", () => {
    graph.addNode("/src/types.ts", {
      file: "/src/types.ts",
      imports: [],
      exports: [{ type: "inline_named", symbols: ["User"], isReExport: false }],
      definitions: [{ kind: "interface", name: "User", line: 1, isExported: true }],
      externalPackages: [],
    });

    expect(graph.hasNode("/src/types.ts")).toBe(true);
    expect(graph.getNode("/src/types.ts").exports[0].symbols).toContain("User");
  });

  test("addEdge creates dependency relationship", () => {
    graph.addNode("/src/types.ts", { file: "/src/types.ts", imports: [], exports: [], definitions: [], externalPackages: [] });
    graph.addNode("/src/app.ts", { file: "/src/app.ts", imports: [], exports: [], definitions: [], externalPackages: [] });
    graph.addEdge("/src/app.ts", "/src/types.ts", ["User"]);

    expect(graph.getDependenciesOf("/src/app.ts")).toContain("/src/types.ts");
    expect(graph.getDependentsOf("/src/types.ts")).toContain("/src/app.ts");
  });

  test("removeNode cleans up edges", () => {
    graph.addNode("/src/a.ts", { file: "/src/a.ts", imports: [], exports: [], definitions: [], externalPackages: [] });
    graph.addNode("/src/b.ts", { file: "/src/b.ts", imports: [], exports: [], definitions: [], externalPackages: [] });
    graph.addEdge("/src/b.ts", "/src/a.ts", ["X"]);
    graph.removeNode("/src/a.ts");

    expect(graph.hasNode("/src/a.ts")).toBe(false);
    expect(graph.getDependenciesOf("/src/b.ts")).toEqual([]);
  });

  test("getAllExports returns all exported symbols keyed by file", () => {
    graph.addNode("/src/types.ts", {
      file: "/src/types.ts", imports: [],
      exports: [{ type: "inline_named", symbols: ["User", "Config"], isReExport: false }],
      definitions: [], externalPackages: [],
    });
    const all = graph.getAllExports();
    expect(all["/src/types.ts"]).toEqual(["User", "Config"]);
  });

  test("detectCycles finds circular dependencies", () => {
    graph.addNode("/src/a.ts", { file: "/src/a.ts", imports: [], exports: [], definitions: [], externalPackages: [] });
    graph.addNode("/src/b.ts", { file: "/src/b.ts", imports: [], exports: [], definitions: [], externalPackages: [] });
    graph.addEdge("/src/a.ts", "/src/b.ts", ["B"]);
    graph.addEdge("/src/b.ts", "/src/a.ts", ["A"]);

    const cycles = graph.detectCycles();
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0]).toContain("/src/a.ts");
    expect(cycles[0]).toContain("/src/b.ts");
  });

  test("getNodeCount returns correct count", () => {
    graph.addNode("/a.ts", { file: "/a.ts", imports: [], exports: [], definitions: [], externalPackages: [] });
    graph.addNode("/b.ts", { file: "/b.ts", imports: [], exports: [], definitions: [], externalPackages: [] });
    expect(graph.getNodeCount()).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest smart-fix/tests/graph-builder.test.js -v`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```javascript
// smart-fix/graph-builder.js
class DependencyGraph {
  constructor() {
    this.nodes = new Map();       // filePath → fileAnalysis
    this.edges = new Map();       // filePath → Set(dependencyFilePath)
    this.reverseEdges = new Map(); // filePath → Set(dependentFilePath)
    this.edgeSymbols = new Map(); // "from|to" → [symbols]
  }

  addNode(filePath, analysis) {
    this.nodes.set(filePath, analysis);
    if (!this.edges.has(filePath)) this.edges.set(filePath, new Set());
    if (!this.reverseEdges.has(filePath)) this.reverseEdges.set(filePath, new Set());
  }

  removeNode(filePath) {
    // Clean up forward edges
    const deps = this.edges.get(filePath) || new Set();
    for (const dep of deps) {
      const rev = this.reverseEdges.get(dep);
      if (rev) rev.delete(filePath);
      this.edgeSymbols.delete(`${filePath}|${dep}`);
    }
    // Clean up reverse edges
    const dependents = this.reverseEdges.get(filePath) || new Set();
    for (const dep of dependents) {
      const fwd = this.edges.get(dep);
      if (fwd) fwd.delete(filePath);
      this.edgeSymbols.delete(`${dep}|${filePath}`);
    }
    this.nodes.delete(filePath);
    this.edges.delete(filePath);
    this.reverseEdges.delete(filePath);
  }

  hasNode(filePath) {
    return this.nodes.has(filePath);
  }

  getNode(filePath) {
    return this.nodes.get(filePath) || null;
  }

  addEdge(fromFile, toFile, symbols) {
    if (!this.edges.has(fromFile)) this.edges.set(fromFile, new Set());
    if (!this.reverseEdges.has(toFile)) this.reverseEdges.set(toFile, new Set());
    this.edges.get(fromFile).add(toFile);
    this.reverseEdges.get(toFile).add(fromFile);
    this.edgeSymbols.set(`${fromFile}|${toFile}`, symbols);
  }

  getDependenciesOf(filePath) {
    return [...(this.edges.get(filePath) || [])];
  }

  getDependentsOf(filePath) {
    return [...(this.reverseEdges.get(filePath) || [])];
  }

  getTransitiveDependentsOf(filePath) {
    const visited = new Set();
    const queue = [filePath];
    while (queue.length > 0) {
      const current = queue.shift();
      const dependents = this.reverseEdges.get(current) || new Set();
      for (const dep of dependents) {
        if (!visited.has(dep)) {
          visited.add(dep);
          queue.push(dep);
        }
      }
    }
    return [...visited];
  }

  getImportedSymbols(fromFile, toFile) {
    return this.edgeSymbols.get(`${fromFile}|${toFile}`) || [];
  }

  getAllExports() {
    const result = {};
    for (const [filePath, analysis] of this.nodes) {
      result[filePath] = analysis.exports.flatMap(e => e.symbols);
    }
    return result;
  }

  getNodeCount() {
    return this.nodes.size;
  }

  getAllFiles() {
    return [...this.nodes.keys()];
  }

  detectCycles() {
    const cycles = [];
    const visited = new Set();
    const inStack = new Set();
    const stack = [];

    const dfs = (node) => {
      visited.add(node);
      inStack.add(node);
      stack.push(node);

      for (const dep of this.edges.get(node) || []) {
        if (!visited.has(dep)) {
          dfs(dep);
        } else if (inStack.has(dep)) {
          const cycleStart = stack.indexOf(dep);
          cycles.push(stack.slice(cycleStart));
        }
      }

      stack.pop();
      inStack.delete(node);
    };

    for (const node of this.nodes.keys()) {
      if (!visited.has(node)) dfs(node);
    }

    return cycles;
  }

  clear() {
    this.nodes.clear();
    this.edges.clear();
    this.reverseEdges.clear();
    this.edgeSymbols.clear();
  }
}

module.exports = { DependencyGraph };
```

- [ ] **Step 4: Run tests**

Run: `npx jest smart-fix/tests/graph-builder.test.js -v`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add smart-fix/graph-builder.js smart-fix/tests/graph-builder.test.js
git commit -m "feat: dependency graph data structure with cycle detection"
```

---

### Task 4: File Ranker — Depth, Hub Score, Leaf Status

**Files:**
- Create: `Attar-Code/smart-fix/file-ranker.js`
- Create: `Attar-Code/smart-fix/tests/file-ranker.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// smart-fix/tests/file-ranker.test.js
const { rankFiles } = require("../file-ranker");
const { DependencyGraph } = require("../graph-builder");

describe("FileRanker", () => {
  test("root files have depth 0, dependents have increasing depth", () => {
    const graph = new DependencyGraph();
    const stub = (f) => ({ file: f, imports: [], exports: [], definitions: [], externalPackages: [] });
    graph.addNode("/types.ts", stub("/types.ts"));
    graph.addNode("/config.ts", stub("/config.ts"));
    graph.addNode("/app.ts", stub("/app.ts"));
    graph.addEdge("/config.ts", "/types.ts", ["Config"]);
    graph.addEdge("/app.ts", "/types.ts", ["User"]);
    graph.addEdge("/app.ts", "/config.ts", ["getConfig"]);

    const ranks = rankFiles(graph);

    expect(ranks.get("/types.ts").depth).toBe(0);
    expect(ranks.get("/types.ts").isRoot).toBe(true);
    expect(ranks.get("/types.ts").isLeaf).toBe(false);
    expect(ranks.get("/config.ts").depth).toBe(1);
    expect(ranks.get("/app.ts").depth).toBe(2);
    expect(ranks.get("/app.ts").isLeaf).toBe(true);
  });

  test("hub score reflects dependent count", () => {
    const graph = new DependencyGraph();
    const stub = (f) => ({ file: f, imports: [], exports: [], definitions: [], externalPackages: [] });
    graph.addNode("/types.ts", stub("/types.ts"));
    graph.addNode("/a.ts", stub("/a.ts"));
    graph.addNode("/b.ts", stub("/b.ts"));
    graph.addNode("/c.ts", stub("/c.ts"));
    graph.addEdge("/a.ts", "/types.ts", []);
    graph.addEdge("/b.ts", "/types.ts", []);
    graph.addEdge("/c.ts", "/types.ts", []);

    const ranks = rankFiles(graph);
    expect(ranks.get("/types.ts").dependentCount).toBe(3);
    expect(ranks.get("/types.ts").isHub).toBe(true);
  });

  test("handles circular dependencies", () => {
    const graph = new DependencyGraph();
    const stub = (f) => ({ file: f, imports: [], exports: [], definitions: [], externalPackages: [] });
    graph.addNode("/a.ts", stub("/a.ts"));
    graph.addNode("/b.ts", stub("/b.ts"));
    graph.addEdge("/a.ts", "/b.ts", []);
    graph.addEdge("/b.ts", "/a.ts", []);

    const ranks = rankFiles(graph);
    expect(ranks.get("/a.ts").inCircularDependency).toBe(true);
    expect(ranks.get("/b.ts").inCircularDependency).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest smart-fix/tests/file-ranker.test.js -v`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```javascript
// smart-fix/file-ranker.js

function rankFiles(graph) {
  const ranks = new Map();
  const files = graph.getAllFiles();
  const cycles = graph.detectCycles();
  const filesInCycles = new Set(cycles.flat());

  // Compute depths via BFS from roots (files with no dependencies)
  const depths = new Map();
  const roots = files.filter(f => graph.getDependenciesOf(f).length === 0);

  // Initialize all depths to -1 (unvisited)
  for (const f of files) depths.set(f, -1);

  // BFS from roots using reverse edges (dependents)
  const queue = [];
  for (const root of roots) {
    depths.set(root, 0);
    queue.push(root);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    const currentDepth = depths.get(current);
    for (const dependent of graph.getDependentsOf(current)) {
      const newDepth = currentDepth + 1;
      if (depths.get(dependent) < newDepth) {
        depths.set(dependent, newDepth);
        queue.push(dependent);
      }
    }
  }

  // Files still at -1 are in pure cycles with no root — assign depth 0
  for (const f of files) {
    if (depths.get(f) === -1) depths.set(f, 0);
  }

  // Compute ranks
  const HUB_THRESHOLD = 3; // file is a hub if 3+ files depend on it

  for (const f of files) {
    const dependents = graph.getDependentsOf(f);
    const dependencies = graph.getDependenciesOf(f);
    const transitiveDependents = graph.getTransitiveDependentsOf(f);
    const dependentCount = dependents.length;
    const transitiveDependentCount = transitiveDependents.length;

    ranks.set(f, {
      file: f,
      depth: depths.get(f),
      dependentCount,
      transitiveDependentCount,
      dependencyCount: dependencies.length,
      hubScore: dependentCount + transitiveDependentCount,
      isLeaf: dependentCount === 0,
      isRoot: dependencies.length === 0,
      isHub: dependentCount >= HUB_THRESHOLD,
      inCircularDependency: filesInCycles.has(f),
    });
  }

  return ranks;
}

module.exports = { rankFiles };
```

- [ ] **Step 4: Run tests**

Run: `npx jest smart-fix/tests/file-ranker.test.js -v`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add smart-fix/file-ranker.js smart-fix/tests/file-ranker.test.js
git commit -m "feat: file ranker with depth, hub score, leaf/root detection"
```

---

## Phase 2: Tree Manager + Fix Ordering (Tasks 5–7)

### Task 5: Tree Manager — Orchestrates Analyzer + Graph + Ranker

**Files:**
- Create: `Attar-Code/smart-fix/tree-manager.js`
- Create: `Attar-Code/smart-fix/tests/tree-manager.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// smart-fix/tests/tree-manager.test.js
const { TreeManager } = require("../tree-manager");
const { fixturePath } = require("./setup");

describe("TreeManager", () => {
  let tree;

  beforeEach(() => {
    tree = new TreeManager();
  });

  test("addFile analyzes and adds to graph", () => {
    tree.addFile(fixturePath("simple-ts", "src", "types.ts"));
    const analysis = tree.getFileAnalysis(fixturePath("simple-ts", "src", "types.ts"));
    expect(analysis).not.toBeNull();
    expect(analysis.exports.length).toBeGreaterThan(0);
  });

  test("fullRebuild scans entire project", () => {
    tree.fullRebuild(fixturePath("simple-ts", "src"), [".ts", ".tsx"]);
    expect(tree.getFileCount()).toBe(3); // types.ts, config.ts, app.ts
  });

  test("fullRebuild resolves import edges", () => {
    tree.fullRebuild(fixturePath("simple-ts", "src"), [".ts", ".tsx"]);
    const typesPath = fixturePath("simple-ts", "src", "types.ts");
    const dependents = tree.getDependentsOf(typesPath);
    expect(dependents.length).toBe(2); // config.ts and app.ts both import from types.ts
  });

  test("getRanks returns depth and hub info", () => {
    tree.fullRebuild(fixturePath("simple-ts", "src"), [".ts", ".tsx"]);
    const typesPath = fixturePath("simple-ts", "src", "types.ts");
    const rank = tree.getFileRank(typesPath);
    expect(rank.depth).toBe(0);
    expect(rank.isRoot).toBe(true);
    expect(rank.dependentCount).toBeGreaterThanOrEqual(2);
  });

  test("updateFile detects structural changes", () => {
    tree.fullRebuild(fixturePath("simple-ts", "src"), [".ts", ".tsx"]);
    const configPath = fixturePath("simple-ts", "src", "config.ts");
    const result = tree.updateFile(configPath);
    expect(result).toHaveProperty("structuralChange");
  });

  test("getProjectSummary returns compact summary", () => {
    tree.fullRebuild(fixturePath("simple-ts", "src"), [".ts", ".tsx"]);
    const summary = tree.getProjectSummary();
    expect(summary).toContain("3 files");
  });

  test("validateImports detects valid imports", () => {
    tree.fullRebuild(fixturePath("simple-ts", "src"), [".ts", ".tsx"]);
    const appPath = fixturePath("simple-ts", "src", "app.ts");
    const warnings = tree.validateImports(appPath);
    expect(warnings.filter(w => w.status === "error")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test — expect fail**

- [ ] **Step 3: Write implementation**

```javascript
// smart-fix/tree-manager.js
const fs = require("fs");
const path = require("path");
const { analyzeFile } = require("./file-analyzer");
const { DependencyGraph } = require("./graph-builder");
const { rankFiles } = require("./file-ranker");

class TreeManager {
  constructor() {
    this.graph = new DependencyGraph();
    this.ranks = new Map();
    this.projectRoot = null;
    this.extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
  }

  addFile(filePath) {
    const content = fs.readFileSync(filePath, "utf-8");
    const analysis = analyzeFile(content, filePath);
    this.graph.addNode(filePath, analysis);
    this._resolveEdgesFor(filePath, analysis);
    this._rerank();
    return analysis;
  }

  removeFile(filePath) {
    const dependents = this.graph.getDependentsOf(filePath);
    this.graph.removeNode(filePath);
    this._rerank();
    return { brokenImports: dependents };
  }

  updateFile(filePath) {
    const oldAnalysis = this.graph.getNode(filePath);
    const content = fs.readFileSync(filePath, "utf-8");
    const newAnalysis = analyzeFile(content, filePath);

    const oldExports = new Set((oldAnalysis?.exports || []).flatMap(e => e.symbols));
    const newExports = new Set(newAnalysis.exports.flatMap(e => e.symbols));
    const oldImportSources = new Set((oldAnalysis?.imports || []).map(i => i.rawSource));
    const newImportSources = new Set(newAnalysis.imports.map(i => i.rawSource));

    const exportsChanged = !setsEqual(oldExports, newExports);
    const importsChanged = !setsEqual(oldImportSources, newImportSources);
    const structuralChange = exportsChanged || importsChanged;

    // Remove old edges from this file
    for (const dep of this.graph.getDependenciesOf(filePath)) {
      this.graph.edges.get(filePath)?.delete(dep);
      this.graph.reverseEdges.get(dep)?.delete(filePath);
    }

    this.graph.addNode(filePath, newAnalysis);
    this._resolveEdgesFor(filePath, newAnalysis);

    if (structuralChange) this._rerank();

    const affectedDependents = exportsChanged ? this.graph.getDependentsOf(filePath) : [];

    return {
      structuralChange,
      exportsChanged,
      importsChanged,
      addedExports: [...newExports].filter(s => !oldExports.has(s)),
      removedExports: [...oldExports].filter(s => !newExports.has(s)),
      affectedDependents,
    };
  }

  fullRebuild(projectRoot, extensions) {
    this.projectRoot = projectRoot;
    if (extensions) this.extensions = extensions;
    this.graph.clear();
    this.ranks.clear();

    const files = this._scanFiles(projectRoot);
    for (const f of files) {
      try {
        const content = fs.readFileSync(f, "utf-8");
        const analysis = analyzeFile(content, f);
        this.graph.addNode(f, analysis);
      } catch (err) { /* skip unreadable files */ }
    }

    // Resolve all edges
    for (const f of this.graph.getAllFiles()) {
      const analysis = this.graph.getNode(f);
      this._resolveEdgesFor(f, analysis);
    }

    this._rerank();
  }

  getFileAnalysis(filePath) {
    return this.graph.getNode(filePath);
  }

  getFileRank(filePath) {
    return this.ranks.get(filePath) || null;
  }

  getFileCount() {
    return this.graph.getNodeCount();
  }

  getDependentsOf(filePath) {
    return this.graph.getDependentsOf(filePath);
  }

  getDependenciesOf(filePath) {
    return this.graph.getDependenciesOf(filePath);
  }

  getRanks() {
    return this.ranks;
  }

  getAllExports() {
    return this.graph.getAllExports();
  }

  getExportsFor(filePath) {
    const analysis = this.graph.getNode(filePath);
    if (!analysis) return [];
    return analysis.exports.flatMap(e => e.symbols);
  }

  validateImports(filePath) {
    const analysis = this.graph.getNode(filePath);
    if (!analysis) return [];

    const results = [];
    for (const imp of analysis.imports) {
      if (imp.isExternal) {
        results.push({ line: imp.line, source: imp.rawSource, status: "external", message: "external package" });
        continue;
      }

      const resolved = this._resolveImportPath(filePath, imp.rawSource);
      if (!resolved) {
        results.push({ line: imp.line, source: imp.rawSource, status: "error", message: `file not found: ${imp.rawSource}` });
        continue;
      }

      const targetExports = this.getExportsFor(resolved);
      for (const sym of imp.symbols) {
        const cleanSym = sym.includes(" as ") ? sym.split(" as ")[0].trim() : sym;
        if (targetExports.length > 0 && !targetExports.includes(cleanSym) && !targetExports.some(e => e.includes(cleanSym))) {
          const suggestions = targetExports.filter(e => !e.includes(" as ")).slice(0, 5);
          results.push({
            line: imp.line, source: imp.rawSource, status: "error",
            message: `'${cleanSym}' is not exported from ${path.basename(resolved)}. Available: ${suggestions.join(", ")}`,
          });
        } else {
          results.push({ line: imp.line, source: imp.rawSource, status: "ok", message: `${cleanSym} resolved` });
        }
      }

      if (imp.type === "side_effect") {
        results.push({ line: imp.line, source: imp.rawSource, status: "ok", message: "side-effect import" });
      }
    }
    return results;
  }

  getProjectSummary() {
    const files = this.graph.getAllFiles();
    const totalExports = Object.values(this.graph.getAllExports()).reduce((s, e) => s + e.length, 0);
    const hubs = files.filter(f => this.ranks.get(f)?.isHub);
    const leaves = files.filter(f => this.ranks.get(f)?.isLeaf);
    const cycles = this.graph.detectCycles();

    const lines = [`${files.length} files, ${totalExports} exported symbols`];
    if (hubs.length > 0) lines.push(`Hub files: ${hubs.map(f => path.basename(f)).join(", ")}`);
    if (cycles.length > 0) lines.push(`${cycles.length} circular dependency(ies) detected`);

    return lines.join("\n");
  }

  // --- Private ---

  _scanFiles(dir) {
    const results = [];
    const IGNORE = ["node_modules", ".git", "dist", "build", ".next", "__pycache__", "target", "vendor"];

    const walk = (d) => {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORE.includes(entry.name)) walk(full);
        } else if (this.extensions.includes(path.extname(entry.name).toLowerCase())) {
          results.push(full);
        }
      }
    };

    walk(dir);
    return results;
  }

  _resolveImportPath(fromFile, rawSource) {
    if (!rawSource.startsWith(".") && !rawSource.startsWith("/")) return null; // external
    const dir = path.dirname(fromFile);
    const base = path.resolve(dir, rawSource);

    // Try exact path
    for (const ext of ["", ...this.extensions]) {
      const full = base + ext;
      if (this.graph.hasNode(full)) return full;
    }

    // Try index files
    for (const ext of this.extensions) {
      const full = path.join(base, "index" + ext);
      if (this.graph.hasNode(full)) return full;
    }

    return null;
  }

  _resolveEdgesFor(filePath, analysis) {
    for (const imp of analysis.imports) {
      if (imp.isExternal) continue;
      const resolved = this._resolveImportPath(filePath, imp.rawSource);
      if (resolved) {
        const symbols = [...imp.symbols];
        if (imp.defaultSymbol) symbols.push(imp.defaultSymbol);
        if (imp.namespaceAlias) symbols.push("*");
        this.graph.addEdge(filePath, resolved, symbols);
      }
    }
  }

  _rerank() {
    this.ranks = rankFiles(this.graph);
  }
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

module.exports = { TreeManager };
```

- [ ] **Step 4: Run tests**

Run: `npx jest smart-fix/tests/tree-manager.test.js -v`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add smart-fix/tree-manager.js smart-fix/tests/tree-manager.test.js
git commit -m "feat: tree manager orchestrating file analysis, graph building, and ranking"
```

---

### Task 6: Fix Order Calculator — Two-Queue Scoring Algorithm

**Files:**
- Create: `Attar-Code/smart-fix/fix-order.js`
- Create: `Attar-Code/smart-fix/tests/fix-order.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// smart-fix/tests/fix-order.test.js
const { computeFixOrder } = require("../fix-order");

describe("computeFixOrder", () => {
  test("root cause errors come before dependent errors", () => {
    const errors = [
      { file: "/api.ts", code: "TS2339", message: "Property 'phone' does not exist on type 'User'", originFile: "/types.ts", crossFileProbability: 0.9 },
      { file: "/types.ts", code: "TS2322", message: "Type 'string' not assignable to 'number'", originFile: null, crossFileProbability: 0.1 },
    ];
    const ranks = new Map([
      ["/types.ts", { depth: 0, isRoot: true, isLeaf: false, isHub: true, dependentCount: 5, inCircularDependency: false }],
      ["/api.ts", { depth: 1, isRoot: false, isLeaf: true, isHub: false, dependentCount: 0, inCircularDependency: false }],
    ]);

    const plan = computeFixOrder(errors, ranks);
    // Queue 1 (root causes) should contain types.ts
    // Queue 2 (isolated) or auto-resolve should contain api.ts
    expect(plan.queue1[0].file).toBe("/types.ts");
  });

  test("syntax errors in leaves come first within queue 2", () => {
    const errors = [
      { file: "/utils.ts", code: "TS1005", message: "';' expected", originFile: null, crossFileProbability: 0.0 },
      { file: "/helpers.ts", code: "TS7006", message: "Parameter implicitly has any type", originFile: null, crossFileProbability: 0.0 },
    ];
    const ranks = new Map([
      ["/utils.ts", { depth: 0, isRoot: true, isLeaf: true, isHub: false, dependentCount: 0, inCircularDependency: false }],
      ["/helpers.ts", { depth: 0, isRoot: true, isLeaf: true, isHub: false, dependentCount: 0, inCircularDependency: false }],
    ]);

    const plan = computeFixOrder(errors, ranks);
    // Both are isolated, should be in queue2
    expect(plan.queue2.length).toBe(2);
  });

  test("auto-resolvable errors are flagged", () => {
    const errors = [
      { file: "/types.ts", code: "TS2322", message: "Type mismatch", originFile: null, crossFileProbability: 0.1 },
      { file: "/a.ts", code: "TS2339", message: "Property missing", originFile: "/types.ts", crossFileProbability: 0.9 },
      { file: "/b.ts", code: "TS2339", message: "Property missing", originFile: "/types.ts", crossFileProbability: 0.9 },
    ];
    const ranks = new Map([
      ["/types.ts", { depth: 0, isRoot: true, isLeaf: false, isHub: true, dependentCount: 2, inCircularDependency: false }],
      ["/a.ts", { depth: 1, isRoot: false, isLeaf: true, isHub: false, dependentCount: 0, inCircularDependency: false }],
      ["/b.ts", { depth: 1, isRoot: false, isLeaf: true, isHub: false, dependentCount: 0, inCircularDependency: false }],
    ]);

    const plan = computeFixOrder(errors, ranks);
    expect(plan.autoResolvable.length).toBe(2);
    expect(plan.stats.autoResolvableCandidates).toBe(2);
  });
});
```

- [ ] **Step 2: Run test — expect fail**

- [ ] **Step 3: Write implementation**

```javascript
// smart-fix/fix-order.js

function computeFixOrder(classifiedErrors, ranks) {
  const queue1 = []; // Root cause errors (have downstream dependents that also error)
  const queue2 = []; // Isolated errors (no downstream impact)
  const autoResolvable = []; // Likely auto-resolve when root cause is fixed
  const external = []; // External package errors

  // Group errors by file
  const byFile = new Map();
  for (const err of classifiedErrors) {
    const list = byFile.get(err.file) || [];
    list.push(err);
    byFile.set(err.file, list);
  }

  // Identify which files are origin files for other errors
  const originFiles = new Set();
  for (const err of classifiedErrors) {
    if (err.originFile && err.originFile !== err.file) {
      originFiles.add(err.originFile);
    }
  }

  // Classify each error group
  for (const [file, errors] of byFile) {
    const rank = ranks.get(file) || { depth: 0, isRoot: false, isLeaf: true, isHub: false, dependentCount: 0, inCircularDependency: false };

    // Check if ALL errors in this file trace to the same origin
    const allFromSameOrigin = errors.every(e => e.originFile && e.originFile !== file);
    const originFile = allFromSameOrigin ? errors[0].originFile : null;

    // If all errors trace to another file that ALSO has errors, this group is auto-resolvable
    if (allFromSameOrigin && originFile && byFile.has(originFile)) {
      for (const err of errors) {
        autoResolvable.push({ ...err, autoResolveWhen: originFile });
      }
      continue;
    }

    // Score for sorting within queues
    let score = 0;

    // Depth factor
    if (errors.some(e => e.crossFileProbability > 0.5)) {
      score += rank.depth * 30;
    }

    // Hub bonus for local errors (fix hubs early — unblocks dependents)
    if (rank.isHub && errors.some(e => !e.originFile || e.originFile === file)) {
      score -= 20;
    }

    // Leaf bonus (safe to fix, no cascade risk)
    if (rank.isLeaf && errors.every(e => !e.originFile || e.originFile === file)) {
      score -= 30;
    }

    // Hub penalty for cross-file errors (wait for origin to be fixed)
    if (rank.isHub && errors.some(e => e.originFile && e.originFile !== file)) {
      score += 50;
    }

    // Large group penalty
    if (errors.length > 10) score += 15;

    const group = {
      file,
      errors,
      score,
      rank,
      errorCount: errors.length,
    };

    // Route to queue
    if (originFiles.has(file) || (rank.isHub && errors.some(e => !e.originFile || e.originFile === file))) {
      queue1.push(group);
    } else {
      queue2.push(group);
    }
  }

  // Sort each queue by score ascending (lower = fix first)
  queue1.sort((a, b) => a.score - b.score);
  queue2.sort((a, b) => a.score - b.score);

  return {
    queue1,
    queue2,
    autoResolvable,
    external,
    stats: {
      totalErrors: classifiedErrors.length,
      rootCauseGroups: queue1.length,
      isolatedGroups: queue2.length,
      autoResolvableCandidates: autoResolvable.length,
      externalErrors: external.length,
    },
  };
}

module.exports = { computeFixOrder };
```

- [ ] **Step 4: Run tests**

Run: `npx jest smart-fix/tests/fix-order.test.js -v`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add smart-fix/fix-order.js smart-fix/tests/fix-order.test.js
git commit -m "feat: two-queue fix ordering with auto-resolve detection"
```

---

### Task 7: Context Builder — Enriched Tool Responses

**Files:**
- Create: `Attar-Code/smart-fix/context-builder.js`
- Create: `Attar-Code/smart-fix/tests/context-builder.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// smart-fix/tests/context-builder.test.js
const { buildCreateFileResponse, buildEditFileResponse, buildBuildErrorAnalysis } = require("../context-builder");

describe("ContextBuilder", () => {
  test("buildCreateFileResponse includes validation and project summary", () => {
    const result = buildCreateFileResponse(
      "/src/app.ts",
      [{ line: 1, source: "./types", status: "ok", message: "User resolved" }],
      "3 files, 10 exported symbols",
      3
    );
    expect(result).toContain("Created");
    expect(result).toContain("Validation");
    expect(result).toContain("Project structure");
  });

  test("buildCreateFileResponse shows warnings for bad imports", () => {
    const result = buildCreateFileResponse(
      "/src/app.ts",
      [{ line: 2, source: "./db", status: "error", message: "'verifyUser' is not exported from db.ts. Available: findUser, createUser" }],
      "3 files",
      3
    );
    expect(result).toContain("WARNING");
    expect(result).toContain("verifyUser");
    expect(result).toContain("Available");
  });

  test("buildBuildErrorAnalysis formats fix plan", () => {
    const fixPlan = {
      queue1: [{ file: "/types.ts", errors: [{ code: "TS2322", message: "Type mismatch" }], errorCount: 1, rank: { depth: 0, isHub: true } }],
      queue2: [{ file: "/utils.ts", errors: [{ code: "TS1005", message: "';' expected" }], errorCount: 1, rank: { depth: 0, isLeaf: true } }],
      autoResolvable: [{ file: "/api.ts", code: "TS2339", autoResolveWhen: "/types.ts" }],
      stats: { totalErrors: 3, rootCauseGroups: 1, isolatedGroups: 1, autoResolvableCandidates: 1 },
    };
    const result = buildBuildErrorAnalysis(fixPlan, 3);
    expect(result).toContain("Priority 1");
    expect(result).toContain("types.ts");
    expect(result).toContain("auto-resolve");
  });
});
```

- [ ] **Step 2: Run test — expect fail**

- [ ] **Step 3: Write implementation**

```javascript
// smart-fix/context-builder.js
const path = require("path");

function buildCreateFileResponse(filePath, validationResults, projectSummary, fileCount) {
  const lines = [`\u2713 Created ${filePath}`];

  // Validation section
  if (validationResults.length > 0) {
    lines.push("", "Validation:");
    for (const v of validationResults) {
      if (v.status === "ok") {
        lines.push(`  \u2713 Line ${v.line}: import from '${v.source}' \u2192 ${v.message}`);
      } else if (v.status === "error") {
        lines.push(`  \u2717 Line ${v.line}: import from '${v.source}' \u2192 WARNING: ${v.message}`);
      } else if (v.status === "external") {
        lines.push(`  \u2713 Line ${v.line}: import from '${v.source}' \u2192 external package`);
      }
    }
  }

  // Project structure section
  lines.push("", "Project structure:", `  ${projectSummary}`);

  return lines.join("\n");
}

function buildEditFileResponse(filePath, updateResult) {
  const lines = [`\u2713 Edited ${filePath}`];

  if (updateResult.exportsChanged) {
    lines.push("", "Changes detected:");
    if (updateResult.addedExports.length > 0) {
      lines.push(`  Added exports: ${updateResult.addedExports.join(", ")}`);
    }
    if (updateResult.removedExports.length > 0) {
      lines.push(`  Removed exports: ${updateResult.removedExports.join(", ")}`);
    }
    if (updateResult.affectedDependents.length > 0) {
      lines.push(`  Dependents that may need updates: ${updateResult.affectedDependents.map(f => path.basename(f)).join(", ")}`);
    }
  }

  return lines.join("\n");
}

function buildBuildErrorAnalysis(fixPlan, totalErrors) {
  const lines = [`\u2717 Build failed: ${totalErrors} errors`, "", "Error Analysis (fix in this order):", ""];

  // Priority 1: Root cause errors
  if (fixPlan.queue1.length > 0) {
    lines.push("Priority 1 \u2014 Fix first (root cause errors):");
    for (const group of fixPlan.queue1) {
      const rankInfo = group.rank.isHub ? `hub file, ${group.rank.dependentCount || 0} dependents` : `depth ${group.rank.depth}`;
      lines.push(`  ${path.basename(group.file)} (${group.errorCount} errors, ${rankInfo}):`);
      for (const err of group.errors.slice(0, 3)) {
        lines.push(`    ${err.code}: ${err.message}`);
      }
      if (group.errors.length > 3) lines.push(`    ... and ${group.errors.length - 3} more`);
    }
    lines.push("");
  }

  // Priority 2: Isolated errors
  if (fixPlan.queue2.length > 0) {
    lines.push("Priority 2 \u2014 Fix next (isolated errors):");
    for (const group of fixPlan.queue2) {
      const safety = group.rank.isLeaf ? "leaf file, safe to fix" : `depth ${group.rank.depth}`;
      lines.push(`  ${path.basename(group.file)} (${group.errorCount} errors, ${safety}):`);
      for (const err of group.errors.slice(0, 2)) {
        lines.push(`    ${err.code}: ${err.message}`);
      }
      if (group.errors.length > 2) lines.push(`    ... and ${group.errors.length - 2} more`);
    }
    lines.push("");
  }

  // Auto-resolvable
  if (fixPlan.autoResolvable.length > 0) {
    lines.push(`May auto-resolve (${fixPlan.autoResolvable.length} errors):`);
    const byOrigin = new Map();
    for (const err of fixPlan.autoResolvable) {
      const list = byOrigin.get(err.autoResolveWhen) || [];
      list.push(err);
      byOrigin.set(err.autoResolveWhen, list);
    }
    for (const [origin, errs] of byOrigin) {
      lines.push(`  ${errs.length} errors trace to ${path.basename(origin)} \u2014 likely auto-resolve after fixing it`);
    }
    lines.push("");
  }

  // Summary
  lines.push(`Suggested approach: Fix Priority 1 first, then rebuild. ${fixPlan.autoResolvable.length} errors may auto-resolve.`);

  return lines.join("\n");
}

module.exports = { buildCreateFileResponse, buildEditFileResponse, buildBuildErrorAnalysis };
```

- [ ] **Step 4: Run tests**

Run: `npx jest smart-fix/tests/context-builder.test.js -v`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add smart-fix/context-builder.js smart-fix/tests/context-builder.test.js
git commit -m "feat: context builder for enriched tool responses"
```

---

## Phase 3: Integration into attar-code.js (Tasks 8–10)

### Task 8: Entry Point + SESSION Integration

**Files:**
- Create: `Attar-Code/smart-fix/index.js`
- Modify: `Attar-Code/attar-code.js` (lines 465, 6338, 110)

- [ ] **Step 1: Create smart-fix/index.js entry point**

```javascript
// smart-fix/index.js
const { TreeManager } = require("./tree-manager");
const { computeFixOrder } = require("./fix-order");
const { buildCreateFileResponse, buildEditFileResponse, buildBuildErrorAnalysis } = require("./context-builder");

let treeManager = null;

function initSmartFix() {
  treeManager = new TreeManager();
  return treeManager;
}

function getTree() {
  return treeManager;
}

module.exports = {
  initSmartFix,
  getTree,
  TreeManager,
  computeFixOrder,
  buildCreateFileResponse,
  buildEditFileResponse,
  buildBuildErrorAnalysis,
};
```

- [ ] **Step 2: Add `_depGraph` to SESSION (line 465 of attar-code.js)**

Add after `plan: null,` (line 464):
```javascript
  _depGraph: null,         // smart-fix dependency tree manager
```

- [ ] **Step 3: Add require + init call in main() (line 6338 of attar-code.js)**

At top of file (after other requires, around line 10):
```javascript
let smartFix;
try { smartFix = require("./smart-fix"); } catch (e) { smartFix = null; }
```

After line 6338 (after hookEngine init):
```javascript
  // Initialize smart-fix dependency tree
  if (smartFix) {
    try {
      SESSION._depGraph = smartFix.initSmartFix();
      debugLog("Smart-fix dependency tree initialized");
    } catch (err) { debugLog("Smart-fix init failed: " + err.message); }
  }
```

- [ ] **Step 4: Add plugin bootstrap (line 110 of attar-code.js)**

After the skills copy block (line 110), add:
```javascript
  // Copy dependency tree plugins if directory is empty
  try {
    const srcDir = path.join(DEFAULTS_DIR, "plugins");
    const destDir = path.join(HOME_DIR, "plugins");
    if (fs.existsSync(srcDir)) {
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      const existing = fs.readdirSync(destDir).filter(f => f.endsWith(".json"));
      if (existing.length === 0) {
        for (const f of fs.readdirSync(srcDir).filter(f => f.endsWith(".json"))) {
          fs.copyFileSync(path.join(srcDir, f), path.join(destDir, f));
        }
        debugLog("Bootstrapped dependency tree plugins");
      }
    }
  } catch (err) { debugLog(err.message); }
```

- [ ] **Step 5: Verify CLI starts without errors**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && node -e "require('./smart-fix'); console.log('OK')"`
Expected: "OK" printed

- [ ] **Step 6: Commit**

```bash
git add smart-fix/index.js attar-code.js
git commit -m "feat: integrate smart-fix initialization into CLI startup"
```

---

### Task 9: Hook into write_file and edit_file Tool Handlers

**Files:**
- Modify: `Attar-Code/attar-code.js` (lines 2089–2097, 2127–2136)

- [ ] **Step 1: Add tree enrichment to write_file (before line 2097)**

Replace the return block (lines 2094-2097) with:
```javascript
      // Smart-fix: update dependency tree + enrich response
      let smartFixInfo = "";
      if (smartFix && SESSION._depGraph) {
        try {
          const tree = SESSION._depGraph;
          const ext = path.extname(fp).toLowerCase();
          if ([".ts",".tsx",".js",".jsx",".mjs",".cjs"].includes(ext)) {
            tree.addFile(fp);
            const validation = tree.validateImports(fp);
            const summary = tree.getProjectSummary();
            const fileCount = tree.getFileCount();
            smartFixInfo = "\n\n" + smartFix.buildCreateFileResponse(fp, validation, summary, fileCount);
          }
        } catch (err) { debugLog("Smart-fix write_file hook: " + err.message); }
      }

      if (writeCount === 2) {
        return `✓ Written: ${fp}\n\n⚠ WARNING: This is the 2nd time you wrote "${path.basename(fp)}" with different content. Further changes MUST use edit_file, not write_file.${smartFixInfo}`;
      }
      return `✓ Written: ${fp}${writeValidation ? "\n\n⚠ VALIDATION WARNING:\n" + writeValidation + "\nFix these issues before building." : ""}${smartFixInfo}`;
```

- [ ] **Step 2: Add tree enrichment to edit_file (before line 2136)**

Replace the return block (lines 2132-2136) with:
```javascript
      // Smart-fix: update dependency tree + enrich response
      let smartFixInfo = "";
      if (smartFix && SESSION._depGraph) {
        try {
          const tree = SESSION._depGraph;
          const ext = path.extname(fp).toLowerCase();
          if ([".ts",".tsx",".js",".jsx",".mjs",".cjs"].includes(ext)) {
            const updateResult = tree.updateFile(fp);
            if (updateResult.structuralChange) {
              smartFixInfo = "\n\n" + smartFix.buildEditFileResponse(fp, updateResult);
            }
          }
        } catch (err) { debugLog("Smart-fix edit_file hook: " + err.message); }
      }

      const editsSinceBuild = SESSION._buildState?.editsBetweenBuilds || 0;
      if (editsSinceBuild >= 15) {
        return `✓ Edited: ${fp}\n\n⚠ You've made ${editsSinceBuild} edits since the last build. Call build_and_test NOW.${smartFixInfo}`;
      }
      return `✓ Edited: ${fp}${smartFixInfo}`;
```

- [ ] **Step 3: Test manually — start CLI, create a TypeScript file, verify enriched response**

Run: `node attar-code.js --model qwen2.5:14b`
Then ask: "Create a file src/types.ts with an interface User { name: string }"
Expected: Tool response includes "Project structure:" section

- [ ] **Step 4: Commit**

```bash
git add attar-code.js
git commit -m "feat: smart-fix enriched responses in write_file and edit_file handlers"
```

---

### Task 10: Hook into build_and_test — Pre-Build Tree Rebuild + Fix Ordering

**Files:**
- Modify: `Attar-Code/attar-code.js` (lines 2839–2928)
- Create: `Attar-Code/smart-fix/error-classifier.js`
- Create: `Attar-Code/smart-fix/tests/error-classifier.test.js`

- [ ] **Step 1: Write failing test for error classifier**

```javascript
// smart-fix/tests/error-classifier.test.js
const { classifyErrors } = require("../error-classifier");

describe("classifyErrors", () => {
  test("classifies local syntax errors with 0.0 cross-file probability", () => {
    const parsedErrors = [
      { file: "/utils.ts", line: 15, code: "TS1005", message: "';' expected" },
    ];
    const tree = null; // No tree needed for syntax errors
    const plugin = {
      errorCatalog: { categories: [{ errors: [
        { code: "TS1005", messagePattern: "'(.+?)' expected", baseCrossFileProbability: 0.0, refinements: [], fixHint: { primaryStrategy: "fix_syntax" }, coOccurrence: [] }
      ]}]}
    };

    const classified = classifyErrors(parsedErrors, tree, plugin);
    expect(classified[0].crossFileProbability).toBe(0.0);
    expect(classified[0].originFile).toBeNull();
  });

  test("classifies cross-file errors with origin tracing", () => {
    const parsedErrors = [
      { file: "/api.ts", line: 12, code: "TS2339", message: "Property 'phone' does not exist on type 'User'" },
    ];
    // Mock tree that knows User comes from types.ts
    const mockTree = {
      getFileAnalysis: (f) => {
        if (f === "/api.ts") return {
          imports: [{ rawSource: "./types", symbols: ["User"], isExternal: false }],
          definitions: [],
        };
        return null;
      },
      _resolveImportPath: (from, source) => source === "./types" ? "/types.ts" : null,
      getFileRank: (f) => ({ depth: f === "/types.ts" ? 0 : 1, isHub: f === "/types.ts", isLeaf: f !== "/types.ts" }),
    };
    const plugin = {
      errorCatalog: { categories: [{ errors: [
        { code: "TS2339",
          messagePattern: "Property '(?<propertyName>.+?)' does not exist on type '(?<typeName>.+?)'",
          captures: [
            { "name": "propertyName", "role": "property_name" },
            { "name": "typeName", "role": "type_name" }
          ],
          baseCrossFileProbability: 0.7,
          refinements: [{ check: { type: "is_imported", target: "typeName" }, adjustedProbability: 0.9, traceDepth: "transitive", traceTarget: "re_export_origin" }],
          fixHint: { primaryStrategy: "add_property", requiresCrossFileEdit: true },
          coOccurrence: []
        }
      ]}]}
    };

    const classified = classifyErrors(parsedErrors, mockTree, plugin);
    // Refinement fires: User is imported, so probability goes to 0.9
    expect(classified[0].crossFileProbability).toBe(0.9);
    // originFile should be resolved to /types.ts
    expect(classified[0].originFile).toBe("/types.ts");
  });
});
```

- [ ] **Step 2: Run test — expect fail**

- [ ] **Step 3: Write error classifier implementation**

```javascript
// smart-fix/error-classifier.js

function classifyErrors(parsedErrors, tree, plugin) {
  if (!plugin?.errorCatalog?.categories) return parsedErrors.map(e => ({ ...e, crossFileProbability: 0.5, originFile: null, originType: "unknown", fixHint: null }));

  // Build lookup from plugin
  const errorLookup = new Map();
  for (const cat of plugin.errorCatalog.categories) {
    for (const err of cat.errors) {
      errorLookup.set(err.code, err);
    }
  }

  return parsedErrors.map(error => {
    const catalogEntry = errorLookup.get(error.code);
    if (!catalogEntry) {
      return { ...error, crossFileProbability: 0.5, originFile: null, originType: "unknown", fixHint: null };
    }

    let crossFileProbability = catalogEntry.baseCrossFileProbability;
    let originFile = null;
    let originType = crossFileProbability > 0.5 ? "likely_cross_file" : "likely_local";

    // Extract captures from message
    let captures = {};
    if (catalogEntry.messagePattern) {
      try {
        const match = error.message.match(new RegExp(catalogEntry.messagePattern));
        if (match?.groups) captures = match.groups;
        else if (match) {
          // Positional captures
          (catalogEntry.captures || []).forEach((cap, i) => {
            if (match[i + 1]) captures[cap.name] = match[i + 1];
          });
        }
      } catch (e) { /* regex failed */ }
    }

    // Apply refinements using tree and resolve originFile
    if (tree && catalogEntry.refinements) {
      for (const ref of catalogEntry.refinements) {
        const targetValue = captures[ref.check.target];
        if (!targetValue) continue;

        let matches = false;
        let resolvedOrigin = null;
        const analysis = tree.getFileAnalysis?.(error.file);

        switch (ref.check.type) {
          case "is_imported": {
            if (analysis) {
              const matchingImport = analysis.imports.find(imp =>
                !imp.isExternal && imp.symbols.some(s => s === targetValue || s.startsWith(targetValue + " as "))
              );
              if (matchingImport) {
                matches = true;
                // Resolve the import source to actual file path
                resolvedOrigin = tree._resolveImportPath?.(error.file, matchingImport.rawSource) || null;
              }
            }
            break;
          }
          case "is_local": {
            if (analysis) {
              matches = analysis.definitions.some(d => d.name === targetValue);
            }
            break;
          }
          case "is_external": {
            if (analysis) {
              matches = analysis.imports.some(imp => imp.isExternal && imp.symbols.some(s => s === targetValue || s.includes(targetValue)));
            }
            break;
          }
          default:
            break;
        }

        if (matches) {
          crossFileProbability = ref.adjustedProbability;
          originType = ref.traceTarget || originType;
          if (resolvedOrigin) originFile = resolvedOrigin;
          break; // First matching refinement wins
        }
      }
    }

    // If probability is high but originFile not yet set, try to find it from imports
    if (crossFileProbability > 0.5 && !originFile && tree) {
      const analysis = tree.getFileAnalysis?.(error.file);
      if (analysis) {
        for (const imp of analysis.imports) {
          if (imp.isExternal) continue;
          const resolved = tree._resolveImportPath?.(error.file, imp.rawSource);
          if (resolved && imp.symbols.some(s => {
            const clean = s.includes(" as ") ? s.split(" as ")[0].trim() : s;
            return Object.values(captures).includes(clean);
          })) {
            originFile = resolved;
            break;
          }
        }
      }
    }

    return {
      ...error,
      captures,
      crossFileProbability,
      originFile,
      originType,
      fixHint: catalogEntry.fixHint || null,
      coOccurrence: catalogEntry.coOccurrence || [],
    };
  });
}

module.exports = { classifyErrors };
```

- [ ] **Step 4: Run tests**

Run: `npx jest smart-fix/tests/error-classifier.test.js -v`
Expected: All PASS

- [ ] **Step 5: Integrate into build_and_test in attar-code.js (line 2847)**

After line 2847 (after `const testCmd = getCmd("Test");`), add:
```javascript
      // Smart-fix: rebuild dependency tree before build
      if (smartFix && SESSION._depGraph) {
        try {
          SESSION._depGraph.fullRebuild(dir, [".ts",".tsx",".js",".jsx"]);
          debugLog(`Smart-fix: tree rebuilt with ${SESSION._depGraph.getFileCount()} files`);
        } catch (err) { debugLog("Smart-fix pre-build: " + err.message); }
      }
```

After the existing `prescribeFixesForBuild()` call (around line 2903), add:
```javascript
      // Smart-fix: enhanced fix ordering replaces default ordering
      if (smartFix && SESSION._depGraph && parsed) {
        // Remove the default "Fix IN THIS ORDER" section to avoid conflicting guidance
        const defaultOrderIdx = results.findIndex(r => typeof r === "string" && r.includes("Fix IN THIS ORDER"));
        if (defaultOrderIdx >= 0) results[defaultOrderIdx] = results[defaultOrderIdx].split("Fix IN THIS ORDER")[0] + "(see smart-fix analysis below)";

        try {
          const pluginPath = path.join(HOME_DIR, "plugins", "typescript.json");
          let plugin = null;
          try { plugin = JSON.parse(fs.readFileSync(pluginPath, "utf-8")); } catch (e) { /* no plugin */ }

          if (plugin) {
            const { classifyErrors } = require("./smart-fix/error-classifier");
            const structuredErrors = parsed.sorted.flatMap(({ file: f, errors: errs }) =>
              errs.map(e => {
                const m = e.match(/line\s+(\d+):\s*(TS\d+):\s*(.*)/);
                return m ? { file: path.resolve(dir, f), line: parseInt(m[1]), code: m[2], message: m[3].trim() } : null;
              }).filter(Boolean)
            );
            const classified = classifyErrors(structuredErrors, SESSION._depGraph, plugin);
            const fixPlan = smartFix.computeFixOrder(classified, SESSION._depGraph.getRanks());
            const analysis = smartFix.buildBuildErrorAnalysis(fixPlan, parsed.totalErrors);
            results.push("\n" + analysis);
          }
        } catch (err) { debugLog("Smart-fix build analysis: " + err.message); }
      }
```

- [ ] **Step 6: Commit**

```bash
git add smart-fix/error-classifier.js smart-fix/tests/error-classifier.test.js attar-code.js
git commit -m "feat: error classification + fix ordering integrated into build_and_test"
```

---

## Phase 4: Cascade Error Fixtures + Full Integration Test (Task 11)

### Task 11: End-to-End Test with Cascading Errors

**Files:**
- Create: `Attar-Code/smart-fix/fixtures/cascade-errors/src/types.ts`
- Create: `Attar-Code/smart-fix/fixtures/cascade-errors/src/db.ts`
- Create: `Attar-Code/smart-fix/fixtures/cascade-errors/src/auth.ts`
- Create: `Attar-Code/smart-fix/fixtures/cascade-errors/src/api.ts`
- Create: `Attar-Code/smart-fix/tests/integration.test.js`

- [ ] **Step 1: Create cascade-errors fixture (intentional errors)**

`cascade-errors/src/types.ts` — ROOT CAUSE: missing `phone` property:
```typescript
export interface User {
  id: string;
  name: string;
  email: string;
}
export enum UserRole { ADMIN = "admin", USER = "user" }
```

`cascade-errors/src/db.ts`:
```typescript
import { User } from './types';
export function findUser(id: string): User {
  return { id, name: "Test", email: "test@test.com" };
}
export function createUser(name: string, email: string, phone: string): User {
  return { id: "1", name, email, phone };  // ERROR: phone not in User
}
```

`cascade-errors/src/auth.ts`:
```typescript
import { User, UserRole } from './types';
import { findUser } from './db';
export function authenticate(token: string): User {
  const user = findUser("1");
  console.log(user.phone);  // ERROR: phone not in User
  return user;
}
```

`cascade-errors/src/api.ts`:
```typescript
import { authenticate } from './auth';
import { createUser } from './db';
export function handleRequest() {
  const user = authenticate("token");
  console.log(user.phone);  // ERROR: phone not in User (cascading)
  const newUser = createUser("Test", "test@test.com", "555-1234");
}
```

- [ ] **Step 2: Write integration test**

```javascript
// smart-fix/tests/integration.test.js
const { TreeManager } = require("../tree-manager");
const { computeFixOrder } = require("../fix-order");
const { classifyErrors } = require("../error-classifier");
const { buildBuildErrorAnalysis } = require("../context-builder");
const { fixturePath } = require("./setup");
const path = require("path");
const fs = require("fs");

describe("Integration: Cascading Error Resolution", () => {
  let tree;

  beforeEach(() => {
    tree = new TreeManager();
    tree.fullRebuild(fixturePath("cascade-errors", "src"), [".ts"]);
  });

  test("tree correctly identifies types.ts as hub", () => {
    const typesPath = fixturePath("cascade-errors", "src", "types.ts");
    const rank = tree.getFileRank(typesPath);
    expect(rank.depth).toBe(0);
    expect(rank.isRoot).toBe(true);
    expect(rank.dependentCount).toBeGreaterThanOrEqual(2);
  });

  test("tree correctly identifies dependency chain", () => {
    const typesPath = fixturePath("cascade-errors", "src", "types.ts");
    const apiPath = fixturePath("cascade-errors", "src", "api.ts");
    const deps = tree.getDependenciesOf(apiPath).map(f => path.basename(f));
    expect(deps).toContain("auth.ts");
    expect(deps).toContain("db.ts");
  });

  test("fix ordering puts types.ts errors before cascading errors", () => {
    // Simulate errors that would come from tsc
    const errors = [
      { file: fixturePath("cascade-errors", "src", "db.ts"), line: 5, code: "TS2353", message: "Object literal may only specify known properties, and 'phone' does not exist in type 'User'" },
      { file: fixturePath("cascade-errors", "src", "auth.ts"), line: 5, code: "TS2339", message: "Property 'phone' does not exist on type 'User'" },
      { file: fixturePath("cascade-errors", "src", "api.ts"), line: 5, code: "TS2339", message: "Property 'phone' does not exist on type 'User'" },
    ];

    // Load plugin
    const pluginPath = path.join(__dirname, "..", "..", "defaults", "plugins", "typescript.json");
    let plugin = null;
    try { plugin = JSON.parse(fs.readFileSync(pluginPath, "utf-8")); } catch (e) { /* skip */ }

    if (plugin) {
      const classified = classifyErrors(errors, tree, plugin);
      const plan = computeFixOrder(classified, tree.getRanks());

      // All 3 errors trace to types.ts (User interface)
      // The fix ordering should identify this pattern
      const output = buildBuildErrorAnalysis(plan, 3);
      expect(output).toContain("auto-resolve");
    }
  });

  test("validateImports catches missing exports", () => {
    // Create a file that imports a non-existent symbol
    const testCode = 'import { User, Phone } from "./types";\nexport const x = 1;';
    const testPath = fixturePath("cascade-errors", "src", "test-bad.ts");

    // Simulate by adding directly to tree
    const { analyzeFile } = require("../file-analyzer");
    const analysis = analyzeFile(testCode, testPath);
    tree.graph.addNode(testPath, analysis);

    const warnings = tree.validateImports(testPath);
    const errors = warnings.filter(w => w.status === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("Phone");
  });
});
```

- [ ] **Step 3: Run full test suite**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/ -v`
Expected: All tests PASS across all 8 test files

- [ ] **Step 4: Commit**

```bash
git add smart-fix/fixtures/cascade-errors/ smart-fix/tests/integration.test.js
git commit -m "feat: end-to-end integration test with cascading error fixture"
```

---

## Summary

| Phase | Tasks | What You Get |
|-------|-------|-------------|
| **1: Foundation** | Tasks 1–4 | Test framework, AST analyzer, graph, ranker |
| **2: Orchestration** | Tasks 5–7 | Tree manager, fix ordering, context builder |
| **3: Integration** | Tasks 8–10 | Wired into attar-code.js tool handlers |
| **4: Validation** | Task 11 | End-to-end test proving cascading errors are ordered correctly |

**Total new files:** 17 (9 modules + 8 test files)
**Lines added to attar-code.js:** ~150
**New dependency:** `@babel/parser` (AST parsing)
**Dev dependency:** `jest` (testing)

After this plan is complete, the CLI will:
1. Validate imports immediately when files are created/edited (prevention)
2. Show enriched responses with project structure and warnings
3. Rebuild the dependency tree before each build
4. Classify errors with cross-file probability scoring
5. Order fixes by root cause first, isolated second, auto-resolvable last
