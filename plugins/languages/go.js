'use strict';

/**
 * plugins/languages/go.js — Go language plugin.
 *
 * Strategy resolution: go (go mod only)
 * Wraps defaults/plugins/go.json error catalog.
 * Supports: Go 1.21+, go build, go vet, golangci-lint.
 *
 * NOTE: This plugin only invokes known safe commands (go version, go mod init)
 * through OSAbstraction. No user input is passed to shell commands.
 */

const fs = require('fs');
const path = require('path');
const { LanguagePlugin } = require('../plugin-contract');
const { OSAbstraction } = require('../os-abstraction');
const { VersionResolver, satisfiesMinimum } = require('../version-resolver');

class GoPlugin extends LanguagePlugin {
  constructor(opts = {}) {
    super({
      id: 'go',
      displayName: 'Go',
      extensions: ['.go'],
      configFiles: ['go.mod'],
      ...opts,
    });
    this._versionResolver = new VersionResolver({ proxyUrl: this._proxyUrl });
  }

  // --- Detection ---------------------------------------------------------------

  detect(projectRoot) {
    if (super.detect(projectRoot)) return true;
    try {
      const entries = fs.readdirSync(projectRoot);
      if (entries.some(f => f.endsWith('.go'))) return true;
    } catch {}
    return false;
  }

  detectVersion() {
    const info = OSAbstraction.getVersion('go', 'version', /go(\d+\.\d+\.\d+)/);
    if (!info) return null;
    return { version: info.version, path: OSAbstraction.which('go'), source: 'go' };
  }

  detectTestFramework(projectRoot) {
    if (fs.existsSync(path.join(projectRoot, 'go.mod'))) {
      return { name: 'go-test', command: 'go test ./...', jsonFlag: '-json' };
    }
    return null;
  }

  // --- Environment -------------------------------------------------------------

  getStrategyOrder() { return ['go']; }

  checkEnvironment(projectRoot) {
    const report = { ready: false, runtime: null, packageManager: null, virtualEnv: null, missing: [], warnings: [], strategy: null };
    const ver = this.detectVersion();
    if (!ver) {
      report.runtime = { installed: false, version: null, compatible: false };
      report.missing.push({ tool: 'go', installCmd: OSAbstraction.getInstallHint('go') });
      return report;
    }

    report.runtime = { installed: true, version: ver.version, path: ver.path, compatible: satisfiesMinimum(ver.version, '1.21.0'), minVersion: '1.21.0' };
    if (!report.runtime.compatible) report.warnings.push('Go ' + ver.version + ' is below minimum 1.21.0');

    report.strategy = 'go';
    report.packageManager = { name: 'go modules', version: ver.version };

    // Check GOPATH
    const gopath = process.env.GOPATH;
    if (!gopath) report.warnings.push('GOPATH not set; using default ~/go');

    report.ready = report.runtime.installed && report.runtime.compatible;
    return report;
  }

  setupEnvironment(projectRoot) {
    const steps = [];
    if (!fs.existsSync(path.join(projectRoot, 'go.mod'))) {
      const modName = path.basename(projectRoot);
      steps.push({ action: 'go_mod_init', command: 'go mod init ' + modName });
    }
    steps.push({ action: 'install_deps', command: 'go mod tidy' });
    return { steps, venvPath: null, activateCmd: null };
  }

  // --- Scaffolding -------------------------------------------------------------

  async getLatestVersions() {
    const runtime = this.detectVersion();
    const frameworks = await this._versionResolver.resolveAll([
      { registry: 'go', pkg: 'github.com/gin-gonic/gin' },
      { registry: 'go', pkg: 'github.com/gofiber/fiber/v2' },
    ]);
    return { runtime: runtime?.version || null, frameworks };
  }

  scaffold(name, opts = {}) {
    const framework = opts.framework || 'gin';
    const files = [], deps = {}, devDeps = {}, scripts = {}, postCreate = [];

    postCreate.push('go mod init ' + name);

    if (framework === 'gin') {
      deps['github.com/gin-gonic/gin'] = 'latest';
      files.push({ path: 'main.go', template: 'gin_app' });
      postCreate.push('go get github.com/gin-gonic/gin');
      scripts.start = 'go run main.go';
      scripts.test = 'go test ./...';
    } else if (framework === 'fiber') {
      deps['github.com/gofiber/fiber/v2'] = 'latest';
      files.push({ path: 'main.go', template: 'fiber_app' });
      postCreate.push('go get github.com/gofiber/fiber/v2');
      scripts.start = 'go run main.go';
      scripts.test = 'go test ./...';
    } else {
      files.push({ path: 'main.go', template: 'go_app' });
      scripts.start = 'go run main.go';
      scripts.test = 'go test ./...';
    }

    return { files, deps, devDeps, scripts, postCreate };
  }

  // --- Build & Run -------------------------------------------------------------

  getSyntaxCheckCommand(files, projectRoot) {
    if (!files || !files.length) return null;
    return 'go vet ./...';
  }

  getBuildCommand(projectRoot) {
    if (fs.existsSync(path.join(projectRoot, 'go.mod'))) return 'go build ./...';
    return null;
  }

  getRunCommand(projectRoot, entryFile) {
    if (entryFile) return 'go run ' + entryFile;
    if (fs.existsSync(path.join(projectRoot, 'main.go'))) return 'go run main.go';
    if (fs.existsSync(path.join(projectRoot, 'cmd'))) return 'go run ./cmd/...';
    return 'go run .';
  }

  getInstallCommand(projectRoot) { return 'go mod tidy'; }

  parseErrors(rawOutput, origin) {
    if (!rawOutput) return [];
    const errors = [];

    // Use toolchain patterns from JSON catalog
    for (const tc of (this.catalog.metadata?.toolchains || [])) {
      if (!tc.errorFormat) continue;
      try {
        const re = new RegExp(tc.errorFormat, 'gm');
        let m;
        while ((m = re.exec(rawOutput)) !== null) {
          const g = m.groups || {};
          errors.push(this._enrichFromCatalog({
            file: g.file || '', line: parseInt(g.line, 10) || 0, column: parseInt(g.column, 10) || null,
            code: g.code || 'GO_ERROR', message: (g.message || '').trim(), severity: 'error',
            category: this._categorizeError(g.code, g.message), origin: origin || 'compiler',
            language: 'go', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0,
          }));
        }
      } catch {}
    }

    // Fallback: ./file.go:line:col: message
    if (errors.length === 0) {
      const goRe = /([^\s:]+\.go):(\d+):(\d+)?:?\s*(.+)/gm;
      let m;
      while ((m = goRe.exec(rawOutput)) !== null) {
        errors.push(this._enrichFromCatalog({
          file: m[1], line: parseInt(m[2], 10), column: parseInt(m[3], 10) || null,
          code: 'GO_ERROR', message: m[4].trim(), severity: 'error',
          category: this._categorizeError(null, m[4]), origin: origin || 'compiler',
          language: 'go', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0,
        }));
      }
    }

    return errors;
  }

  getCrashPatterns() {
    return [/panic:/, /goroutine .* deadlock/, /nil pointer dereference/, /fatal error/, /signal: segmentation fault/, /runtime error/];
  }

  // --- Testing -----------------------------------------------------------------

  getTestCommand(projectRoot, framework) {
    return 'go test ./...';
  }

  parseTestOutput(raw) {
    const result = { passed: 0, failed: 0, errors: [] };
    if (!raw) return result;
    const pm = raw.match(/ok\s+/g); if (pm) result.passed = pm.length;
    const fm = raw.match(/FAIL\s+/g); if (fm) result.failed = fm.length;
    const failRe = /--- FAIL: (\S+)/g;
    let m; while ((m = failRe.exec(raw)) !== null) result.errors.push({ test: m[1] });
    return result;
  }

  getEdgeCases(paramType) {
    const t = (paramType || '').toLowerCase();
    if (t.includes('*') || t.includes('pointer')) return [{ label: 'nil', value: 'nil' }, { label: 'valid pointer', value: '&value' }];
    if (t.includes('error')) return [{ label: 'nil error', value: 'nil' }, { label: 'non-nil error', value: 'errors.New("fail")' }];
    if (t.includes('string')) return [{ label: 'empty', value: '""' }, { label: 'whitespace', value: '" "' }, { label: 'long', value: 'strings.Repeat("a", 10000)' }];
    if (t.includes('int') || t.includes('uint') || t.includes('float')) return [{ label: 'zero', value: '0' }, { label: 'negative', value: '-1' }, { label: 'max', value: 'math.MaxInt64' }];
    if (t.includes('[]') || t.includes('slice')) return [{ label: 'nil slice', value: 'nil' }, { label: 'empty', value: '[]T{}' }, { label: 'single', value: '[]T{v}' }];
    if (t.includes('map')) return [{ label: 'nil map', value: 'nil' }, { label: 'empty', value: 'map[K]V{}' }];
    if (t.includes('bool')) return [{ label: 'true', value: 'true' }, { label: 'false', value: 'false' }];
    return [{ label: 'zero value', value: 'zero value' }];
  }

  generateMocks(deps) {
    return deps.map(dep => {
      const name = (dep.module || dep.name || '').toLowerCase();
      if (/sql|gorm|ent|pgx/.test(name)) return { name: dep.module || dep.name, returnValue: '[]T{}, nil', type: 'database' };
      if (/http|gin|fiber|echo/.test(name)) return { name: dep.module || dep.name, returnValue: '&http.Response{StatusCode: 200}, nil', type: 'http' };
      if (/os|io|bufio/.test(name)) return { name: dep.module || dep.name, returnValue: '"mock content", nil', type: 'filesystem' };
      return { name: dep.module || dep.name, returnValue: 'nil', type: 'generic' };
    });
  }

  buildSearchQuery(error) {
    const parts = ['Go', 'golang'];
    if (error.code) parts.push(error.code);
    if (error.message) parts.push(error.message.slice(0, 60).trim());
    parts.push('fix');
    return parts.join(' ');
  }

  // --- Helpers -----------------------------------------------------------------

  _categorizeError(code, message) {
    const msg = (message || '').toLowerCase();
    if (/syntax|unexpected|parse/.test(msg)) return 'syntax';
    if (/cannot find package|undefined|undeclared|not found/.test(msg)) return 'import';
    if (/type|cannot use|incompatible|cannot convert/.test(msg)) return 'type';
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

module.exports = GoPlugin;
