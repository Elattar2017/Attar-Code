'use strict';

/**
 * plugins/languages/csharp.js — C# / .NET language plugin.
 *
 * Strategy resolution: dotnet (only option — dotnet CLI handles everything)
 * Wraps defaults/plugins/csharp.json error catalog.
 * Supports: C# 12+ / .NET 8+, dotnet CLI, xUnit, NUnit, MSTest.
 *
 * NOTE: This plugin only invokes known, safe commands (dotnet --version, dotnet build, etc.)
 * through OSAbstraction.exec(). No user input is passed to shell commands.
 */

const fs = require('fs');
const path = require('path');
const { LanguagePlugin } = require('../plugin-contract');
const { OSAbstraction } = require('../os-abstraction');
const { VersionResolver, satisfiesMinimum } = require('../version-resolver');

class CSharpPlugin extends LanguagePlugin {
  constructor(opts = {}) {
    super({
      id: 'csharp',
      displayName: 'C#',
      extensions: ['.cs', '.csx', '.razor'],
      configFiles: ['*.csproj', '*.sln', 'global.json'],
      ...opts,
    });
    this._versionResolver = new VersionResolver({ proxyUrl: this._proxyUrl });
  }

  // ─── Detection ─────────────────────────────────────────────────────────────

  detect(projectRoot) {
    // Check for .sln or .csproj (glob patterns in configFiles require special handling)
    try {
      const entries = fs.readdirSync(projectRoot);
      if (entries.some(f => f.endsWith('.sln'))) return true;
      if (entries.some(f => f.endsWith('.csproj'))) return true;
      if (entries.some(f => f === 'global.json')) return true;
      if (entries.some(f => f.endsWith('.cs'))) return true;
      // Check one level deep for .csproj (common with src/ layout)
      const srcDir = path.join(projectRoot, 'src');
      if (fs.existsSync(srcDir)) {
        const srcEntries = fs.readdirSync(srcDir);
        if (srcEntries.some(f => f.endsWith('.csproj') || f.endsWith('.cs'))) return true;
        // Check subdirectories (e.g., src/MyApp/MyApp.csproj)
        for (const sub of srcEntries) {
          const subPath = path.join(srcDir, sub);
          try {
            if (fs.statSync(subPath).isDirectory()) {
              const subEntries = fs.readdirSync(subPath);
              if (subEntries.some(f => f.endsWith('.csproj'))) return true;
            }
          } catch {}
        }
      }
    } catch {}
    return false;
  }

  detectVersion() {
    const info = OSAbstraction.getVersion('dotnet', '--version', /(\d+\.\d+\.\d+)/);
    if (!info) return null;
    return { version: info.version, path: OSAbstraction.which('dotnet'), source: 'dotnet' };
  }

  detectTestFramework(projectRoot) {
    const csprojFiles = this._findCsprojFiles(projectRoot);
    for (const csproj of csprojFiles) {
      try {
        const content = fs.readFileSync(csproj, 'utf-8');
        if (/xunit/i.test(content)) return { name: 'xunit', command: 'dotnet test', jsonFlag: '--logger "trx"' };
        if (/nunit/i.test(content)) return { name: 'nunit', command: 'dotnet test', jsonFlag: '--logger "trx"' };
        if (/MSTest/i.test(content) || /Microsoft\.VisualStudio\.TestTools/i.test(content)) return { name: 'mstest', command: 'dotnet test', jsonFlag: '--logger "trx"' };
      } catch {}
    }
    // Default: dotnet test works regardless
    return { name: 'dotnet-test', command: 'dotnet test', jsonFlag: '--logger "trx"' };
  }

  /**
   * Detect the project type: ASP.NET Web API, Console, Library, Blazor, MVC.
   * @param {string} projectRoot
   * @returns {'webapi'|'console'|'blazor'|'mvc'|'classlib'|'unknown'}
   */
  _detectProjectType(projectRoot) {
    const csprojFiles = this._findCsprojFiles(projectRoot);
    for (const csproj of csprojFiles) {
      try {
        const content = fs.readFileSync(csproj, 'utf-8');
        if (/Microsoft\.NET\.Sdk\.Web/i.test(content)) {
          if (/Microsoft\.AspNetCore\.Components/i.test(content) || /blazor/i.test(content)) return 'blazor';
          if (/AddControllersWithViews|AddMvc/i.test(content)) return 'mvc';
          return 'webapi';
        }
        if (/<OutputType>Exe<\/OutputType>/i.test(content)) return 'console';
        if (/<OutputType>Library<\/OutputType>/i.test(content)) return 'classlib';
      } catch {}
    }
    // Check Program.cs for web indicators
    const programCs = path.join(projectRoot, 'Program.cs');
    if (fs.existsSync(programCs)) {
      try {
        const content = fs.readFileSync(programCs, 'utf-8');
        if (/WebApplication|MapControllers|MapGet|MapPost/i.test(content)) return 'webapi';
      } catch {}
    }
    return 'unknown';
  }

  /**
   * Find all .csproj files in the project (root + one level deep).
   * @param {string} projectRoot
   * @returns {string[]}
   */
  _findCsprojFiles(projectRoot) {
    const results = [];
    try {
      const entries = fs.readdirSync(projectRoot);
      for (const entry of entries) {
        if (entry.endsWith('.csproj')) results.push(path.join(projectRoot, entry));
      }
      // Check one level deep
      for (const entry of entries) {
        const subPath = path.join(projectRoot, entry);
        try {
          if (fs.statSync(subPath).isDirectory()) {
            const subEntries = fs.readdirSync(subPath);
            for (const sub of subEntries) {
              if (sub.endsWith('.csproj')) results.push(path.join(subPath, sub));
            }
          }
        } catch {}
      }
    } catch {}
    return results;
  }

  // ─── Environment ───────────────────────────────────────────────────────────

  getStrategyOrder() {
    return ['dotnet'];
  }

  checkEnvironment(projectRoot) {
    const report = { ready: false, runtime: null, packageManager: null, virtualEnv: null, missing: [], warnings: [], strategy: null, projectType: null, sdks: [] };

    // Check dotnet SDK
    const ver = this.detectVersion();
    if (!ver) {
      report.runtime = { installed: false, version: null, compatible: false };
      report.missing.push({ tool: 'dotnet', installCmd: OSAbstraction.getInstallHint('dotnet') || 'winget install Microsoft.DotNet.SDK.8' });
      return report;
    }

    report.runtime = { installed: true, version: ver.version, path: ver.path, compatible: satisfiesMinimum(ver.version, '8.0.0'), minVersion: '8.0.0' };
    if (!report.runtime.compatible) report.warnings.push(`dotnet SDK ${ver.version} is below minimum 8.0.0`);

    report.strategy = 'dotnet';
    report.packageManager = { name: 'dotnet/nuget', version: ver.version };

    // List installed SDKs
    try {
      const sdkList = OSAbstraction.exec('dotnet --list-sdks', { timeout: 10000, silent: true }) || '';
      const sdks = sdkList.split(/\r?\n/).filter(Boolean).map(line => {
        const m = line.match(/^(\d+\.\d+\.\d+)/);
        return m ? m[1] : null;
      }).filter(Boolean);
      report.sdks = sdks;
    } catch {}

    // Detect project type
    report.projectType = this._detectProjectType(projectRoot);

    report.ready = report.runtime.installed && report.runtime.compatible;
    return report;
  }

  setupEnvironment(projectRoot) {
    const steps = [];

    // Restore NuGet packages
    const hasCsproj = this._findCsprojFiles(projectRoot).length > 0;
    const hasSln = (() => { try { return fs.readdirSync(projectRoot).some(f => f.endsWith('.sln')); } catch { return false; } })();

    if (hasCsproj || hasSln) {
      steps.push({ action: 'restore', command: 'dotnet restore', success: null });
    }

    return { steps, venvPath: null, activateCmd: null };
  }

  // ─── Scaffolding ───────────────────────────────────────────────────────────

  async getLatestVersions() {
    const runtime = this.detectVersion();
    const frameworks = await this._versionResolver.resolveAll([
      { registry: 'nuget', pkg: 'Microsoft.AspNetCore.App' },
    ]);
    return { runtime: runtime?.version || null, frameworks };
  }

  scaffold(name, opts = {}) {
    const template = opts.framework || 'webapi';
    const files = [], deps = {}, devDeps = {}, scripts = {}, postCreate = [];

    if (template === 'webapi') {
      postCreate.push(`dotnet new webapi -n ${name}`);
      scripts.start = 'dotnet run';
      scripts.build = 'dotnet build';
      scripts.test = 'dotnet test';
    } else if (template === 'console') {
      postCreate.push(`dotnet new console -n ${name}`);
      scripts.start = 'dotnet run';
      scripts.build = 'dotnet build';
      scripts.test = 'dotnet test';
    } else if (template === 'blazor') {
      postCreate.push(`dotnet new blazor -n ${name}`);
      scripts.start = 'dotnet run';
      scripts.build = 'dotnet build';
      scripts.test = 'dotnet test';
    } else if (template === 'mvc') {
      postCreate.push(`dotnet new mvc -n ${name}`);
      scripts.start = 'dotnet run';
      scripts.build = 'dotnet build';
      scripts.test = 'dotnet test';
    } else if (template === 'classlib') {
      postCreate.push(`dotnet new classlib -n ${name}`);
      scripts.build = 'dotnet build';
      scripts.test = 'dotnet test';
    }

    return { files, deps, devDeps, scripts, postCreate };
  }

  // ─── Build & Run ───────────────────────────────────────────────────────────

  getSyntaxCheckCommand(files, projectRoot) {
    // C# compiles, so build = syntax check
    return 'dotnet build --no-restore';
  }

  getBuildCommand(projectRoot) {
    const hasCsproj = this._findCsprojFiles(projectRoot).length > 0;
    const hasSln = (() => { try { return fs.readdirSync(projectRoot).some(f => f.endsWith('.sln')); } catch { return false; } })();
    if (hasCsproj || hasSln) return 'dotnet build';
    return null;
  }

  getRunCommand(projectRoot, entryFile) {
    return 'dotnet run';
  }

  getInstallCommand(projectRoot) {
    return 'dotnet restore';
  }

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
            code: g.code || 'CS_ERROR', message: (g.message || '').trim(), severity: 'error',
            category: this._categorizeError(g.code, g.message), origin: origin || 'compiler',
            language: 'csharp', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0,
          }));
        }
      } catch {}
    }

    // Fallback: MSBuild format — file(line,col): error CSNNNN: message
    if (errors.length === 0) {
      const msbuildRe = /([^(\s]+)\((\d+),(\d+)\):\s*(?:error|warning)\s+(CS\d+):\s*(.+)/gm;
      let m;
      while ((m = msbuildRe.exec(rawOutput)) !== null) {
        errors.push(this._enrichFromCatalog({
          file: m[1], line: parseInt(m[2], 10), column: parseInt(m[3], 10),
          code: m[4], message: m[5].trim(), severity: 'error',
          category: this._categorizeError(m[4], m[5]), origin: origin || 'compiler',
          language: 'csharp', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0,
        }));
      }
    }

    // Fallback: Runtime exceptions
    if (errors.length === 0) {
      const exRe = /Unhandled exception\.\s*(System\.\w+(?:\.\w+)?Exception):\s*(.+)/gm;
      let m;
      while ((m = exRe.exec(rawOutput)) !== null) {
        errors.push(this._enrichFromCatalog({
          file: '', line: 0, column: null,
          code: 'RUNTIME_EXCEPTION', message: `${m[1]}: ${m[2].trim()}`, severity: 'error',
          category: 'runtime', origin: origin || 'runtime',
          language: 'csharp', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0,
        }));
      }
    }

    // Fallback: NuGet restore errors
    if (errors.length === 0) {
      const nugetRe = /error\s+(NU\d+):\s*(.+)/gm;
      let m;
      while ((m = nugetRe.exec(rawOutput)) !== null) {
        errors.push({
          file: '', line: 0, column: null,
          code: m[1], message: m[2].trim(), severity: 'error',
          category: 'dependency', origin: 'compiler',
          language: 'csharp', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0,
        });
      }
    }

    return errors;
  }

  getCrashPatterns() {
    return [
      /Unhandled exception/,
      /System\.\w+Exception/,
      /Stack Trace:/,
      /Process terminated/,
      /StackOverflowException/,
      /OutOfMemoryException/,
      /AccessViolationException/,
    ];
  }

  // ─── Testing ───────────────────────────────────────────────────────────────

  getTestCommand(projectRoot, framework) {
    return 'dotnet test';
  }

  parseTestOutput(raw, framework) {
    const result = { passed: 0, failed: 0, errors: [] };
    if (!raw) return result;

    // dotnet test output: "Passed: 5, Failed: 2, Skipped: 1, Total: 8"
    const pm = raw.match(/Passed:\s*(\d+)/i);
    if (pm) result.passed = parseInt(pm[1], 10);
    const fm = raw.match(/Failed:\s*(\d+)/i);
    if (fm) result.failed = parseInt(fm[1], 10);

    // Alternative: "X passed, Y failed"
    if (!pm && !fm) {
      const altPassed = raw.match(/(\d+)\s+passed/);
      const altFailed = raw.match(/(\d+)\s+failed/);
      if (altPassed) result.passed = parseInt(altPassed[1], 10);
      if (altFailed) result.failed = parseInt(altFailed[1], 10);
    }

    // Collect failed test names
    const failRe = /Failed\s+(\S+)/g;
    let m;
    while ((m = failRe.exec(raw)) !== null) {
      if (!/Failed:/.test(m[0])) { // Skip the summary line
        result.errors.push({ test: m[1] });
      }
    }

    return result;
  }

  getEdgeCases(paramType) {
    const t = (paramType || '').toLowerCase();
    // Check nullable FIRST (C# Nullable<T> or T? syntax)
    if (t.includes('nullable') || t.endsWith('?')) return [{ label: 'null', value: 'null' }, { label: 'value', value: 'value' }];
    if (t.includes('string') || t.includes('str')) return [{ label: 'empty string', value: '""' }, { label: 'null', value: 'null' }, { label: 'string.Empty', value: 'string.Empty' }, { label: 'whitespace', value: '" "' }];
    if (t.includes('int') || t.includes('integer') || t.includes('long')) return [{ label: 'zero', value: '0' }, { label: 'negative', value: '-1' }, { label: 'int.MaxValue', value: 'int.MaxValue' }, { label: 'int.MinValue', value: 'int.MinValue' }];
    if (t.includes('bool') || t.includes('boolean')) return [{ label: 'true', value: 'true' }, { label: 'false', value: 'false' }];
    if (t.includes('list') || t.includes('ienumerable') || t.includes('collection')) return [{ label: 'empty list', value: 'new List<T>()' }, { label: 'null', value: 'null' }];
    if (t.includes('object') || t.includes('class')) return [{ label: 'null', value: 'null' }];
    if (t.includes('double') || t.includes('float') || t.includes('decimal')) return [{ label: 'zero', value: '0.0' }, { label: 'negative', value: '-1.0' }, { label: 'max', value: 'double.MaxValue' }];
    return [{ label: 'null', value: 'null' }];
  }

  generateMocks(deps) {
    return deps.map(dep => {
      const name = (dep.module || dep.name || '').toLowerCase();
      if (/dbcontext|entityframework|ef|database|repository/.test(name)) return { name: dep.module || dep.name, returnValue: 'Mock<DbContext>()', type: 'database' };
      if (/httpclient|http|webclient|restclient/.test(name)) return { name: dep.module || dep.name, returnValue: 'Mock<HttpClient>()', type: 'http' };
      if (/ilogger|logger|logging/.test(name)) return { name: dep.module || dep.name, returnValue: 'Mock<ILogger>()', type: 'logging' };
      if (/iconfiguration|config|appsettings/.test(name)) return { name: dep.module || dep.name, returnValue: 'Mock<IConfiguration>()', type: 'config' };
      if (/imemory|cache|redis/.test(name)) return { name: dep.module || dep.name, returnValue: 'Mock<IMemoryCache>()', type: 'cache' };
      return { name: dep.module || dep.name, returnValue: 'Mock<T>()', type: 'generic' };
    });
  }

  buildSearchQuery(error) {
    const parts = ['C#'];
    // Detect if ASP.NET
    const isAspNet = /asp\.net|microsoft\.aspnetcore|webapi|controller/i.test(error.message || '');
    if (isAspNet) parts[0] = 'ASP.NET';

    if (error.code && error.code !== 'CS_ERROR') parts.push(error.code);
    if (error.message) parts.push(error.message.slice(0, 60).trim());
    parts.push('fix');
    return parts.join(' ');
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  _categorizeError(code, message) {
    const msg = (message || '').toLowerCase();
    const c = (code || '').toUpperCase();

    // CS error codes
    if (/^CS10\d\d/.test(c)) return 'syntax'; // CS1001-CS1099 are syntax errors
    if (/^CS02\d\d/.test(c)) return 'type'; // CS0200-CS0299 are type errors
    if (/^CS0103|^CS0234|^CS0246/.test(c)) return 'import'; // name/namespace not found
    if (/^CS0019|^CS0029/.test(c)) return 'type'; // operator/conversion errors

    // Message-based fallback
    if (/syntax|unexpected|parse/.test(msg)) return 'syntax';
    if (/cannot be found|does not exist|not found/.test(msg)) return 'import';
    if (/cannot convert|type|mismatch|expected/.test(msg)) return 'type';
    if (/null|NullReference/.test(msg)) return 'null';
    return 'runtime';
  }

  _enrichFromCatalog(error) {
    for (const cat of (this.errorCatalog.categories || [])) {
      for (const entry of (cat.errors || [])) {
        if (entry.code && entry.code === error.code) {
          const captures = {};
          if (entry.messagePattern) {
            try {
              const m = error.message.match(new RegExp(entry.messagePattern));
              if (m && entry.captures) entry.captures.forEach((cap, i) => { if (cap.name && m[i + 1]) captures[cap.name] = m[i + 1]; });
            } catch {}
          }
          return { ...error, captures, rootCause: entry.rootCause || null, prescription: entry.prescription || null, fixHint: entry.fixHint || null, baseCrossFileProbability: entry.baseCrossFileProbability || 0 };
        }
        if (!entry.code && entry.messagePattern) {
          try {
            if (new RegExp(entry.messagePattern).test(error.message)) {
              return { ...error, rootCause: entry.rootCause || null, prescription: entry.prescription || null, fixHint: entry.fixHint || null, baseCrossFileProbability: entry.baseCrossFileProbability || 0 };
            }
          } catch {}
        }
      }
    }
    return error;
  }
}

module.exports = CSharpPlugin;
