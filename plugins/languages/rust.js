'use strict';

/**
 * plugins/languages/rust.js — Rust language plugin.
 *
 * Strategy resolution: cargo (only option)
 * Wraps defaults/plugins/rust.json error catalog.
 * Supports: Rust 1.70+, cargo, rustc, clippy.
 *
 * NOTE: This plugin only invokes known safe commands (rustc --version, cargo init)
 * through OSAbstraction. No user input is passed to shell commands.
 */

const fs = require('fs');
const path = require('path');
const { LanguagePlugin } = require('../plugin-contract');
const { OSAbstraction } = require('../os-abstraction');
const { VersionResolver, satisfiesMinimum } = require('../version-resolver');

class RustPlugin extends LanguagePlugin {
  constructor(opts = {}) {
    super({
      id: 'rust',
      displayName: 'Rust',
      extensions: ['.rs'],
      configFiles: ['Cargo.toml'],
      ...opts,
    });
    this._versionResolver = new VersionResolver({ proxyUrl: this._proxyUrl });
  }

  // --- Detection ---------------------------------------------------------------

  detect(projectRoot) {
    if (super.detect(projectRoot)) return true;
    try {
      const entries = fs.readdirSync(projectRoot);
      if (entries.some(f => f.endsWith('.rs'))) return true;
      const srcDir = path.join(projectRoot, 'src');
      if (fs.existsSync(srcDir)) return fs.readdirSync(srcDir).some(f => f.endsWith('.rs'));
    } catch {}
    return false;
  }

  detectVersion() {
    const info = OSAbstraction.getVersion('rustc', '--version', /rustc\s+(\d+\.\d+\.\d+)/);
    if (!info) return null;
    return { version: info.version, path: OSAbstraction.which('rustc'), source: 'rustc' };
  }

  detectTestFramework(projectRoot) {
    if (fs.existsSync(path.join(projectRoot, 'Cargo.toml'))) {
      return { name: 'cargo-test', command: 'cargo test', jsonFlag: '-- -Z unstable-options --format json' };
    }
    return null;
  }

  // --- Environment -------------------------------------------------------------

  getStrategyOrder() { return ['cargo']; }

  checkEnvironment(projectRoot) {
    const report = { ready: false, runtime: null, packageManager: null, virtualEnv: null, missing: [], warnings: [], strategy: null };
    const ver = this.detectVersion();
    if (!ver) {
      report.runtime = { installed: false, version: null, compatible: false };
      report.missing.push({ tool: 'rustc', installCmd: OSAbstraction.getInstallHint('rustc') });
      return report;
    }

    report.runtime = { installed: true, version: ver.version, path: ver.path, compatible: satisfiesMinimum(ver.version, '1.70.0'), minVersion: '1.70.0' };
    if (!report.runtime.compatible) report.warnings.push(`Rust ${ver.version} is below minimum 1.70.0`);

    // Check cargo
    const cargoVer = OSAbstraction.getVersion('cargo', '--version', /cargo\s+(\d+\.\d+\.\d+)/);
    if (cargoVer) {
      report.strategy = 'cargo';
      report.packageManager = { name: 'cargo', version: cargoVer.version };
    } else {
      report.missing.push({ tool: 'cargo', installCmd: OSAbstraction.getInstallHint('cargo') });
    }

    // Check rustup
    const rustupVer = OSAbstraction.getVersion('rustup', '--version', /rustup\s+(\d+\.\d+\.\d+)/);
    if (!rustupVer) report.warnings.push('rustup not found; toolchain management unavailable');

    report.ready = report.runtime.installed && report.runtime.compatible && !!cargoVer;
    return report;
  }

  setupEnvironment(projectRoot) {
    const steps = [];
    if (!fs.existsSync(path.join(projectRoot, 'Cargo.toml'))) {
      steps.push({ action: 'cargo_init', command: 'cargo init' });
    }
    steps.push({ action: 'install_deps', command: 'cargo build' });
    return { steps, venvPath: null, activateCmd: null };
  }

  // --- Scaffolding -------------------------------------------------------------

  async getLatestVersions() {
    const runtime = this.detectVersion();
    const frameworks = await this._versionResolver.resolveAll([
      { registry: 'crates', pkg: 'actix-web' },
      { registry: 'crates', pkg: 'tokio' },
      { registry: 'crates', pkg: 'serde' },
      { registry: 'crates', pkg: 'axum' },
    ]);
    return { runtime: runtime?.version || null, frameworks };
  }

  scaffold(name, opts = {}) {
    const framework = opts.framework || 'actix-web';
    const files = [], deps = {}, devDeps = {}, scripts = {}, postCreate = [];

    postCreate.push('cargo init ' + name);

    if (framework === 'actix-web') {
      deps['actix-web'] = opts.versions?.['actix-web'] || '4';
      deps.tokio = opts.versions?.tokio || '1';
      deps.serde = '1';
      files.push({ path: 'src/main.rs', template: 'actix_web_app' });
      scripts.start = 'cargo run';
      scripts.test = 'cargo test';
    } else if (framework === 'axum') {
      deps.axum = opts.versions?.axum || '0.7';
      deps.tokio = opts.versions?.tokio || '1';
      deps.serde = '1';
      files.push({ path: 'src/main.rs', template: 'axum_app' });
      scripts.start = 'cargo run';
      scripts.test = 'cargo test';
    } else if (framework === 'tokio') {
      deps.tokio = opts.versions?.tokio || '1';
      files.push({ path: 'src/main.rs', template: 'tokio_app' });
      scripts.start = 'cargo run';
      scripts.test = 'cargo test';
    }

    return { files, deps, devDeps, scripts, postCreate };
  }

  // --- Build & Run -------------------------------------------------------------

  getSyntaxCheckCommand(files, projectRoot) {
    if (!files || !files.length) return null;
    return 'cargo check';
  }

  getBuildCommand(projectRoot) {
    if (fs.existsSync(path.join(projectRoot, 'Cargo.toml'))) return 'cargo build';
    return null;
  }

  getRunCommand(projectRoot, entryFile) {
    if (fs.existsSync(path.join(projectRoot, 'Cargo.toml'))) return 'cargo run';
    if (entryFile) return 'rustc ' + entryFile + ' && ./main';
    return 'cargo run';
  }

  getInstallCommand(projectRoot) { return 'cargo build'; }

  parseErrors(rawOutput, origin) {
    if (!rawOutput) return [];
    const errors = [];

    // Use toolchain patterns from JSON catalog
    for (const tc of (this.catalog.metadata?.toolchains || [])) {
      if (!tc.errorFormat) continue;
      try {
        const re = new RegExp(tc.errorFormat, 'gms');
        let m;
        while ((m = re.exec(rawOutput)) !== null) {
          const g = m.groups || {};
          errors.push(this._enrichFromCatalog({
            file: g.file || '', line: parseInt(g.line, 10) || 0, column: parseInt(g.column, 10) || null,
            code: g.code || 'RUST_ERROR', message: (g.message || '').trim(), severity: 'error',
            category: this._categorizeError(g.code, g.message), origin: origin || 'compiler',
            language: 'rust', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0,
          }));
        }
      } catch {}
    }

    // Fallback: simple error line parsing
    if (errors.length === 0) {
      const simpleRe = /error(?:\[(?<code>E\d{4})\])?:\s*(?<message>.+)/gm;
      let m;
      while ((m = simpleRe.exec(rawOutput)) !== null) {
        const g = m.groups || {};
        // Try to find the --> file:line:col on the next line
        const locMatch = rawOutput.slice(m.index).match(/-->\s*([^:]+):(\d+):(\d+)/);
        errors.push(this._enrichFromCatalog({
          file: locMatch?.[1] || '', line: parseInt(locMatch?.[2], 10) || 0, column: parseInt(locMatch?.[3], 10) || null,
          code: g.code || 'RUST_ERROR', message: (g.message || '').trim(), severity: 'error',
          category: this._categorizeError(g.code, g.message), origin: origin || 'compiler',
          language: 'rust', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0,
        }));
      }
    }

    return errors;
  }

  getCrashPatterns() {
    return [/panic!/, /thread .* panicked/, /stack overflow/, /segfault/, /SIGSEGV/, /process didn't exit successfully/];
  }

  // --- Testing -----------------------------------------------------------------

  getTestCommand(projectRoot, framework) {
    return 'cargo test';
  }

  parseTestOutput(raw) {
    const result = { passed: 0, failed: 0, errors: [] };
    if (!raw) return result;
    const pm = raw.match(/(\d+)\s+passed/); if (pm) result.passed = parseInt(pm[1], 10);
    const fm = raw.match(/(\d+)\s+failed/); if (fm) result.failed = parseInt(fm[1], 10);
    const failRe = /---- (\S+) stdout ----/g;
    let m; while ((m = failRe.exec(raw)) !== null) result.errors.push({ test: m[1] });
    return result;
  }

  getEdgeCases(paramType) {
    const t = (paramType || '').toLowerCase();
    if (t.includes('option') || t.includes('Option<')) return [{ label: 'None', value: 'None' }, { label: 'Some', value: 'Some(value)' }];
    if (t.includes('result') || t.includes('Result<')) return [{ label: 'Ok', value: 'Ok(value)' }, { label: 'Err', value: 'Err(error)' }];
    if (t.includes('&str') || t.includes('string')) return [{ label: 'empty', value: '""' }, { label: 'whitespace', value: '" "' }, { label: 'long', value: '"a".repeat(10000)' }];
    if (t.includes('i32') || t.includes('i64') || t.includes('int') || t.includes('usize')) return [{ label: 'zero', value: '0' }, { label: 'negative', value: '-1' }, { label: 'max', value: 'i32::MAX' }];
    if (t.includes('vec') || t.includes('Vec<')) return [{ label: 'empty', value: 'vec![]' }, { label: 'single', value: 'vec![1]' }];
    if (t.includes('bool')) return [{ label: 'true', value: 'true' }, { label: 'false', value: 'false' }];
    return [{ label: 'default', value: 'Default::default()' }];
  }

  generateMocks(deps) {
    return deps.map(dep => {
      const name = (dep.module || dep.name || '').toLowerCase();
      if (/sqlx|diesel|sea-orm|rusqlite/.test(name)) return { name: dep.module || dep.name, returnValue: 'vec![]', type: 'database' };
      if (/reqwest|hyper|surf/.test(name)) return { name: dep.module || dep.name, returnValue: 'Ok(Response::new())', type: 'http' };
      if (/tokio::fs|std::fs/.test(name)) return { name: dep.module || dep.name, returnValue: '"mock content".to_string()', type: 'filesystem' };
      if (/lettre|email/.test(name)) return { name: dep.module || dep.name, returnValue: 'Ok(())', type: 'email' };
      return { name: dep.module || dep.name, returnValue: 'Default::default()', type: 'generic' };
    });
  }

  buildSearchQuery(error) {
    const parts = ['Rust'];
    if (error.code) parts.push(error.code);
    if (error.message) parts.push(error.message.slice(0, 60).trim());
    parts.push('fix');
    return parts.join(' ');
  }

  // --- Helpers -----------------------------------------------------------------

  _categorizeError(code, message) {
    const msg = (message || '').toLowerCase();
    if (/syntax|unexpected|parse/.test(msg)) return 'syntax';
    if (/cannot find|unresolved|not found in/.test(msg)) return 'import';
    if (/type|mismatch|expected|mismatched/.test(msg)) return 'type';
    if (/borrow|lifetime|move|ownership/.test(msg)) return 'borrow';
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

module.exports = RustPlugin;
