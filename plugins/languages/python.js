'use strict';

/**
 * plugins/languages/python.js — Python language plugin.
 *
 * Strategy resolution: uv → poetry → pipenv → venv + pip
 * Wraps defaults/plugins/python.json error catalog.
 * Supports: Python 3.8+, pytest, mypy, ruff, pylint, pyright.
 *
 * NOTE: This plugin only invokes known, safe commands (python --version, uv venv, etc.)
 * through OSAbstraction.exec(). No user input is passed to shell commands.
 */

const fs = require('fs');
const path = require('path');
const { LanguagePlugin } = require('../plugin-contract');
const { OSAbstraction } = require('../os-abstraction');
const { VersionResolver, satisfiesMinimum } = require('../version-resolver');

class PythonPlugin extends LanguagePlugin {
  constructor(opts = {}) {
    super({
      id: 'python',
      displayName: 'Python',
      extensions: ['.py', '.pyi', '.pyw'],
      configFiles: ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile'],
      ...opts,
    });
    this._versionResolver = new VersionResolver({ proxyUrl: this._proxyUrl });
  }

  // ─── Detection ─────────────────────────────────────────────────────────────

  detect(projectRoot) {
    if (super.detect(projectRoot)) return true;
    try {
      const entries = fs.readdirSync(projectRoot);
      if (entries.some(f => f.endsWith('.py'))) return true;
      const srcDir = path.join(projectRoot, 'src');
      if (fs.existsSync(srcDir)) {
        return fs.readdirSync(srcDir).some(f => f.endsWith('.py'));
      }
    } catch {}
    return false;
  }

  detectVersion() {
    const binary = OSAbstraction.pythonBinary;
    const info = OSAbstraction.getVersion(binary, '--version', /Python\s+(\d+\.\d+\.\d+)/);
    if (!info) return null;
    return { version: info.version, path: OSAbstraction.which(binary), source: binary };
  }

  detectTestFramework(projectRoot) {
    const pyproject = path.join(projectRoot, 'pyproject.toml');
    if (fs.existsSync(pyproject)) {
      try { if (/\[tool\.pytest/.test(fs.readFileSync(pyproject, 'utf-8'))) return { name: 'pytest', command: 'pytest', jsonFlag: '--json-report' }; } catch {}
    }
    if (fs.existsSync(path.join(projectRoot, 'pytest.ini'))) return { name: 'pytest', command: 'pytest', jsonFlag: '--json-report' };
    if (fs.existsSync(path.join(projectRoot, 'tests'))) return { name: 'pytest', command: 'pytest', jsonFlag: '--json-report' };
    const reqs = path.join(projectRoot, 'requirements.txt');
    if (fs.existsSync(reqs)) {
      try { if (/pytest/.test(fs.readFileSync(reqs, 'utf-8'))) return { name: 'pytest', command: 'pytest', jsonFlag: '--json-report' }; } catch {}
    }
    return { name: 'unittest', command: `${OSAbstraction.pythonBinary} -m unittest discover`, jsonFlag: null };
  }

  // ─── Environment ───────────────────────────────────────────────────────────

  getStrategyOrder() {
    return ['uv', 'poetry', 'pipenv', 'venv'];
  }

  checkEnvironment(projectRoot) {
    const report = { ready: false, runtime: null, packageManager: null, virtualEnv: null, missing: [], warnings: [], strategy: null };

    const ver = this.detectVersion();
    if (!ver) {
      report.runtime = { installed: false, version: null, compatible: false };
      report.missing.push({ tool: OSAbstraction.pythonBinary, installCmd: OSAbstraction.getInstallHint('python') });
      return report;
    }

    report.runtime = { installed: true, version: ver.version, path: ver.path, compatible: satisfiesMinimum(ver.version, '3.8.0'), minVersion: '3.8.0' };
    if (!report.runtime.compatible) report.warnings.push(`Python ${ver.version} is below minimum 3.8.0`);

    // Detect strategy (first available wins)
    for (const strategy of this.getStrategyOrder()) {
      if (strategy === 'venv') {
        report.strategy = 'venv';
        const pipVer = OSAbstraction.getVersion(OSAbstraction.isWin ? 'pip' : 'pip3', '--version', /pip\s+(\d+\.\d+)/);
        report.packageManager = { name: 'pip', version: pipVer?.version || null };
        break;
      }
      if (OSAbstraction.which(strategy)) {
        report.strategy = strategy;
        const vInfo = OSAbstraction.getVersion(strategy);
        report.packageManager = { name: strategy, version: vInfo?.version || 'unknown' };
        break;
      }
    }

    // Check virtual environment
    let venvInfo = OSAbstraction.checkVenv(projectRoot, '.venv');
    if (!venvInfo.exists) venvInfo = OSAbstraction.checkVenv(projectRoot, 'venv');
    report.virtualEnv = { exists: venvInfo.exists, active: !!process.env.VIRTUAL_ENV, path: venvInfo.exists ? venvInfo.path : null, tool: report.strategy };
    if (!venvInfo.exists && !process.env.VIRTUAL_ENV) report.warnings.push('No virtual environment found. Will auto-create on setup.');

    // Framework compatibility
    this._checkFrameworkCompat(projectRoot, report);

    report.ready = report.runtime.installed && report.runtime.compatible;
    return report;
  }

  setupEnvironment(projectRoot) {
    const steps = [];
    const strategy = this._detectStrategy();

    // 1. Create venv
    const venvCheck = OSAbstraction.checkVenv(projectRoot, '.venv');
    let venvPath = null, activateCmd = null;

    if (!venvCheck.exists) {
      const createCmd = strategy === 'uv' ? 'uv venv .venv'
        : strategy === 'poetry' ? 'poetry install'
        : `${OSAbstraction.pythonBinary} -m venv .venv`;
      try {
        OSAbstraction.exec(createCmd, { cwd: projectRoot, timeout: 60000 });
        steps.push({ action: 'create_venv', command: createCmd, success: true });
        venvPath = path.join(projectRoot, '.venv');
      } catch (e) {
        steps.push({ action: 'create_venv', command: createCmd, success: false, error: e.message });
        return { steps, venvPath: null, activateCmd: null };
      }
    } else {
      venvPath = venvCheck.path;
      steps.push({ action: 'venv_exists', path: venvPath, success: true });
    }

    if (venvPath) activateCmd = OSAbstraction.activateVenv(path.relative(projectRoot, venvPath) || '.venv');

    // 2. Install deps
    const depsFile = this._findDepsFile(projectRoot);
    if (depsFile) {
      const installCmd = strategy === 'uv'
        ? (depsFile.endsWith('pyproject.toml') ? 'uv pip install -e .' : 'uv pip install -r requirements.txt')
        : strategy === 'poetry' ? 'poetry install'
        : (depsFile.endsWith('pyproject.toml') ? 'pip install -e .' : 'pip install -r requirements.txt');
      steps.push({ action: 'install_deps', command: activateCmd ? `${activateCmd} && ${installCmd}` : installCmd, depsFile });
    }

    return { steps, venvPath, activateCmd };
  }

  // ─── Scaffolding ───────────────────────────────────────────────────────────

  async getLatestVersions() {
    const runtime = this.detectVersion();
    const frameworks = await this._versionResolver.resolveAll([
      { registry: 'pypi', pkg: 'django' },
      { registry: 'pypi', pkg: 'flask' },
      { registry: 'pypi', pkg: 'fastapi' },
      { registry: 'pypi', pkg: 'uvicorn' },
      { registry: 'pypi', pkg: 'sqlalchemy' },
      { registry: 'pypi', pkg: 'pytest' },
      { registry: 'pypi', pkg: 'pydantic' },
      { registry: 'pypi', pkg: 'requests' },
    ]);
    return { runtime: runtime?.version || null, frameworks };
  }

  scaffold(name, opts = {}) {
    const framework = opts.framework || 'flask';
    const files = [], deps = {}, devDeps = {}, scripts = {}, postCreate = [];
    const py = OSAbstraction.pythonBinary;

    if (framework === 'flask') {
      deps.flask = opts.versions?.flask || '>=3.1.0';
      deps['python-dotenv'] = '>=1.0.0';
      devDeps.pytest = opts.versions?.pytest || '>=8.0.0';
      files.push({ path: 'app.py', template: 'flask_app' }, { path: 'requirements.txt', template: 'requirements' }, { path: '.env.example', template: 'env_example' }, { path: 'tests/__init__.py', template: 'empty' }, { path: 'tests/test_app.py', template: 'flask_test' });
      scripts.start = `${py} app.py`;
      scripts.test = 'pytest --tb=short -q';
    } else if (framework === 'django') {
      deps.django = opts.versions?.django || '>=5.1,<5.2';
      devDeps.pytest = opts.versions?.pytest || '>=8.0.0';
      postCreate.push(`django-admin startproject ${name} .`);
      scripts.start = `${py} manage.py runserver`;
      scripts.test = `${py} manage.py test`;
    } else if (framework === 'fastapi') {
      deps.fastapi = opts.versions?.fastapi || '>=0.115.0';
      deps.uvicorn = opts.versions?.uvicorn || '>=0.34.0';
      deps.pydantic = opts.versions?.pydantic || '>=2.0.0';
      devDeps.pytest = opts.versions?.pytest || '>=8.0.0';
      devDeps.httpx = '>=0.27.0';
      files.push({ path: 'main.py', template: 'fastapi_app' }, { path: 'requirements.txt', template: 'requirements' }, { path: 'tests/__init__.py', template: 'empty' }, { path: 'tests/test_main.py', template: 'fastapi_test' });
      scripts.start = 'uvicorn main:app --reload';
      scripts.test = 'pytest --tb=short -q';
    }

    return { files, deps, devDeps, scripts, postCreate };
  }

  // ─── Build & Run ───────────────────────────────────────────────────────────

  getSyntaxCheckCommand(files, projectRoot) {
    if (!files || files.length === 0) return null;
    const py = OSAbstraction.pythonBinary;
    if (files.length <= 5) return files.map(f => `${py} -m py_compile "${f}"`).join(' && ');
    return `${py} -c "import py_compile,sys;e=0\\nfor f in ${JSON.stringify(files)}:\\n try:py_compile.compile(f,doraise=True)\\n except:e+=1;print(f)\\nsys.exit(e)"`;
  }

  getBuildCommand(projectRoot) {
    if (fs.existsSync(path.join(projectRoot, 'pyproject.toml'))) return `${OSAbstraction.pythonBinary} -m build`;
    return null;
  }

  getRunCommand(projectRoot, entryFile) {
    const py = OSAbstraction.pythonBinary;
    if (entryFile) return `${py} ${entryFile}`;
    for (const c of ['main.py', 'app.py', 'run.py', 'manage.py']) {
      if (fs.existsSync(path.join(projectRoot, c))) return c === 'manage.py' ? `${py} manage.py runserver` : `${py} ${c}`;
    }
    return `${py} main.py`;
  }

  getInstallCommand(projectRoot) {
    const strategy = this._detectStrategy();
    const depsFile = this._findDepsFile(projectRoot);
    if (strategy === 'uv') return depsFile?.endsWith('pyproject.toml') ? 'uv pip install -e .' : 'uv pip install -r requirements.txt';
    if (strategy === 'poetry') return 'poetry install';
    if (strategy === 'pipenv') return 'pipenv install';
    return depsFile?.endsWith('pyproject.toml') ? 'pip install -e .' : 'pip install -r requirements.txt';
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
            code: g.code || 'PY_ERROR', message: (g.message || '').trim(), severity: 'error',
            category: this._categorizeError(g.code, g.message), origin: origin || 'compiler',
            language: 'python', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0,
          }));
        }
      } catch {}
    }

    // Fallback: Python traceback (multi-line)
    if (errors.length === 0) {
      const traceRe = /File "([^"]+)", line (\d+)/g;
      let lastFile = null, lastLine = null, tm;
      while ((tm = traceRe.exec(rawOutput)) !== null) { lastFile = tm[1]; lastLine = parseInt(tm[2], 10); }
      const errMatch = rawOutput.match(/^(\w+Error):\s*(.+)$/m);
      if (lastFile && lastLine && errMatch) {
        errors.push(this._enrichFromCatalog({
          file: lastFile, line: lastLine, column: null,
          code: `PY_${errMatch[1].replace(/Error$/, '').toUpperCase()}_ERROR`,
          message: `${errMatch[1]}: ${errMatch[2]}`, severity: 'error',
          category: this._categorizeError(errMatch[1], errMatch[2]), origin: origin || 'runtime',
          language: 'python', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0,
        }));
      }
    }

    return errors;
  }

  getCrashPatterns() {
    return [/Traceback \(most recent call last\)/, /^\w+Error:/m, /SystemExit/, /Segmentation fault/, /Killed/];
  }

  // ─── Testing ───────────────────────────────────────────────────────────────

  getTestCommand(projectRoot, framework) {
    const fw = framework || this.detectTestFramework(projectRoot);
    if (!fw) return null;
    const venvCheck = OSAbstraction.checkVenv(projectRoot);
    const prefix = venvCheck.exists ? OSAbstraction.activateVenv(path.relative(projectRoot, venvCheck.path) || '.venv') + ' && ' : '';
    return fw.name === 'pytest' ? `${prefix}pytest --tb=short -q` : `${prefix}${OSAbstraction.pythonBinary} -m unittest discover`;
  }

  parseTestOutput(raw, framework) {
    const result = { passed: 0, failed: 0, errors: [] };
    if (!raw) return result;
    const pm = raw.match(/(\d+)\s+passed/); if (pm) result.passed = parseInt(pm[1], 10);
    const fm = raw.match(/(\d+)\s+failed/); if (fm) result.failed = parseInt(fm[1], 10);
    const failRe = /FAILED\s+(\S+)::(\S+)/g;
    let m; while ((m = failRe.exec(raw)) !== null) result.errors.push({ file: m[1], test: m[2] });
    return result;
  }

  analyzeSource(filePath) {
    // Uses Python AST via subprocess — all arguments are known file paths, not user input
    const py = OSAbstraction.pythonBinary;
    const scriptPath = path.join(__dirname, '..', 'helpers', 'python_ast.py');
    // If helper doesn't exist, return empty
    if (!fs.existsSync(scriptPath)) return { functions: [], classes: [], imports: [], exports: [] };
    try {
      const result = OSAbstraction.exec(`${py} "${scriptPath}" "${filePath}"`, { timeout: 10000, silent: true });
      if (result) return JSON.parse(result);
    } catch {}
    return { functions: [], classes: [], imports: [], exports: [] };
  }

  getEdgeCases(paramType) {
    const t = (paramType || '').toLowerCase();
    if (t.includes('str') || t === 'string') return [{ label: 'empty string', value: '""' }, { label: 'whitespace', value: '" \\t\\n"' }, { label: 'very long', value: '"a" * 10000' }, { label: 'unicode', value: '"\\u4f60\\u597d"' }, { label: 'null string', value: '"null"' }];
    if (t.includes('int') || t.includes('float') || t === 'number') return [{ label: 'zero', value: '0' }, { label: 'negative', value: '-1' }, { label: 'large', value: '2**63' }, { label: 'infinity', value: 'float("inf")' }, { label: 'NaN', value: 'float("nan")' }];
    if (t.includes('list') || t.includes('array')) return [{ label: 'empty', value: '[]' }, { label: 'single', value: '[1]' }, { label: 'with None', value: '[None]' }];
    if (t.includes('dict') || t.includes('map')) return [{ label: 'empty', value: '{}' }];
    if (t.includes('bool')) return [{ label: 'True', value: 'True' }, { label: 'False', value: 'False' }];
    if (t.includes('optional') || t.includes('none')) return [{ label: 'None', value: 'None' }];
    return [{ label: 'None', value: 'None' }];
  }

  generateMocks(deps) {
    return deps.map(dep => {
      const name = (dep.module || dep.name || '').toLowerCase();
      if (/sqlalchemy|mongo|db|database|redis/.test(name)) return { name: dep.module, returnValue: '[]', type: 'database' };
      if (/requests|httpx|aiohttp|urllib/.test(name)) return { name: dep.module, returnValue: 'Mock(status_code=200, json=lambda: {})', type: 'http' };
      if (/pathlib|shutil|tempfile/.test(name)) return { name: dep.module, returnValue: '"mock content"', type: 'filesystem' };
      if (/smtp|email|sendgrid/.test(name)) return { name: dep.module, returnValue: '{"message_id": "mock"}', type: 'email' };
      return { name: dep.module, returnValue: 'Mock()', type: 'generic' };
    });
  }

  buildSearchQuery(error) {
    const parts = ['Python'];
    const errType = error.message?.match(/^(\w+Error)/)?.[1];
    if (errType) parts.push(errType);
    else if (error.code) parts.push(error.code);
    if (error.message) parts.push(error.message.slice(0, 60).trim());
    parts.push('fix');
    return parts.join(' ');
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  _detectStrategy() {
    for (const s of this.getStrategyOrder()) {
      if (s === 'venv') return 'venv';
      if (OSAbstraction.which(s)) return s;
    }
    return 'venv';
  }

  _findDepsFile(projectRoot) {
    for (const f of ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile']) {
      if (fs.existsSync(path.join(projectRoot, f))) return f;
    }
    return null;
  }

  _categorizeError(code, message) {
    const msg = (message || '').toLowerCase();
    if (/syntax|parse|indent|tab/.test(msg)) return 'syntax';
    if (/import|module|no module/.test(msg)) return 'import';
    if (/type|expected|incompatible|argument/.test(msg)) return 'type';
    if (/name.*not defined|undefined/.test(msg)) return 'import';
    if (/attribute/.test(msg)) return 'type';
    return 'runtime';
  }

  _enrichFromCatalog(error) {
    for (const cat of (this.errorCatalog.categories || [])) {
      for (const entry of (cat.errors || [])) {
        if (!entry.messagePattern) continue;
        try {
          const re = new RegExp(entry.messagePattern);
          if (re.test(error.message)) {
            const m = error.message.match(re);
            const captures = {};
            if (m && entry.captures) entry.captures.forEach((cap, i) => { if (cap.name && m[i + 1]) captures[cap.name] = m[i + 1]; });
            return { ...error, code: entry.code || error.code, captures, rootCause: entry.rootCause || null, prescription: entry.prescription || null, fixHint: entry.fixHint || null, baseCrossFileProbability: entry.baseCrossFileProbability || 0 };
          }
        } catch {}
      }
    }
    return error;
  }

  _checkFrameworkCompat(projectRoot, report) {
    const reqs = path.join(projectRoot, 'requirements.txt');
    if (!fs.existsSync(reqs)) return;
    try {
      const content = fs.readFileSync(reqs, 'utf-8');
      if (/django/i.test(content) && report.runtime?.version) {
        const dm = content.match(/django[>=<~!]*(\d+)/i);
        if (dm && parseInt(dm[1], 10) >= 5 && !satisfiesMinimum(report.runtime.version, '3.10.0')) {
          report.warnings.push(`Django ${dm[1]} requires Python 3.10+, you have ${report.runtime.version}`);
        }
      }
    } catch {}
  }
}

module.exports = PythonPlugin;
