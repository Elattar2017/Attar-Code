'use strict';

/**
 * plugins/languages/typescript.js — TypeScript/JavaScript language plugin.
 *
 * Strategy resolution: pnpm → bun → yarn → npm
 * Wraps defaults/plugins/typescript.json error catalog.
 * Supports: TypeScript, JavaScript, Node.js, tsc, eslint, vitest, jest.
 *
 * NOTE: This plugin only invokes known safe commands (node --version, tsc --noEmit)
 * through OSAbstraction. No user input is passed to shell commands.
 */

const fs = require('fs');
const path = require('path');
const { LanguagePlugin } = require('../plugin-contract');
const { OSAbstraction } = require('../os-abstraction');
const { VersionResolver, satisfiesMinimum } = require('../version-resolver');

class TypeScriptPlugin extends LanguagePlugin {
  constructor(opts = {}) {
    super({
      id: 'typescript',
      displayName: 'TypeScript',
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
      configFiles: ['package.json', 'tsconfig.json', 'jsconfig.json'],
      ...opts,
    });
    this._versionResolver = new VersionResolver({ proxyUrl: this._proxyUrl });
  }

  detect(projectRoot) {
    return fs.existsSync(path.join(projectRoot, 'package.json')) || fs.existsSync(path.join(projectRoot, 'tsconfig.json'));
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
    if (allDeps.vitest) return { name: 'vitest', command: 'npx vitest run', jsonFlag: '--reporter=json' };
    if (allDeps.jest) return { name: 'jest', command: 'npx jest', jsonFlag: '--json' };
    if (allDeps.mocha) return { name: 'mocha', command: 'npx mocha', jsonFlag: '--reporter json' };
    if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') return { name: 'npm-test', command: this._detectPm(projectRoot) + ' test', jsonFlag: null };
    return null;
  }

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

    if (fs.existsSync(path.join(projectRoot, 'tsconfig.json'))) {
      const tscVer = OSAbstraction.getVersion('npx tsc', '--version', /Version\s+(\d+\.\d+\.\d+)/);
      if (!tscVer) report.warnings.push('tsconfig.json found but TypeScript not installed');
    }

    this._checkFrameworkCompat(projectRoot, report);
    report.ready = report.runtime.installed && report.runtime.compatible;
    return report;
  }

  setupEnvironment(projectRoot) {
    return { steps: [{ action: 'install_deps', command: this._detectPm(projectRoot) + ' install' }], venvPath: null, activateCmd: null };
  }

  async getLatestVersions() {
    const runtime = this.detectVersion();
    const frameworks = await this._versionResolver.resolveAll([
      { registry: 'npm', pkg: 'express' }, { registry: 'npm', pkg: 'next' }, { registry: 'npm', pkg: 'react' },
      { registry: 'npm', pkg: 'typescript' }, { registry: 'npm', pkg: 'vite' }, { registry: 'npm', pkg: 'vitest' },
      { registry: 'npm', pkg: 'jest' }, { registry: 'npm', pkg: 'prisma' }, { registry: 'npm', pkg: 'zod' },
    ]);
    return { runtime: runtime?.version || null, frameworks };
  }

  scaffold(name, opts = {}) {
    const framework = opts.framework || 'express';
    const files = [], deps = {}, devDeps = {}, scripts = {}, postCreate = [];
    const useTs = opts.typescript !== false;

    if (framework === 'express') {
      deps.express = opts.versions?.express || '^5.1.0';
      deps.dotenv = '^16.4.0'; deps.cors = '^2.8.5';
      if (useTs) {
        devDeps.typescript = opts.versions?.typescript || '^5.8.0';
        devDeps['@types/express'] = 'latest'; devDeps['@types/cors'] = 'latest';
        devDeps['ts-node'] = 'latest'; devDeps.nodemon = '^3.1.0';
        files.push({ path: 'tsconfig.json', template: 'tsconfig' }, { path: 'src/index.ts', template: 'express_ts_app' }, { path: 'src/routes/index.ts', template: 'express_ts_routes' });
        scripts.dev = 'nodemon --exec ts-node src/index.ts'; scripts.build = 'tsc'; scripts.start = 'node dist/index.js';
      } else {
        devDeps.nodemon = '^3.1.0';
        files.push({ path: 'src/index.js', template: 'express_js_app' }, { path: 'src/routes/index.js', template: 'express_js_routes' });
        scripts.dev = 'nodemon src/index.js'; scripts.start = 'node src/index.js';
      }
    } else if (framework === 'nextjs') { postCreate.push('npx create-next-app@latest ' + name);
    } else if (framework === 'vite') { postCreate.push('npm create vite@latest ' + name + ' -- --template ' + (useTs ? 'react-ts' : 'react')); }

    return { files, deps, devDeps, scripts, postCreate };
  }

  getSyntaxCheckCommand(files, projectRoot) {
    if (!files || !files.length) return null;
    if (fs.existsSync(path.join(projectRoot, 'tsconfig.json'))) return 'npx tsc --noEmit';
    return files.map(f => 'node --check "' + f + '"').join(' && ');
  }

  getBuildCommand(projectRoot) {
    const pkg = this._readPkg(projectRoot);
    if (pkg?.scripts?.build) return this._detectPm(projectRoot) + ' run build';
    if (fs.existsSync(path.join(projectRoot, 'tsconfig.json'))) return 'npx tsc';
    return null;
  }

  getRunCommand(projectRoot, entryFile) {
    const pkg = this._readPkg(projectRoot); const pm = this._detectPm(projectRoot);
    if (pkg?.scripts?.dev) return pm + ' run dev';
    if (pkg?.scripts?.start) return pm + ' start';
    if (entryFile) return 'node ' + entryFile;
    for (const c of ['src/index.ts', 'src/index.js', 'index.ts', 'index.js', 'app.js', 'server.js']) {
      if (fs.existsSync(path.join(projectRoot, c))) return c.endsWith('.ts') ? 'npx ts-node ' + c : 'node ' + c;
    }
    return 'node index.js';
  }

  getInstallCommand(projectRoot) { return this._detectPm(projectRoot) + ' install'; }

  parseErrors(rawOutput, origin) {
    if (!rawOutput) return [];
    const errors = [];

    // TypeScript: file(line,col): error TSNNNN: message
    const tsRe = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/gm;
    let m;
    while ((m = tsRe.exec(rawOutput)) !== null) {
      errors.push(this._enrichFromCatalog({ file: m[1], line: parseInt(m[2], 10), column: parseInt(m[3], 10), code: m[4], message: m[5].trim(), severity: 'error', category: this._categorizeError(m[4], m[5]), origin: origin || 'compiler', language: 'typescript', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0 }));
    }

    // Node.js runtime fallback
    if (errors.length === 0) {
      const nodeRe = /^(.+\.(?:js|ts|mjs|cjs)):(\d+)\b/gm;
      let lastFile = null, lastLine = null;
      while ((m = nodeRe.exec(rawOutput)) !== null) { lastFile = m[1]; lastLine = parseInt(m[2], 10); }
      const errMatch = rawOutput.match(/^(\w+Error):\s*(.+)$/m);
      if (lastFile && lastLine && errMatch) {
        errors.push(this._enrichFromCatalog({ file: lastFile, line: lastLine, column: null, code: errMatch[1], message: errMatch[1] + ': ' + errMatch[2], severity: 'error', category: this._categorizeError(errMatch[1], errMatch[2]), origin: origin || 'runtime', language: 'typescript', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0 }));
      }
    }
    return errors;
  }

  getCrashPatterns() {
    return [/TypeError:/, /ReferenceError:/, /SyntaxError:/, /RangeError:/, /unhandled\s+promise\s+rejection/i, /ECONNREFUSED/, /EADDRINUSE/, /Cannot find module/];
  }

  getTestCommand(projectRoot, framework) {
    const fw = framework || this.detectTestFramework(projectRoot);
    return fw ? fw.command : null;
  }

  parseTestOutput(raw) {
    const result = { passed: 0, failed: 0, errors: [] };
    if (!raw) return result;
    const p = raw.match(/(\d+)\s+passed/); if (p) result.passed = parseInt(p[1], 10);
    const f = raw.match(/(\d+)\s+failed/); if (f) result.failed = parseInt(f[1], 10);
    const failRe = /FAIL\s+(\S+)/g; let m; while ((m = failRe.exec(raw)) !== null) result.errors.push({ file: m[1] });
    return result;
  }

  analyzeSource(filePath) {
    try { const { analyzeFile } = require('../../smart-fix/file-analyzer'); return analyzeFile(fs.readFileSync(filePath, 'utf-8'), filePath); } catch { return { functions: [], classes: [], imports: [], exports: [] }; }
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
      if (/prisma|sequelize|mongoose|knex|typeorm/.test(name)) return { name: dep.module || dep.rawSource, returnValue: '[]', type: 'database' };
      if (/axios|fetch|got|node-fetch/.test(name)) return { name: dep.module || dep.rawSource, returnValue: '{ status: 200, data: {} }', type: 'http' };
      if (/^fs$|^path$|^fs\/promises/.test(name)) return { name: dep.module || dep.rawSource, returnValue: '"mock content"', type: 'filesystem' };
      if (/nodemailer|sendgrid|resend/.test(name)) return { name: dep.module || dep.rawSource, returnValue: '{ messageId: "mock" }', type: 'email' };
      if (/stripe/.test(name)) return { name: dep.module || dep.rawSource, returnValue: '{ id: "mock_id" }', type: 'payment' };
      return { name: dep.module || dep.rawSource, returnValue: 'jest.fn()', type: 'generic' };
    });
  }

  buildSearchQuery(error) {
    const parts = ['TypeScript']; if (error.code) parts.push(error.code);
    const errType = error.message?.match(/^(\w+Error)/)?.[1]; if (errType) parts.push(errType);
    if (error.message) parts.push(error.message.slice(0, 60).trim()); parts.push('fix');
    return parts.join(' ');
  }

  _readPkg(r) { try { return JSON.parse(fs.readFileSync(path.join(r, 'package.json'), 'utf-8')); } catch { return null; } }
  _detectPm(r) { if (fs.existsSync(path.join(r, 'pnpm-lock.yaml'))) return 'pnpm'; if (fs.existsSync(path.join(r, 'bun.lockb'))) return 'bun'; if (fs.existsSync(path.join(r, 'yarn.lock'))) return 'yarn'; return 'npm'; }
  _categorizeError(code, msg) { const m = (msg || '').toLowerCase(); if (/syntax|parse|unexpected/.test(m)) return 'syntax'; if (/cannot find module|import|require/.test(m)) return 'import'; if (/type|property.*does not exist|not assignable/.test(m)) return 'type'; return 'runtime'; }

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

  _checkFrameworkCompat(projectRoot, report) {
    const pkg = this._readPkg(projectRoot); if (!pkg) return;
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (allDeps.next && report.runtime?.version) {
      const nv = (allDeps.next || '').replace(/[\^~>=<]/g, '');
      if (parseInt(nv, 10) >= 15 && !satisfiesMinimum(report.runtime.version, '18.18.0')) report.warnings.push('Next.js ' + nv + ' requires Node.js 18.18+');
    }
  }
}

module.exports = TypeScriptPlugin;
