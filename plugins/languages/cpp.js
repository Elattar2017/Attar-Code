'use strict';

/**
 * plugins/languages/cpp.js — C/C++ language plugin.
 *
 * Strategy resolution: cmake -> make -> ninja (first available wins)
 * Wraps defaults/plugins/cpp.json error catalog (falls back to empty if missing).
 * Supports: C11/C17/C23, C++17/20/23, gcc, g++, clang, cmake, make, ninja.
 *
 * NOTE: This plugin only invokes known safe commands (gcc --version, cmake --build)
 * through OSAbstraction. No user input is passed to shell commands.
 */

const fs = require('fs');
const path = require('path');
const { LanguagePlugin } = require('../plugin-contract');
const { OSAbstraction } = require('../os-abstraction');
const { satisfiesMinimum } = require('../version-resolver');

class CppPlugin extends LanguagePlugin {
  constructor(opts = {}) {
    super({
      id: 'cpp',
      displayName: 'C/C++',
      extensions: ['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp'],
      configFiles: ['CMakeLists.txt', 'Makefile', 'meson.build'],
      ...opts,
    });
  }

  // --- Detection ---------------------------------------------------------------

  detect(projectRoot) {
    if (super.detect(projectRoot)) return true;
    try {
      const entries = fs.readdirSync(projectRoot);
      const cppExts = new Set(this.extensions);
      if (entries.some(f => cppExts.has(path.extname(f).toLowerCase()))) return true;
      const srcDir = path.join(projectRoot, 'src');
      if (fs.existsSync(srcDir)) return fs.readdirSync(srcDir).some(f => cppExts.has(path.extname(f).toLowerCase()));
    } catch {}
    return false;
  }

  detectVersion() {
    // Try g++ first, then gcc, then clang
    for (const compiler of ['g++', 'gcc', 'clang++', 'clang']) {
      const info = OSAbstraction.getVersion(compiler, '--version', /(\d+\.\d+\.\d+)/);
      if (info) return { version: info.version, path: OSAbstraction.which(compiler), source: compiler };
    }
    return null;
  }

  detectTestFramework(projectRoot) {
    // Check for common C++ test frameworks in CMakeLists.txt
    const cmakePath = path.join(projectRoot, 'CMakeLists.txt');
    if (fs.existsSync(cmakePath)) {
      try {
        const content = fs.readFileSync(cmakePath, 'utf-8');
        if (/gtest|googletest|GTest/i.test(content)) return { name: 'googletest', command: 'cmake --build build && ctest --test-dir build', jsonFlag: '--output-junit' };
        if (/catch2|Catch2/i.test(content)) return { name: 'catch2', command: 'cmake --build build && ctest --test-dir build', jsonFlag: null };
      } catch {}
    }
    return null;
  }

  // --- Environment -------------------------------------------------------------

  getStrategyOrder() { return ['cmake', 'make', 'ninja']; }

  checkEnvironment(projectRoot) {
    const report = { ready: false, runtime: null, packageManager: null, virtualEnv: null, missing: [], warnings: [], strategy: null };
    const ver = this.detectVersion();
    if (!ver) {
      report.runtime = { installed: false, version: null, compatible: false };
      report.missing.push({ tool: 'gcc', installCmd: OSAbstraction.getInstallHint('gcc') });
      return report;
    }

    report.runtime = { installed: true, version: ver.version, path: ver.path, compatible: satisfiesMinimum(ver.version, '10.0.0'), minVersion: '10.0.0', compiler: ver.source };
    if (!report.runtime.compatible) report.warnings.push(ver.source + ' ' + ver.version + ' is below minimum 10.0.0');

    // Detect build system strategy (first available wins from project files)
    for (const strategy of this.getStrategyOrder()) {
      if (strategy === 'cmake' && fs.existsSync(path.join(projectRoot, 'CMakeLists.txt'))) {
        const cmakeVer = OSAbstraction.getVersion('cmake', '--version', /cmake version\s+(\d+\.\d+\.\d+)/);
        if (cmakeVer) { report.strategy = 'cmake'; report.packageManager = { name: 'cmake', version: cmakeVer.version }; break; }
        else { report.missing.push({ tool: 'cmake', installCmd: OSAbstraction.getInstallHint('cmake') }); }
      }
      if (strategy === 'make' && fs.existsSync(path.join(projectRoot, 'Makefile'))) {
        const makeVer = OSAbstraction.getVersion('make', '--version', /(\d+\.\d+[\d.]*)/);
        if (makeVer) { report.strategy = 'make'; report.packageManager = { name: 'make', version: makeVer.version }; break; }
        else { report.missing.push({ tool: 'make', installCmd: OSAbstraction.getInstallHint('make') }); }
      }
      if (strategy === 'ninja' && fs.existsSync(path.join(projectRoot, 'build.ninja'))) {
        const ninjaVer = OSAbstraction.getVersion('ninja', '--version', /(\d+\.\d+[\d.]*)/);
        if (ninjaVer) { report.strategy = 'ninja'; report.packageManager = { name: 'ninja', version: ninjaVer.version }; break; }
        else { report.missing.push({ tool: 'ninja', installCmd: OSAbstraction.getInstallHint('ninja') }); }
      }
    }

    // If no build file found, check for tools on PATH
    if (!report.strategy) {
      if (OSAbstraction.which('cmake')) { report.strategy = 'cmake'; report.packageManager = { name: 'cmake', version: null }; }
      else if (OSAbstraction.which('make')) { report.strategy = 'make'; report.packageManager = { name: 'make', version: null }; }
      else { report.warnings.push('No build system (cmake, make, ninja) detected'); }
    }

    report.ready = report.runtime.installed && report.runtime.compatible;
    return report;
  }

  setupEnvironment(projectRoot) {
    const steps = [];
    if (fs.existsSync(path.join(projectRoot, 'CMakeLists.txt'))) {
      steps.push({ action: 'cmake_configure', command: 'cmake -B build' });
      steps.push({ action: 'cmake_build', command: 'cmake --build build' });
    } else if (fs.existsSync(path.join(projectRoot, 'Makefile'))) {
      steps.push({ action: 'make_build', command: 'make' });
    }
    return { steps, venvPath: null, activateCmd: null };
  }

  // --- Scaffolding -------------------------------------------------------------

  async getLatestVersions() {
    // No central registry for C/C++ packages
    const runtime = this.detectVersion();
    return { runtime: runtime?.version || null, frameworks: {} };
  }

  scaffold(name, opts = {}) {
    const files = [], deps = {}, devDeps = {}, scripts = {}, postCreate = [];

    files.push(
      { path: 'CMakeLists.txt', template: 'cmake_project' },
      { path: 'src/main.cpp', template: 'cpp_main' },
      { path: 'include/.gitkeep', template: 'empty' }
    );

    scripts.configure = 'cmake -B build';
    scripts.build = 'cmake --build build';
    scripts.start = './build/' + name;
    scripts.test = 'cmake --build build && ctest --test-dir build';
    scripts.clean = 'cmake --build build --target clean';

    postCreate.push('mkdir -p build', 'cmake -B build');

    return { files, deps, devDeps, scripts, postCreate };
  }

  // --- Build & Run -------------------------------------------------------------

  getSyntaxCheckCommand(files, projectRoot) {
    if (!files || !files.length) return null;
    const compiler = this._detectCompiler();
    const cppFiles = files.filter(f => /\.(cpp|cc|cxx|c)$/.test(f));
    if (cppFiles.length === 0) return null;
    return compiler + ' -fsyntax-only ' + cppFiles.map(f => '"' + f + '"').join(' ');
  }

  getBuildCommand(projectRoot) {
    if (fs.existsSync(path.join(projectRoot, 'CMakeLists.txt'))) return 'cmake --build build';
    if (fs.existsSync(path.join(projectRoot, 'Makefile'))) return 'make';
    if (fs.existsSync(path.join(projectRoot, 'meson.build'))) return 'ninja -C builddir';
    return null;
  }

  getRunCommand(projectRoot, entryFile) {
    if (entryFile) {
      const compiler = this._detectCompiler();
      const outName = OSAbstraction.isWin ? 'a.exe' : './a.out';
      return compiler + ' ' + entryFile + ' -o ' + outName + ' && ' + outName;
    }
    if (fs.existsSync(path.join(projectRoot, 'CMakeLists.txt'))) return 'cmake --build build && ./build/*';
    if (fs.existsSync(path.join(projectRoot, 'Makefile'))) return 'make run';
    return null;
  }

  getInstallCommand(projectRoot) {
    if (fs.existsSync(path.join(projectRoot, 'CMakeLists.txt'))) return 'cmake -B build && cmake --build build';
    if (fs.existsSync(path.join(projectRoot, 'Makefile'))) return 'make';
    return null;
  }

  parseErrors(rawOutput, origin) {
    if (!rawOutput) return [];
    const errors = [];

    // Use toolchain patterns from JSON catalog (if catalog exists)
    for (const tc of (this.catalog.metadata?.toolchains || [])) {
      if (!tc.errorFormat) continue;
      try {
        const re = new RegExp(tc.errorFormat, 'gm');
        let m;
        while ((m = re.exec(rawOutput)) !== null) {
          const g = m.groups || {};
          errors.push(this._enrichFromCatalog({
            file: g.file || '', line: parseInt(g.line, 10) || 0, column: parseInt(g.column, 10) || null,
            code: g.code || 'CPP_ERROR', message: (g.message || '').trim(), severity: 'error',
            category: this._categorizeError(g.code, g.message), origin: origin || 'compiler',
            language: 'cpp', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0,
          }));
        }
      } catch {}
    }

    // Fallback: gcc/clang format: file:line:col: error: message
    if (errors.length === 0) {
      const cRe = /([^\s:]+\.(?:c|cpp|cc|cxx|h|hpp)):(\d+):(\d+):\s*(?:error|fatal error):\s*(.+)/gm;
      let m;
      while ((m = cRe.exec(rawOutput)) !== null) {
        errors.push(this._enrichFromCatalog({
          file: m[1], line: parseInt(m[2], 10), column: parseInt(m[3], 10),
          code: 'CPP_ERROR', message: m[4].trim(), severity: 'error',
          category: this._categorizeError(null, m[4]), origin: origin || 'compiler',
          language: 'cpp', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0,
        }));
      }
    }

    // Linker errors fallback
    if (errors.length === 0) {
      const linkRe = /undefined reference to [`'](.+?)['`]/gm;
      let m;
      while ((m = linkRe.exec(rawOutput)) !== null) {
        errors.push({
          file: '', line: 0, column: null,
          code: 'CPP_LINKER_ERROR', message: "undefined reference to '" + m[1] + "'", severity: 'error',
          category: 'linker', origin: origin || 'compiler',
          language: 'cpp', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0.5,
        });
      }
    }

    return errors;
  }

  getCrashPatterns() {
    return [/Segmentation fault/, /bus error/i, /abort/i, /undefined reference/, /core dumped/, /SIGSEGV/, /SIGABRT/];
  }

  // --- Testing -----------------------------------------------------------------

  getTestCommand(projectRoot, framework) {
    const fw = framework || this.detectTestFramework(projectRoot);
    if (fw) return fw.command;
    if (fs.existsSync(path.join(projectRoot, 'CMakeLists.txt'))) return 'cmake --build build && ctest --test-dir build';
    if (fs.existsSync(path.join(projectRoot, 'Makefile'))) return 'make test';
    return null;
  }

  parseTestOutput(raw) {
    const result = { passed: 0, failed: 0, errors: [] };
    if (!raw) return result;
    // CTest output: X tests passed, Y tests failed
    const pm = raw.match(/(\d+)\s+tests?\s+passed/i); if (pm) result.passed = parseInt(pm[1], 10);
    const fm = raw.match(/(\d+)\s+tests?\s+failed/i); if (fm) result.failed = parseInt(fm[1], 10);
    // Google Test: [  PASSED  ] X tests.  [  FAILED  ] Y tests.
    const gp = raw.match(/\[\s+PASSED\s+\]\s+(\d+)/); if (gp) result.passed = parseInt(gp[1], 10);
    const gf = raw.match(/\[\s+FAILED\s+\]\s+(\d+)/); if (gf) result.failed = parseInt(gf[1], 10);
    return result;
  }

  getEdgeCases(paramType) {
    const t = (paramType || '').toLowerCase();
    // Check char* and string types before generic pointer check
    if (t.includes('char*') || t.includes('char *') || t.includes('std::string') || t === 'string') return [{ label: 'NULL', value: 'NULL' }, { label: 'empty', value: '""' }, { label: 'whitespace', value: '" "' }];
    // Check pointer/reference types (before int matches *int)
    if (t.includes('nullptr') || t.includes('pointer') || /\*/.test(t)) return [{ label: 'nullptr', value: 'nullptr' }, { label: 'valid pointer', value: '&value' }];
    if (t.includes('size_t')) return [{ label: 'zero', value: '0' }, { label: 'SIZE_MAX', value: 'SIZE_MAX' }];
    if (t.includes('vector') || t.includes('array')) return [{ label: 'empty', value: '{}' }, { label: 'single', value: '{1}' }];
    if (t.includes('bool')) return [{ label: 'true', value: 'true' }, { label: 'false', value: 'false' }];
    if (t.includes('float') || t.includes('double')) return [{ label: 'zero', value: '0.0' }, { label: 'NaN', value: 'NAN' }, { label: 'INFINITY', value: 'INFINITY' }];
    if (t.includes('int') || t.includes('long') || t.includes('short')) return [{ label: 'zero', value: '0' }, { label: 'negative', value: '-1' }, { label: 'INT_MAX', value: 'INT_MAX' }, { label: 'INT_MIN', value: 'INT_MIN' }];
    return [{ label: 'zero', value: '0' }, { label: 'nullptr', value: 'nullptr' }];
  }

  generateMocks(deps) {
    return deps.map(dep => {
      const name = (dep.module || dep.name || '').toLowerCase();
      if (/sqlite|mysql|pq|mongo/.test(name)) return { name: dep.module || dep.name, returnValue: 'std::vector<Row>{}', type: 'database' };
      if (/curl|http|beast|cpr/.test(name)) return { name: dep.module || dep.name, returnValue: 'Response{200, "{}"}', type: 'http' };
      if (/fstream|filesystem|stdio/.test(name)) return { name: dep.module || dep.name, returnValue: '"mock content"', type: 'filesystem' };
      return { name: dep.module || dep.name, returnValue: '{}', type: 'generic' };
    });
  }

  buildSearchQuery(error) {
    const parts = ['C++'];
    if (error.code) parts.push(error.code);
    if (error.message) parts.push(error.message.slice(0, 60).trim());
    parts.push('fix');
    return parts.join(' ');
  }

  // --- Helpers -----------------------------------------------------------------

  _detectCompiler() {
    if (OSAbstraction.which('g++')) return 'g++';
    if (OSAbstraction.which('clang++')) return 'clang++';
    if (OSAbstraction.which('gcc')) return 'gcc';
    if (OSAbstraction.which('clang')) return 'clang';
    return 'g++';
  }

  _categorizeError(code, message) {
    const msg = (message || '').toLowerCase();
    if (/syntax|expected|parse|stray|missing/.test(msg)) return 'syntax';
    if (/no such file|not found|cannot find|include/.test(msg)) return 'import';
    if (/type|cannot convert|incompatible|invalid conversion/.test(msg)) return 'type';
    if (/undefined reference|multiple definition/.test(msg)) return 'linker';
    return 'runtime';
  }

  _enrichFromCatalog(error) {
    for (const cat of (this.errorCatalog.categories || [])) {
      for (const entry of (cat.errors || [])) {
        if (entry.code && entry.code === error.code) {
          const captures = {};
          if (entry.messagePattern) { try { const m = error.message.match(new RegExp(entry.messagePattern)); if (m && entry.captures) entry.captures.forEach((cap, i) => { if (cap.name && m[i + 1]) captures[cap.name] = m[i + 1]; }); } catch {} }
          return { ...error, captures, rootCause: entry.rootCause || null, prescription: entry.prescription || null, fixHint: entry.fixHint || null, baseCrossFileProbability: entry.baseCrossFileProbability || 0 };
        }
        if (!entry.code && entry.messagePattern) {
          try { if (new RegExp(entry.messagePattern).test(error.message)) return { ...error, rootCause: entry.rootCause || null, prescription: entry.prescription || null, fixHint: entry.fixHint || null, baseCrossFileProbability: entry.baseCrossFileProbability || 0 }; } catch {}
        }
      }
    }
    return error;
  }
}

module.exports = CppPlugin;
