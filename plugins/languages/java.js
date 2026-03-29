'use strict';

/**
 * plugins/languages/java.js — Java/Kotlin language plugin.
 *
 * Strategy resolution: gradle -> maven (first available wins)
 * Wraps defaults/plugins/java.json error catalog.
 * Supports: Java 17+, Kotlin, Gradle, Maven, Spring Boot, JUnit.
 *
 * NOTE: This plugin only invokes known safe commands (java -version, gradle --version)
 * through OSAbstraction. No user input is passed to shell commands.
 */

const fs = require('fs');
const path = require('path');
const { LanguagePlugin } = require('../plugin-contract');
const { OSAbstraction } = require('../os-abstraction');
const { VersionResolver, satisfiesMinimum } = require('../version-resolver');

class JavaPlugin extends LanguagePlugin {
  constructor(opts = {}) {
    super({
      id: 'java',
      displayName: 'Java',
      extensions: ['.java', '.kt'],
      configFiles: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
      ...opts,
    });
    this._versionResolver = new VersionResolver({ proxyUrl: this._proxyUrl });
  }

  // --- Detection ---------------------------------------------------------------

  detect(projectRoot) {
    if (super.detect(projectRoot)) return true;
    try {
      const entries = fs.readdirSync(projectRoot);
      if (entries.some(f => f.endsWith('.java') || f.endsWith('.kt'))) return true;
      const srcDir = path.join(projectRoot, 'src');
      if (fs.existsSync(srcDir)) return this._hasJavaFiles(srcDir);
    } catch {}
    return false;
  }

  detectVersion() {
    // java -version outputs to stderr: 'java version "21.0.1"' or 'openjdk version "17.0.9"'
    const info = OSAbstraction.getVersion('java', '-version 2>&1', /version\s+"(\d+[\d.]*)"/);
    if (!info) return null;
    return { version: info.version, path: OSAbstraction.which('java'), source: 'java' };
  }

  detectTestFramework(projectRoot) {
    const isGradle = this._isGradle(projectRoot);
    const isMaven = fs.existsSync(path.join(projectRoot, 'pom.xml'));
    if (isGradle) return { name: 'junit', command: this._gradleCmd(projectRoot) + ' test', jsonFlag: null };
    if (isMaven) return { name: 'junit', command: 'mvn test', jsonFlag: null };
    return null;
  }

  // --- Environment -------------------------------------------------------------

  getStrategyOrder() { return ['gradle', 'maven']; }

  checkEnvironment(projectRoot) {
    const report = { ready: false, runtime: null, packageManager: null, virtualEnv: null, missing: [], warnings: [], strategy: null };
    const ver = this.detectVersion();
    if (!ver) {
      report.runtime = { installed: false, version: null, compatible: false };
      report.missing.push({ tool: 'java', installCmd: OSAbstraction.getInstallHint('java') });
      return report;
    }

    report.runtime = { installed: true, version: ver.version, path: ver.path, compatible: satisfiesMinimum(ver.version, '17.0.0'), minVersion: '17.0.0' };
    if (!report.runtime.compatible) report.warnings.push('Java ' + ver.version + ' is below minimum 17.0.0');

    // Check javac
    const javacVer = OSAbstraction.getVersion('javac', '-version 2>&1', /javac\s+(\d+[\d.]*)/);
    if (!javacVer) report.warnings.push('javac not found; JDK may not be installed (only JRE)');

    // Check JAVA_HOME
    if (!process.env.JAVA_HOME) report.warnings.push('JAVA_HOME not set');

    // Detect build tool strategy (first available wins)
    for (const strategy of this.getStrategyOrder()) {
      if (strategy === 'gradle' && this._isGradle(projectRoot)) {
        report.strategy = 'gradle';
        const gVer = OSAbstraction.getVersion(this._gradleCmd(projectRoot), '--version', /Gradle\s+(\d+\.\d+[\d.]*)/);
        report.packageManager = { name: 'gradle', version: gVer?.version || null };
        break;
      }
      if (strategy === 'maven' && fs.existsSync(path.join(projectRoot, 'pom.xml'))) {
        report.strategy = 'maven';
        const mvnVer = OSAbstraction.getVersion('mvn', '--version', /Maven\s+(\d+\.\d+[\d.]*)/);
        if (mvnVer) {
          report.packageManager = { name: 'maven', version: mvnVer.version };
        } else {
          report.missing.push({ tool: 'mvn', installCmd: OSAbstraction.getInstallHint('mvn') });
        }
        break;
      }
    }

    // If no build file found, check for gradle/maven binaries
    if (!report.strategy) {
      if (OSAbstraction.which('gradle') || OSAbstraction.which('gradlew')) {
        report.strategy = 'gradle';
        report.packageManager = { name: 'gradle', version: null };
      } else if (OSAbstraction.which('mvn')) {
        report.strategy = 'maven';
        report.packageManager = { name: 'maven', version: null };
      } else {
        report.missing.push({ tool: 'gradle', installCmd: OSAbstraction.getInstallHint('gradle') });
      }
    }

    report.ready = report.runtime.installed && report.runtime.compatible;
    return report;
  }

  setupEnvironment(projectRoot) {
    const steps = [];
    const strategy = this._detectStrategy(projectRoot);
    if (strategy === 'gradle') {
      steps.push({ action: 'install_deps', command: this._gradleCmd(projectRoot) + ' build' });
    } else if (strategy === 'maven') {
      steps.push({ action: 'install_deps', command: 'mvn install -DskipTests' });
    }
    return { steps, venvPath: null, activateCmd: null };
  }

  // --- Scaffolding -------------------------------------------------------------

  async getLatestVersions() {
    const runtime = this.detectVersion();
    const frameworks = await this._versionResolver.resolveAll([
      { registry: 'maven', pkg: 'spring-boot-starter-web', opts: { group: 'org.springframework.boot', artifact: 'spring-boot-starter-web' } },
    ]);
    return { runtime: runtime?.version || null, frameworks };
  }

  scaffold(name, opts = {}) {
    const framework = opts.framework || 'spring-boot';
    const buildTool = opts.buildTool || 'gradle';
    const files = [], deps = {}, devDeps = {}, scripts = {}, postCreate = [];

    if (framework === 'spring-boot') {
      deps['org.springframework.boot:spring-boot-starter-web'] = opts.versions?.['spring-boot'] || '3.3.0';
      devDeps['org.springframework.boot:spring-boot-starter-test'] = opts.versions?.['spring-boot'] || '3.3.0';

      if (buildTool === 'maven') {
        files.push({ path: 'pom.xml', template: 'spring_boot_pom' });
        scripts.start = 'mvn spring-boot:run';
        scripts.test = 'mvn test';
        scripts.build = 'mvn package -DskipTests';
      } else {
        files.push({ path: 'build.gradle', template: 'spring_boot_gradle' });
        scripts.start = './gradlew bootRun';
        scripts.test = './gradlew test';
        scripts.build = './gradlew build -x test';
      }

      files.push(
        { path: 'src/main/java/com/example/' + name + '/Application.java', template: 'spring_boot_app' },
        { path: 'src/main/java/com/example/' + name + '/controller/HelloController.java', template: 'spring_boot_controller' },
        { path: 'src/main/resources/application.properties', template: 'spring_boot_properties' },
        { path: 'src/test/java/com/example/' + name + '/ApplicationTests.java', template: 'spring_boot_test' }
      );
    }

    return { files, deps, devDeps, scripts, postCreate };
  }

  // --- Build & Run -------------------------------------------------------------

  getSyntaxCheckCommand(files, projectRoot) {
    if (!files || !files.length) return null;
    const javaFiles = files.filter(f => f.endsWith('.java'));
    if (javaFiles.length === 0) return null;
    return 'javac -d /dev/null ' + javaFiles.map(f => '"' + f + '"').join(' ');
  }

  getBuildCommand(projectRoot) {
    const strategy = this._detectStrategy(projectRoot);
    if (strategy === 'gradle') return this._gradleCmd(projectRoot) + ' build';
    if (strategy === 'maven') return 'mvn package -DskipTests';
    return null;
  }

  getRunCommand(projectRoot, entryFile) {
    const strategy = this._detectStrategy(projectRoot);
    if (strategy === 'gradle') {
      try {
        const buildFile = this._readGradleFile(projectRoot);
        if (buildFile && /spring-boot/.test(buildFile)) return this._gradleCmd(projectRoot) + ' bootRun';
      } catch {}
      return this._gradleCmd(projectRoot) + ' run';
    }
    if (strategy === 'maven') {
      const pom = path.join(projectRoot, 'pom.xml');
      try { if (/spring-boot/.test(fs.readFileSync(pom, 'utf-8'))) return 'mvn spring-boot:run'; } catch {}
      return 'mvn exec:java';
    }
    if (entryFile) return 'java ' + entryFile;
    return 'java -jar target/*.jar';
  }

  getInstallCommand(projectRoot) {
    const strategy = this._detectStrategy(projectRoot);
    if (strategy === 'gradle') return this._gradleCmd(projectRoot) + ' dependencies';
    if (strategy === 'maven') return 'mvn install -DskipTests';
    return null;
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
            code: g.code || 'JAVA_ERROR', message: (g.message || '').trim(), severity: 'error',
            category: this._categorizeError(g.code, g.message), origin: origin || 'compiler',
            language: 'java', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0,
          }));
        }
      } catch {}
    }

    // Fallback: file.java:line: error: message
    if (errors.length === 0) {
      const javaRe = /([^\s:]+\.(?:java|kt)):(\d+):\s*(?:error:\s*)?(.+)/gm;
      let m;
      while ((m = javaRe.exec(rawOutput)) !== null) {
        errors.push(this._enrichFromCatalog({
          file: m[1], line: parseInt(m[2], 10), column: null,
          code: 'JAVA_ERROR', message: m[3].trim(), severity: 'error',
          category: this._categorizeError(null, m[3]), origin: origin || 'compiler',
          language: 'java', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0,
        }));
      }
    }

    // Runtime exception fallback
    if (errors.length === 0) {
      const exRe = /(?:Exception in thread .+)\s+(.+Exception):\s*(.+)/gm;
      let m;
      while ((m = exRe.exec(rawOutput)) !== null) {
        const atMatch = rawOutput.match(/at\s+\S+\(([^:]+):(\d+)\)/);
        errors.push(this._enrichFromCatalog({
          file: atMatch?.[1] || '', line: parseInt(atMatch?.[2], 10) || 0, column: null,
          code: m[1], message: m[1] + ': ' + m[2], severity: 'error',
          category: this._categorizeError(m[1], m[2]), origin: origin || 'runtime',
          language: 'java', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0,
        }));
      }
    }

    return errors;
  }

  getCrashPatterns() {
    return [/Exception in thread/, /at .+\.java:\d+/, /OutOfMemoryError/, /StackOverflowError/, /NullPointerException/, /ClassNotFoundException/, /NoClassDefFoundError/];
  }

  // --- Testing -----------------------------------------------------------------

  getTestCommand(projectRoot, framework) {
    const fw = framework || this.detectTestFramework(projectRoot);
    return fw ? fw.command : null;
  }

  parseTestOutput(raw) {
    const result = { passed: 0, failed: 0, errors: [] };
    if (!raw) return result;
    // Gradle format: X tests completed, Y failed
    const gm = raw.match(/(\d+)\s+tests?\s+completed/); if (gm) result.passed = parseInt(gm[1], 10);
    const gf = raw.match(/(\d+)\s+failed/); if (gf) { result.failed = parseInt(gf[1], 10); result.passed -= result.failed; }
    // Maven Surefire format: Tests run: X, Failures: Y, Errors: Z
    const mm = raw.match(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)/);
    if (mm) { result.passed = parseInt(mm[1], 10) - parseInt(mm[2], 10) - parseInt(mm[3], 10); result.failed = parseInt(mm[2], 10) + parseInt(mm[3], 10); }
    return result;
  }

  getEdgeCases(paramType) {
    const t = (paramType || '').toLowerCase();
    if (t.includes('optional')) return [{ label: 'empty', value: 'Optional.empty()' }, { label: 'of', value: 'Optional.of(value)' }, { label: 'ofNullable null', value: 'Optional.ofNullable(null)' }];
    if (t.includes('string')) return [{ label: 'empty', value: '""' }, { label: 'null', value: 'null' }, { label: 'whitespace', value: '" "' }, { label: 'long', value: '"a".repeat(10000)' }];
    if (t.includes('int') || t.includes('long') || t.includes('integer')) return [{ label: 'zero', value: '0' }, { label: 'negative', value: '-1' }, { label: 'MAX_VALUE', value: 'Integer.MAX_VALUE' }, { label: 'MIN_VALUE', value: 'Integer.MIN_VALUE' }];
    if (t.includes('list') || t.includes('collection')) return [{ label: 'empty', value: 'Collections.emptyList()' }, { label: 'null', value: 'null' }, { label: 'single', value: 'List.of(item)' }];
    if (t.includes('map')) return [{ label: 'empty', value: 'Collections.emptyMap()' }, { label: 'null', value: 'null' }];
    if (t.includes('boolean')) return [{ label: 'true', value: 'true' }, { label: 'false', value: 'false' }, { label: 'null Boolean', value: 'null' }];
    if (t.includes('double') || t.includes('float')) return [{ label: 'zero', value: '0.0' }, { label: 'NaN', value: 'Double.NaN' }, { label: 'POSITIVE_INFINITY', value: 'Double.POSITIVE_INFINITY' }];
    return [{ label: 'null', value: 'null' }];
  }

  generateMocks(deps) {
    return deps.map(dep => {
      const name = (dep.module || dep.name || '').toLowerCase();
      if (/jpa|hibernate|jdbc|mybatis|r2dbc/.test(name)) return { name: dep.module || dep.name, returnValue: 'new ArrayList<>()', type: 'database' };
      if (/webclient|resttemplate|okhttp|retrofit/.test(name)) return { name: dep.module || dep.name, returnValue: 'ResponseEntity.ok(body)', type: 'http' };
      if (/java\.io|java\.nio|files/.test(name)) return { name: dep.module || dep.name, returnValue: '"mock content"', type: 'filesystem' };
      if (/javamail|sendgrid/.test(name)) return { name: dep.module || dep.name, returnValue: 'void', type: 'email' };
      return { name: dep.module || dep.name, returnValue: 'Mockito.mock(Class.class)', type: 'generic' };
    });
  }

  buildSearchQuery(error) {
    const parts = ['Java'];
    const exType = error.message?.match(/^(\w+(?:Exception|Error))/)?.[1];
    if (exType) parts.push(exType);
    else if (error.code) parts.push(error.code);
    if (error.message) parts.push(error.message.slice(0, 60).trim());
    parts.push('fix');
    return parts.join(' ');
  }

  // --- Helpers -----------------------------------------------------------------

  _detectStrategy(projectRoot) {
    if (this._isGradle(projectRoot)) return 'gradle';
    if (fs.existsSync(path.join(projectRoot, 'pom.xml'))) return 'maven';
    if (OSAbstraction.which('gradle')) return 'gradle';
    if (OSAbstraction.which('mvn')) return 'maven';
    return null;
  }

  _isGradle(projectRoot) {
    return fs.existsSync(path.join(projectRoot, 'build.gradle')) ||
           fs.existsSync(path.join(projectRoot, 'build.gradle.kts')) ||
           fs.existsSync(path.join(projectRoot, 'gradlew'));
  }

  _gradleCmd(projectRoot) {
    if (fs.existsSync(path.join(projectRoot, 'gradlew'))) return OSAbstraction.isWin ? 'gradlew.bat' : './gradlew';
    return 'gradle';
  }

  _readGradleFile(projectRoot) {
    for (const f of ['build.gradle', 'build.gradle.kts']) {
      const fp = path.join(projectRoot, f);
      if (fs.existsSync(fp)) { try { return fs.readFileSync(fp, 'utf-8'); } catch {} }
    }
    return null;
  }

  _hasJavaFiles(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && (e.name.endsWith('.java') || e.name.endsWith('.kt'))) return true;
        if (e.isDirectory()) { if (this._hasJavaFiles(path.join(dir, e.name))) return true; }
      }
    } catch {}
    return false;
  }

  _categorizeError(code, message) {
    const msg = (message || '').toLowerCase();
    if (/syntax|parse|expected|illegal/.test(msg)) return 'syntax';
    if (/cannot find symbol|cannot resolve|package.*does not exist/.test(msg)) return 'import';
    if (/incompatible types|type mismatch|cannot be converted/.test(msg)) return 'type';
    if (/nullpointer/.test(msg)) return 'null';
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

module.exports = JavaPlugin;
