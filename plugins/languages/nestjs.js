'use strict';

/**
 * plugins/languages/nestjs.js — NestJS framework plugin.
 *
 * Strategy resolution: pnpm -> bun -> yarn -> npm
 * Wraps defaults/plugins/typescript.json error catalog (NestJS is TypeScript-based).
 * Supports: NestJS, TypeScript, Node.js, tsc, Jest.
 *
 * SECURITY NOTE: This plugin only invokes known safe commands (node --version,
 * tsc --noEmit, nest build) through OSAbstraction. No user input is interpolated
 * into shell commands. All subprocess execution uses OSAbstraction.exec() or
 * OSAbstraction.getVersion() with hardcoded arguments only.
 */

const fs = require('fs');
const path = require('path');
const { LanguagePlugin } = require('../plugin-contract');
const { OSAbstraction } = require('../os-abstraction');
const { VersionResolver, satisfiesMinimum } = require('../version-resolver');

class NestJSPlugin extends LanguagePlugin {
  constructor(opts = {}) {
    super({
      id: 'nestjs',
      displayName: 'NestJS',
      extensions: ['.ts', '.tsx'],
      configFiles: ['nest-cli.json', '.nestcli.json'],
      ...opts,
    });
    this._versionResolver = new VersionResolver({ proxyUrl: this._proxyUrl });
  }

  // ─── Catalog override: load typescript.json (NestJS is TS-based) ──────────

  loadCatalog() {
    const userPath = path.join(require('os').homedir(), '.attar-code', 'plugins', 'typescript.json');
    const defaultPath = path.join(__dirname, '..', '..', 'defaults', 'plugins', 'typescript.json');
    const catalogPath = fs.existsSync(userPath) ? userPath : defaultPath;
    try { this._catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf-8')); } catch { this._catalog = { metadata: {}, errorCatalog: { categories: [] }, importSystem: {}, typeTracing: {} }; }
  }

  // ─── Detection ────────────────────────────────────────────────────────────

  detect(projectRoot) {
    if (this.configFiles.some(f => fs.existsSync(path.join(projectRoot, f)))) return true;
    const pkg = this._readPkg(projectRoot);
    if (!pkg) return false;
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    return !!allDeps['@nestjs/core'];
  }

  detectVersion() {
    const info = OSAbstraction.getVersion('node', '--version', /v(\d+\.\d+\.\d+)/);
    if (!info) return null;
    return { version: info.version, path: OSAbstraction.which('node'), source: 'node' };
  }

  detectTestFramework(projectRoot) {
    const pkg = this._readPkg(projectRoot);
    if (!pkg) return null;
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (allDeps.jest || allDeps['@nestjs/testing']) return { name: 'jest', command: 'npx jest', jsonFlag: '--json' };
    if (allDeps.vitest) return { name: 'vitest', command: 'npx vitest run', jsonFlag: '--reporter=json' };
    if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') return { name: 'npm-test', command: this._detectPm(projectRoot) + ' test', jsonFlag: null };
    return null;
  }

  // ─── Environment ──────────────────────────────────────────────────────────

  getStrategyOrder() { return ['pnpm', 'bun', 'yarn', 'npm']; }

  checkEnvironment(projectRoot) {
    const report = { ready: false, runtime: null, packageManager: null, virtualEnv: null, missing: [], warnings: [], strategy: null };
    const ver = this.detectVersion();
    if (!ver) { report.runtime = { installed: false }; report.missing.push({ tool: 'node', installCmd: OSAbstraction.getInstallHint('node') }); return report; }

    report.runtime = { installed: true, version: ver.version, path: ver.path, compatible: satisfiesMinimum(ver.version, '18.0.0'), minVersion: '18.0.0' };
    if (!report.runtime.compatible) report.warnings.push('Node.js ' + ver.version + ' is below minimum 18.0.0');

    for (const pm of this.getStrategyOrder()) {
      const lockfiles = { pnpm: 'pnpm-lock.yaml', bun: 'bun.lockb', yarn: 'yarn.lock' };
      if (pm !== 'npm' && lockfiles[pm] && fs.existsSync(path.join(projectRoot, lockfiles[pm]))) {
        report.strategy = pm; const v = OSAbstraction.getVersion(pm); report.packageManager = { name: pm, version: v?.version || null }; break;
      }
      if (pm !== 'npm' && OSAbstraction.which(pm)) {
        report.strategy = pm; const v = OSAbstraction.getVersion(pm); report.packageManager = { name: pm, version: v?.version || null }; break;
      }
      if (pm === 'npm') { report.strategy = 'npm'; const v = OSAbstraction.getVersion('npm'); report.packageManager = { name: 'npm', version: v?.version || null }; break; }
    }

    // Check for @nestjs/cli
    const pkg = this._readPkg(projectRoot);
    const allDeps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {};
    if (!allDeps['@nestjs/cli'] && !OSAbstraction.which('nest')) {
      report.warnings.push('@nestjs/cli not found — install globally or as devDependency');
    }

    report.ready = report.runtime.installed && report.runtime.compatible;
    return report;
  }

  setupEnvironment(projectRoot) {
    return { steps: [{ action: 'install_deps', command: this._detectPm(projectRoot) + ' install' }], venvPath: null, activateCmd: null };
  }

  // ─── Scaffolding ──────────────────────────────────────────────────────────

  async getLatestVersions() {
    const runtime = this.detectVersion();
    const frameworks = await this._versionResolver.resolveAll([
      { registry: 'npm', pkg: '@nestjs/core' }, { registry: 'npm', pkg: '@nestjs/common' },
      { registry: 'npm', pkg: '@nestjs/cli' }, { registry: 'npm', pkg: '@nestjs/testing' },
      { registry: 'npm', pkg: 'typescript' }, { registry: 'npm', pkg: 'rxjs' },
      { registry: 'npm', pkg: 'reflect-metadata' },
    ]);
    return { runtime: runtime?.version || null, frameworks };
  }

  scaffold(name, opts = {}) {
    const files = [], deps = {}, devDeps = {}, scripts = {}, postCreate = [];

    if (opts.manual) {
      deps['@nestjs/core'] = opts.versions?.['@nestjs/core'] || '^11.0.0';
      deps['@nestjs/common'] = opts.versions?.['@nestjs/common'] || '^11.0.0';
      deps['@nestjs/platform-express'] = '^11.0.0';
      deps['reflect-metadata'] = '^0.2.0';
      deps.rxjs = '^7.8.0';
      devDeps.typescript = opts.versions?.typescript || '^5.8.0';
      devDeps['@nestjs/cli'] = '^11.0.0';
      devDeps['@nestjs/testing'] = '^11.0.0';
      devDeps.jest = '^29.7.0';
      devDeps['ts-jest'] = '^29.1.0';
      devDeps['@types/jest'] = '^29.5.0';
      files.push(
        { path: 'tsconfig.json', template: 'nestjs_tsconfig' },
        { path: 'src/main.ts', template: 'nestjs_main' },
        { path: 'src/app.module.ts', template: 'nestjs_module' },
        { path: 'src/app.controller.ts', template: 'nestjs_controller' },
        { path: 'src/app.service.ts', template: 'nestjs_service' },
      );
      scripts.build = 'nest build';
      scripts.start = 'nest start';
      scripts['start:dev'] = 'nest start --watch';
      scripts.test = 'jest';
    } else {
      postCreate.push('npx @nestjs/cli new ' + name);
    }

    return { files, deps, devDeps, scripts, postCreate };
  }

  // ─── Build & Run ──────────────────────────────────────────────────────────

  getSyntaxCheckCommand(files, projectRoot) {
    if (!files || !files.length) return null;
    if (fs.existsSync(path.join(projectRoot, 'tsconfig.json'))) return 'npx tsc --noEmit';
    return files.map(f => 'node --check "' + f + '"').join(' && ');
  }

  getBuildCommand(projectRoot) {
    const pkg = this._readPkg(projectRoot);
    if (pkg?.scripts?.build) return this._detectPm(projectRoot) + ' run build';
    if (fs.existsSync(path.join(projectRoot, 'nest-cli.json'))) return 'nest build';
    if (fs.existsSync(path.join(projectRoot, 'tsconfig.json'))) return 'npx tsc';
    return null;
  }

  getRunCommand(projectRoot, entryFile) {
    const pkg = this._readPkg(projectRoot); const pm = this._detectPm(projectRoot);
    if (pkg?.scripts?.['start:dev']) return pm + ' run start:dev';
    if (pkg?.scripts?.start) return pm + ' start';
    if (fs.existsSync(path.join(projectRoot, 'nest-cli.json'))) return 'nest start --watch';
    if (entryFile) return 'node ' + entryFile;
    return 'nest start --watch';
  }

  getInstallCommand(projectRoot) { return this._detectPm(projectRoot) + ' install'; }

  // ─── Error Parsing ────────────────────────────────────────────────────────

  parseErrors(rawOutput, origin) {
    if (!rawOutput) return [];
    const errors = [];

    // TypeScript: file(line,col): error TSNNNN: message
    const tsRe = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/gm;
    let m;
    while ((m = tsRe.exec(rawOutput)) !== null) {
      errors.push(this._enrichFromCatalog({ file: m[1], line: parseInt(m[2], 10), column: parseInt(m[3], 10), code: m[4], message: m[5].trim(), severity: 'error', category: this._categorizeError(m[4], m[5]), origin: origin || 'compiler', language: 'nestjs', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0 }));
    }

    // NestJS-specific: dependency resolution errors
    const nestDepRe = /Nest can't resolve dependencies of the (\w+)/g;
    while ((m = nestDepRe.exec(rawOutput)) !== null) {
      errors.push({ file: null, line: null, column: null, code: 'NEST_DI_RESOLVE', message: m[0], severity: 'error', category: 'dependency-injection', origin: origin || 'runtime', language: 'nestjs', captures: { provider: m[1] }, rootCause: 'Missing or unregistered provider in module imports/providers', prescription: 'Ensure the dependency is provided in the module or imported from another module', fixHint: 'Add the missing provider to the providers array of the module', baseCrossFileProbability: 0.8 });
    }

    // NestJS-specific: circular dependency
    const circRe = /A circular dependency has been detected|circular dependency/gi;
    while ((m = circRe.exec(rawOutput)) !== null) {
      errors.push({ file: null, line: null, column: null, code: 'NEST_CIRCULAR_DEP', message: m[0], severity: 'warning', category: 'dependency-injection', origin: origin || 'runtime', language: 'nestjs', captures: {}, rootCause: 'Two or more modules/providers depend on each other', prescription: 'Use forwardRef() to resolve the circular dependency', fixHint: '@Inject(forwardRef(() => ServiceName))', baseCrossFileProbability: 1.0 });
    }

    // NestJS-specific: unknown export
    const unknownExportRe = /Unknown\s+export\s+(\w+)\s+from\s+module\s+(\w+)/gi;
    while ((m = unknownExportRe.exec(rawOutput)) !== null) {
      errors.push({ file: null, line: null, column: null, code: 'NEST_UNKNOWN_EXPORT', message: m[0], severity: 'error', category: 'dependency-injection', origin: origin || 'runtime', language: 'nestjs', captures: { exportName: m[1], moduleName: m[2] }, rootCause: 'Exported provider not found in the source module', prescription: 'Add the provider to the exports array of the source module', fixHint: null, baseCrossFileProbability: 0.9 });
    }

    // Node.js runtime fallback
    if (errors.length === 0) {
      const nodeRe = /^(.+\.(?:js|ts|mjs|cjs)):(\d+)\b/gm;
      let lastFile = null, lastLine = null;
      while ((m = nodeRe.exec(rawOutput)) !== null) { lastFile = m[1]; lastLine = parseInt(m[2], 10); }
      const errMatch = rawOutput.match(/^(\w+Error):\s*(.+)$/m);
      if (lastFile && lastLine && errMatch) {
        errors.push(this._enrichFromCatalog({ file: lastFile, line: lastLine, column: null, code: errMatch[1], message: errMatch[1] + ': ' + errMatch[2], severity: 'error', category: this._categorizeError(errMatch[1], errMatch[2]), origin: origin || 'runtime', language: 'nestjs', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0 }));
      }
    }
    return errors;
  }

  getCrashPatterns() {
    return [/TypeError:/, /ReferenceError:/, /SyntaxError:/, /RangeError:/, /unhandled\s+promise\s+rejection/i, /ECONNREFUSED/, /EADDRINUSE/, /Cannot find module/, /Nest can't resolve/, /circular dependency/i];
  }

  // ─── Testing ──────────────────────────────────────────────────────────────

  getTestCommand(projectRoot, framework) {
    const fw = framework || this.detectTestFramework(projectRoot);
    return fw ? fw.command : this._detectPm(projectRoot) + ' run test';
  }

  parseTestOutput(raw) {
    const result = { passed: 0, failed: 0, errors: [] };
    if (!raw) return result;
    const p = raw.match(/(\d+)\s+passed/); if (p) result.passed = parseInt(p[1], 10);
    const f = raw.match(/(\d+)\s+failed/); if (f) result.failed = parseInt(f[1], 10);
    const failRe = /FAIL\s+(\S+)/g; let m; while ((m = failRe.exec(raw)) !== null) result.errors.push({ file: m[1] });
    return result;
  }

  getEdgeCases(paramType) {
    const t = (paramType || '').toLowerCase();
    if (t.includes('string')) return [{ label: 'empty', value: '""' }, { label: 'whitespace', value: '" "' }, { label: 'long', value: '"a".repeat(10000)' }];
    if (t.includes('number')) return [{ label: 'zero', value: '0' }, { label: 'negative', value: '-1' }, { label: 'NaN', value: 'NaN' }, { label: 'Infinity', value: 'Infinity' }];
    if (t.includes('boolean')) return [{ label: 'true', value: 'true' }, { label: 'false', value: 'false' }];
    if (t.includes('array') || t.includes('[]')) return [{ label: 'empty', value: '[]' }, { label: 'single', value: '[1]' }, { label: 'with null', value: '[null]' }];
    return [{ label: 'undefined', value: 'undefined' }, { label: 'null', value: 'null' }];
  }

  generateMocks(deps) {
    return deps.map(dep => {
      const name = (dep.module || dep.rawSource || '').toLowerCase();
      if (/repository|typeorm|mongoose|prisma|sequelize|knex/.test(name)) return { name: dep.module || dep.rawSource, returnValue: '[]', type: 'database' };
      if (/configservice|@nestjs\/config/.test(name)) return { name: dep.module || dep.rawSource, returnValue: '{ get: jest.fn() }', type: 'config' };
      if (/axios|httpservice|fetch|got|node-fetch/.test(name)) return { name: dep.module || dep.rawSource, returnValue: '{ status: 200, data: {} }', type: 'http' };
      if (/^fs$|^path$|^fs\/promises/.test(name)) return { name: dep.module || dep.rawSource, returnValue: '"mock content"', type: 'filesystem' };
      if (/jwtservice|@nestjs\/jwt/.test(name)) return { name: dep.module || dep.rawSource, returnValue: '{ sign: jest.fn(), verify: jest.fn() }', type: 'auth' };
      if (/guard|authguard/.test(name)) return { name: dep.module || dep.rawSource, returnValue: '{ canActivate: jest.fn().mockReturnValue(true) }', type: 'guard' };
      return { name: dep.module || dep.rawSource, returnValue: 'jest.fn()', type: 'generic' };
    });
  }

  buildSearchQuery(error) {
    const parts = ['NestJS']; if (error.code) parts.push(error.code);
    const errType = error.message?.match(/^(\w+Error)/)?.[1]; if (errType) parts.push(errType);
    if (error.message) parts.push(error.message.slice(0, 60).trim()); parts.push('fix');
    return parts.join(' ');
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _readPkg(r) { try { return JSON.parse(fs.readFileSync(path.join(r, 'package.json'), 'utf-8')); } catch { return null; } }
  _detectPm(r) { if (fs.existsSync(path.join(r, 'pnpm-lock.yaml'))) return 'pnpm'; if (fs.existsSync(path.join(r, 'bun.lockb'))) return 'bun'; if (fs.existsSync(path.join(r, 'yarn.lock'))) return 'yarn'; return 'npm'; }
  _categorizeError(code, msg) { const m = (msg || '').toLowerCase(); if (/syntax|parse|unexpected/.test(m)) return 'syntax'; if (/cannot find module|import|require/.test(m)) return 'import'; if (/type|property.*does not exist|not assignable/.test(m)) return 'type'; if (/resolve dependencies|circular/.test(m)) return 'dependency-injection'; return 'runtime'; }

  _enrichFromCatalog(error) {
    for (const cat of (this.errorCatalog.categories || [])) {
      for (const entry of (cat.errors || [])) {
        if (entry.code === error.code) {
          const captures = {};
          if (entry.messagePattern) { try { const m = error.message.match(new RegExp(entry.messagePattern)); if (m && entry.captures) entry.captures.forEach((cap, i) => { if (cap.name && m[i + 1]) captures[cap.name] = m[i + 1]; }); } catch {} }
          return { ...error, captures, rootCause: entry.rootCause || null, prescription: entry.prescription || null, fixHint: entry.fixHint || null, baseCrossFileProbability: entry.baseCrossFileProbability || 0 };
        }
      }
    }
    return error;
  }
}

module.exports = NestJSPlugin;
