// smart-fix/tree-manager.js
const fs = require("fs");
const path = require("path");
const { analyzeFile, analyzeFileWithPlugin } = require("./file-analyzer");
const { DependencyGraph } = require("./graph-builder");
const { rankFiles } = require("./file-ranker");

// Extensions that @babel/parser handles natively
const JS_TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

class TreeManager {
  constructor() {
    this.graph = new DependencyGraph();
    this.ranks = new Map();
    this.projectRoot = null;
    this.extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".cs", ".php", ".swift"];
    this.plugin = null; // Language plugin for non-JS/TS files
    this.detectedLanguage = null;
  }

  /**
   * Load a language plugin for non-JS/TS analysis
   */
  loadPlugin(pluginPath) {
    try {
      this.plugin = JSON.parse(fs.readFileSync(pluginPath, "utf-8"));
      this.detectedLanguage = this.plugin.metadata?.language || null;
      // Add plugin's file extensions
      const pluginExts = this.plugin.metadata?.fileExtensions || [];
      for (const ext of pluginExts) {
        if (!this.extensions.includes(ext)) this.extensions.push(ext);
      }
    } catch (err) { /* no plugin available */ }
  }

  /**
   * Auto-detect language and load appropriate plugin
   */
  autoDetectAndLoadPlugin(projectRoot) {
    const pluginsDir = path.join(path.dirname(__dirname), "defaults", "plugins");
    // Also check user home
    const homePluginsDir = path.join(require("os").homedir(), ".attar-code", "plugins");

    const detectors = [
      { files: ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile"], plugin: "python.json", exts: [".py", ".pyi"] },
      { files: ["go.mod"], plugin: "go.json", exts: [".go"] },
      { files: ["Cargo.toml"], plugin: "rust.json", exts: [".rs"] },
      { files: ["pom.xml", "build.gradle", "build.gradle.kts"], plugin: "java.json", exts: [".java", ".kt"] },
      { files: ["composer.json"], plugin: "php.json", exts: [".php"] },
      { files: ["Package.swift"], plugin: "swift.json", exts: [".swift"] },
      { files: ["*.csproj", "*.sln"], plugin: "csharp.json", exts: [".cs"] },
      { files: ["tsconfig.json", "package.json"], plugin: "typescript.json", exts: [".ts", ".tsx", ".js", ".jsx"] },
    ];

    for (const det of detectors) {
      const found = det.files.some(f => {
        if (f.includes("*")) {
          try { return fs.readdirSync(projectRoot).some(e => e.endsWith(f.replace("*", ""))); } catch { return false; }
        }
        return fs.existsSync(path.join(projectRoot, f));
      });
      if (found) {
        // Try user home first, then defaults
        const pluginPath = fs.existsSync(path.join(homePluginsDir, det.plugin))
          ? path.join(homePluginsDir, det.plugin)
          : path.join(pluginsDir, det.plugin);
        if (fs.existsSync(pluginPath)) {
          this.loadPlugin(pluginPath);
          this.extensions = [...new Set([...this.extensions, ...det.exts])];
        }
        break;
      }
    }
  }

  /**
   * Analyze a file using the best available method
   */
  _analyzeFileAuto(content, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (JS_TS_EXTENSIONS.has(ext)) {
      return analyzeFile(content, filePath); // AST-based (precise)
    }
    if (this.plugin) {
      return analyzeFileWithPlugin(content, filePath, this.plugin); // Plugin regex-based
    }
    return { file: filePath, imports: [], exports: [], definitions: [], externalPackages: [] };
  }

  addFile(filePath) {
    const content = fs.readFileSync(filePath, "utf-8");
    const analysis = this._analyzeFileAuto(content, filePath);
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
    const newAnalysis = this._analyzeFileAuto(content, filePath);

    const oldExports = new Set((oldAnalysis?.exports || []).flatMap(e => e.symbols));
    const newExports = new Set(newAnalysis.exports.flatMap(e => e.symbols));
    const oldImportSources = new Set((oldAnalysis?.imports || []).map(i => i.rawSource));
    const newImportSources = new Set(newAnalysis.imports.map(i => i.rawSource));

    const exportsChanged = !setsEqual(oldExports, newExports);
    const importsChanged = !setsEqual(oldImportSources, newImportSources);
    const structuralChange = exportsChanged || importsChanged;

    // Remove old edges from this file (including symbol metadata)
    for (const dep of this.graph.getDependenciesOf(filePath)) {
      this.graph.edges.get(filePath)?.delete(dep);
      this.graph.reverseEdges.get(dep)?.delete(filePath);
      this.graph.edgeSymbols.delete(`${filePath}|${dep}`);
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
    if (extensions) this.extensions = [...new Set([...this.extensions, ...extensions])];
    this.graph.clear();
    this.ranks.clear();

    // Auto-detect language and load plugin
    this.autoDetectAndLoadPlugin(projectRoot);

    const files = this._scanFiles(projectRoot);
    for (const f of files) {
      try {
        const content = fs.readFileSync(f, "utf-8");
        const analysis = this._analyzeFileAuto(content, f);
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
    if (!rawSource) return null;

    const dir = path.dirname(fromFile);
    const ext = path.extname(fromFile).toLowerCase();

    // --- Python resolution: dots → directories ---
    if ([".py", ".pyi"].includes(ext) || this.detectedLanguage === "Python") {
      // Relative: from .module import X → ./module.py
      if (rawSource.startsWith(".")) {
        let dots = 0;
        let rest = rawSource;
        while (rest.startsWith(".")) { dots++; rest = rest.slice(1); }
        let base = dir;
        for (let i = 1; i < dots; i++) base = path.dirname(base);
        if (!rest) {
          // "from .. import X" — import parent package init
          const candidates = [path.join(base, "__init__.py")];
          for (const c of candidates) {
            if (this.graph.hasNode(c)) return c;
            if (fs.existsSync(c)) return c;
          }
          return null;
        }
        const modulePath = rest.replace(/\./g, path.sep);
        const candidates = [
          path.join(base, modulePath + ".py"),
          path.join(base, modulePath, "__init__.py"),
        ];
        for (const c of candidates) {
          if (this.graph.hasNode(c)) return c;
          if (fs.existsSync(c)) return c; // File exists but not yet in graph
        }
        return null;
      }
      // Absolute: from app.models.user import User → app/models/user.py
      if (rawSource.includes(".") || rawSource.startsWith("app") || rawSource.startsWith("src")) {
        const modulePath = rawSource.replace(/\./g, path.sep);
        const root = this.projectRoot || dir;
        const candidates = [
          path.join(root, modulePath + ".py"),
          path.join(root, modulePath, "__init__.py"),
          path.resolve(dir, modulePath + ".py"),
          path.resolve(dir, modulePath, "__init__.py"),
        ];
        for (const c of candidates) {
          if (this.graph.hasNode(c)) return c;
          if (fs.existsSync(c)) return c;
        }
        return null;
      }
      return null; // External package
    }

    // --- JS/TS resolution: relative paths ---
    if (!rawSource.startsWith(".") && !rawSource.startsWith("/")) return null; // external
    const base = path.resolve(dir, rawSource);

    // Try exact path
    for (const extension of ["", ...this.extensions]) {
      const full = base + extension;
      if (this.graph.hasNode(full)) return full;
    }

    // Try index files
    for (const extension of this.extensions) {
      const full = path.join(base, "index" + extension);
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
