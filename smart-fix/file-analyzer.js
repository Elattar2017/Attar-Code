// smart-fix/file-analyzer.js
const { parse } = require("@babel/parser");
const path = require("path");

// Common field/property names filtered from definition extraction (hoisted for performance)
const NOISE_NAMES = new Set(["id", "name", "email", "title", "description", "value", "key", "type", "data", "result", "error", "message", "status", "count", "index", "length", "size", "port", "host", "path", "url"]);

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

// ═══════════════════════════════════════════════════════════
// UNIVERSAL ANALYZER — Uses plugin regex patterns for any language
// ═══════════════════════════════════════════════════════════

function analyzeFileWithPlugin(content, filePath, plugin) {
  if (!plugin || !plugin.importSystem) {
    return { file: filePath, imports: [], exports: [], definitions: [], externalPackages: [] };
  }

  const imports = [];
  const exports = [];
  const definitions = [];
  const externalPackages = new Set();

  // Standard library modules to exclude from external packages
  const stdlibModules = new Set([
    "os", "sys", "re", "json", "datetime", "typing", "enum", "abc",
    "collections", "functools", "itertools", "pathlib", "logging", "hashlib",
    "contextlib", "dataclasses", "uuid", "time", "math", "io", "copy",
    "string", "textwrap", "struct", "codecs", "unicodedata", "difflib",
    "calendar", "random", "statistics", "fractions", "decimal", "secrets",
    "html", "xml", "email", "base64", "binascii", "quopri", "uu",
    "http", "urllib", "ftplib", "smtplib", "imaplib", "poplib",
    "socket", "ssl", "select", "selectors", "asyncio", "signal",
    "subprocess", "threading", "multiprocessing", "concurrent",
    "pickle", "shelve", "marshal", "dbm", "sqlite3", "csv",
    "configparser", "tomllib", "argparse", "getopt", "shutil",
    "tempfile", "glob", "fnmatch", "stat", "filecmp", "zipfile",
    "tarfile", "gzip", "bz2", "lzma", "unittest", "doctest",
    "pdb", "profile", "timeit", "trace", "tracemalloc", "warnings",
    "inspect", "dis", "gc", "weakref", "types", "importlib",
    "ast", "tokenize", "token", "keyword", "linecache", "traceback",
    "builtins",
    // Go stdlib
    "fmt", "net", "sync", "context", "errors", "sort", "strconv",
    "strings", "bytes", "bufio", "runtime", "reflect", "testing",
    // Rust std
    "std", "core", "alloc",
  ]);

  // --- EXTRACT IMPORTS ---
  for (const pattern of plugin.importSystem.importPatterns || []) {
    try {
      const regexStr = pattern.multiLineRegex || pattern.regex;
      const re = new RegExp(regexStr, "gm");
      let m;
      while ((m = re.exec(content)) !== null) {
        const captures = {};
        for (const cap of pattern.captures || []) {
          captures[cap.name] = m[cap.index] || (m.groups && m.groups[cap.name]) || null;
        }

        const rawSource = captures.source || captures.module || captures.defaultSymbol || "";
        const symbolsRaw = captures.symbols || "";

        let symbols = [];
        const listCap = (pattern.captures || []).find(c => c.isList);
        if (symbolsRaw && listCap) {
          symbols = symbolsRaw.split(listCap.listSeparator || ",").map(s => s.trim()).filter(Boolean);
        } else if (captures.defaultSymbol) {
          symbols = [captures.defaultSymbol.trim()];
        } else if (captures.alias) {
          symbols = [captures.alias.trim()];
        }

        // Determine if external
        const isRelative = rawSource.startsWith(".") || rawSource.startsWith("/");
        const isProjectLocal = rawSource.startsWith("app.") || rawSource.startsWith("app/") ||
          rawSource.startsWith("src.") || rawSource.startsWith("src/");
        const rootModule = rawSource.split(/[./]/)[0];
        const isExternal = !isRelative && !isProjectLocal && !stdlibModules.has(rootModule);

        if (isExternal && rootModule) externalPackages.add(rootModule);

        const matchLine = content.substring(0, m.index).split("\n").length;

        imports.push({
          type: pattern.type || "named",
          symbols,
          defaultSymbol: captures.defaultSymbol || null,
          namespaceAlias: captures.alias || null,
          rawSource,
          isExternal,
          isTypeOnly: false,
          line: matchLine,
        });
      }
    } catch (err) { /* bad regex in plugin, skip */ }
  }

  // --- EXTRACT EXPORTS ---
  for (const pattern of plugin.importSystem.exportPatterns || []) {
    try {
      const re = new RegExp(pattern.regex, "gm");
      let m;
      while ((m = re.exec(content)) !== null) {
        const captures = {};
        for (const cap of pattern.captures || []) {
          captures[cap.name] = m[cap.index] || (m.groups && m.groups[cap.name]) || null;
        }
        // Try all common capture names (different plugins use different names)
        const symbolsRaw = captures.symbols || captures.symbolName || captures.name ||
          captures.className || captures.functionName || captures.interfaceName ||
          captures.traitName || captures.enumName || captures.constName ||
          captures.structName || captures.typeName || "";
        let symbols = [];
        const listCap = (pattern.captures || []).find(c => c.isList);
        if (symbolsRaw && listCap) {
          symbols = symbolsRaw.split(listCap.listSeparator || ",").map(s => s.trim()).filter(Boolean);
        } else if (symbolsRaw) {
          symbols = [symbolsRaw.trim()];
        }
        exports.push({
          type: pattern.type || "named",
          symbols,
          isReExport: pattern.isReExport || false,
          reExportSource: captures.source || null,
          line: content.substring(0, m.index).split("\n").length,
        });
      }
    } catch (err) { /* bad regex, skip */ }
  }

  // --- EXTRACT DEFINITIONS ---
  if (plugin.typeTracing?.definitionPatterns) {
    for (const pattern of plugin.typeTracing.definitionPatterns) {
      try {
        const re = new RegExp(pattern.regex, "gm");
        let m;
        while ((m = re.exec(content)) !== null) {
          const name = m[1] || (m.groups && (m.groups.name || m.groups.n || Object.values(m.groups)[0])) || null;
          // Skip common field/property names that aren't real type definitions
          if (name && name.length < 100 && name.length >= 2 && !NOISE_NAMES.has(name.toLowerCase())) {
            definitions.push({
              kind: pattern.kind,
              name,
              line: content.substring(0, m.index).split("\n").length,
              isExported: pattern.canBeExported !== false,
              parents: [],
              composedOf: [],
            });
          }
        }
      } catch (err) { /* bad regex, skip */ }
    }
  }

  // Deduplicate definitions
  const seenDefs = new Set();
  const uniqueDefs = definitions.filter(d => {
    const key = `${d.name}:${d.line}`;
    if (seenDefs.has(key)) return false;
    seenDefs.add(key);
    return true;
  });

  // Deduplicate export symbols within each export entry, and across entries
  const seenExportSyms = new Set();
  for (const exp of exports) {
    exp.symbols = exp.symbols.filter(s => {
      if (seenExportSyms.has(s)) return false;
      seenExportSyms.add(s);
      return true;
    });
  }
  const cleanExports = exports.filter(e => e.symbols.length > 0);

  return { file: filePath, imports, exports: cleanExports, definitions: uniqueDefs, externalPackages: [...externalPackages] };
}

module.exports = { analyzeFile, analyzeFileWithPlugin };
