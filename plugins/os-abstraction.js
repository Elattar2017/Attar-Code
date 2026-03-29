'use strict';

/**
 * plugins/os-abstraction.js — Cross-platform shell abstraction layer.
 *
 * All shell interactions in the plugin system go through this module.
 * No plugin or core code should hardcode OS-specific commands.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ─── Platform Detection ────────────────────────────────────────────────────────

const PLATFORM = process.platform;  // 'win32' | 'darwin' | 'linux'
const IS_WIN   = PLATFORM === 'win32';
const IS_MAC   = PLATFORM === 'darwin';
const IS_LINUX = PLATFORM === 'linux';

const SHELL      = IS_WIN ? (process.env.COMSPEC || 'cmd.exe') : '/bin/bash';
const SHELL_FLAG = IS_WIN ? '/c' : '-c';
const PATH_SEP   = IS_WIN ? '\\' : '/';

// ─── Install Hints (per-platform) ──────────────────────────────────────────────

const INSTALL_HINTS = {
  node:    { win32: 'choco install nodejs-lts -y',     darwin: 'brew install node',               linux: 'sudo apt install nodejs -y' },
  npm:     { win32: 'choco install nodejs-lts -y',     darwin: 'brew install node',               linux: 'sudo apt install nodejs npm -y' },
  python:  { win32: 'choco install python3 -y',        darwin: 'brew install python@3.12',         linux: 'sudo apt install python3 python3-venv python3-pip -y' },
  python3: { win32: 'choco install python3 -y',        darwin: 'brew install python@3.12',         linux: 'sudo apt install python3 python3-venv python3-pip -y' },
  pip:     { win32: 'choco install python3 -y',        darwin: 'brew install python@3.12',         linux: 'sudo apt install python3-pip -y' },
  uv:      { win32: 'pip install uv',                  darwin: 'brew install uv',                  linux: 'curl -LsSf https://astral.sh/uv/install.sh | sh' },
  cargo:   { win32: 'winget install Rustlang.Rustup',  darwin: 'curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh', linux: 'curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh' },
  rustc:   { win32: 'winget install Rustlang.Rustup',  darwin: 'curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh', linux: 'curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh' },
  go:      { win32: 'choco install golang -y',         darwin: 'brew install go',                  linux: 'sudo apt install golang -y' },
  java:    { win32: 'choco install temurin21 -y',      darwin: 'brew install --cask temurin@21',   linux: 'sudo apt install openjdk-21-jdk -y' },
  javac:   { win32: 'choco install temurin21 -y',      darwin: 'brew install --cask temurin@21',   linux: 'sudo apt install openjdk-21-jdk -y' },
  mvn:     { win32: 'choco install maven -y',          darwin: 'brew install maven',               linux: 'sudo apt install maven -y' },
  gradle:  { win32: 'choco install gradle -y',         darwin: 'brew install gradle',              linux: 'sudo apt install gradle -y' },
  gcc:     { win32: 'choco install mingw -y',          darwin: 'xcode-select --install',           linux: 'sudo apt install gcc -y' },
  'g++':   { win32: 'choco install mingw -y',          darwin: 'xcode-select --install',           linux: 'sudo apt install g++ -y' },
  cmake:   { win32: 'choco install cmake -y',          darwin: 'brew install cmake',               linux: 'sudo apt install cmake -y' },
  make:    { win32: 'choco install make -y',            darwin: 'xcode-select --install',           linux: 'sudo apt install build-essential -y' },
  ninja:   { win32: 'choco install ninja -y',           darwin: 'brew install ninja',               linux: 'sudo apt install ninja-build -y' },
  docker:  { win32: 'choco install docker-desktop -y',  darwin: 'brew install --cask docker',       linux: 'sudo apt install docker.io -y' },
  git:     { win32: 'choco install git -y',             darwin: 'brew install git',                 linux: 'sudo apt install git -y' },
  ruby:    { win32: 'choco install ruby -y',            darwin: 'brew install ruby',                linux: 'sudo apt install ruby -y' },
  pnpm:    { win32: 'npm install -g pnpm',              darwin: 'npm install -g pnpm',              linux: 'npm install -g pnpm' },
  yarn:    { win32: 'npm install -g yarn',              darwin: 'npm install -g yarn',              linux: 'npm install -g yarn' },
  bun:     { win32: 'npm install -g bun',               darwin: 'brew install oven-sh/bun/bun',    linux: 'curl -fsSL https://bun.sh/install | bash' },
};

// ─── OSAbstraction ─────────────────────────────────────────────────────────────

class OSAbstraction {

  /** Current platform string: 'win32' | 'darwin' | 'linux' */
  static get platform() { return PLATFORM; }
  static get isWin()    { return IS_WIN; }
  static get isMac()    { return IS_MAC; }
  static get isLinux()  { return IS_LINUX; }
  static get shell()    { return SHELL; }
  static get pathSep()  { return PATH_SEP; }

  /**
   * Execute a shell command synchronously. Cross-platform.
   *
   * NOTE: Only called with known, safe commands (version checks, tool detection).
   * Never called with user-supplied input directly.
   *
   * @param {string} cmd        Command to run
   * @param {object} [opts]     Options
   * @param {string} [opts.cwd] Working directory
   * @param {number} [opts.timeout] Timeout in ms (default 30000)
   * @param {boolean} [opts.silent] Suppress errors (return null instead of throwing)
   * @returns {string|null} stdout or null on failure (if silent)
   */
  static exec(cmd, opts = {}) {
    const timeout = opts.timeout || 30000;
    try {
      return execSync(cmd, {
        cwd: opts.cwd || process.cwd(),
        encoding: 'utf-8',
        timeout,
        shell: IS_WIN ? true : '/bin/bash',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (e) {
      if (opts.silent) return null;
      throw e;
    }
  }

  /**
   * Check if a binary is on PATH.
   * @param {string} binary  The binary name (e.g., 'node', 'python3', 'cargo')
   * @returns {string|null}  Full path or null if not found
   */
  static which(binary) {
    const cmd = IS_WIN ? `where ${binary}` : `which ${binary}`;
    try {
      const result = execSync(cmd, {
        encoding: 'utf-8',
        timeout: 5000,
        shell: IS_WIN ? true : '/bin/bash',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      // 'where' on Windows may return multiple lines; take first
      return result.split('\n')[0].trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Get the version of an installed binary.
   * @param {string} binary       The binary (e.g., 'node', 'python3')
   * @param {string} [versionFlag]  Flag to get version (default '--version')
   * @param {RegExp} [pattern]     Regex to extract version (default: first semver-like match)
   * @returns {{ version: string, raw: string }|null}
   */
  static getVersion(binary, versionFlag, pattern) {
    const flag = versionFlag || '--version';
    // Some tools (java) output to stderr, so merge streams
    const cmd = IS_WIN
      ? `${binary} ${flag} 2>&1`
      : `${binary} ${flag} 2>&1`;
    try {
      const raw = execSync(cmd, {
        encoding: 'utf-8',
        timeout: 10000,
        shell: IS_WIN ? true : '/bin/bash',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      const re = pattern || /(\d+\.\d+(?:\.\d+)?)/;
      const m = raw.match(re);
      return m ? { version: m[1], raw } : null;
    } catch {
      return null;
    }
  }

  /**
   * Kill whatever process is listening on a port.
   * @param {number} port
   * @returns {boolean} true if killed, false if nothing found
   */
  static killPort(port) {
    try {
      if (IS_WIN) {
        const out = execSync(
          `netstat -ano | findstr :${port} | findstr LISTENING`,
          { encoding: 'utf-8', shell: true, stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        if (!out) return false;
        const pid = out.split(/\s+/).pop();
        if (pid && /^\d+$/.test(pid)) {
          execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
          return true;
        }
      } else {
        const pid = execSync(`lsof -ti:${port}`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (pid) {
          execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
          return true;
        }
      }
    } catch { /* port not in use or no permission */ }
    return false;
  }

  /**
   * Get the command prefix to activate a Python virtual environment.
   * This prefix can be prepended to other commands with '&&'.
   * @param {string} venvPath  Path to the venv directory (e.g., '.venv')
   * @returns {string} Activation command (e.g., '.venv\\Scripts\\activate')
   */
  static activateVenv(venvPath) {
    if (IS_WIN) {
      return `${venvPath}\\Scripts\\activate`;
    }
    return `source ${venvPath}/bin/activate`;
  }

  /**
   * Check if a Python venv directory exists and looks valid.
   * @param {string} dir       Project directory
   * @param {string} [name]    Venv folder name (default: '.venv')
   * @returns {{ exists: boolean, path: string, hasActivate: boolean }}
   */
  static checkVenv(dir, name) {
    const venvName = name || '.venv';
    const venvDir = path.join(dir, venvName);
    if (!fs.existsSync(venvDir)) {
      return { exists: false, path: venvDir, hasActivate: false };
    }
    const activatePath = IS_WIN
      ? path.join(venvDir, 'Scripts', 'activate.bat')
      : path.join(venvDir, 'bin', 'activate');
    return {
      exists: true,
      path: venvDir,
      hasActivate: fs.existsSync(activatePath),
    };
  }

  /**
   * Normalize a file path: resolve, forward slashes.
   * @param {string} p
   * @returns {string}
   */
  static normalizePath(p) {
    return path.resolve(p).replace(/\\/g, '/');
  }

  /**
   * Get OS-specific install command for a tool.
   * @param {string} tool  Tool name (e.g., 'node', 'python', 'cargo')
   * @returns {string|null}  Install command or null if unknown
   */
  static getInstallHint(tool) {
    const key = tool.toLowerCase();
    const hints = INSTALL_HINTS[key];
    if (!hints) return null;
    return hints[PLATFORM] || hints.linux || null;
  }

  /**
   * Get all install hints for the current platform.
   * @returns {Object<string, string>}
   */
  static getAllInstallHints() {
    const result = {};
    for (const [tool, hints] of Object.entries(INSTALL_HINTS)) {
      result[tool] = hints[PLATFORM] || hints.linux || '';
    }
    return result;
  }

  /**
   * Get the platform-correct Python binary name.
   * @returns {string} 'python' on Windows, 'python3' on Unix
   */
  static get pythonBinary() {
    return IS_WIN ? 'python' : 'python3';
  }

  /**
   * Get the platform-correct package manager check command.
   * @returns {string}
   */
  static get packageManagerCheck() {
    return IS_WIN ? 'where choco' : IS_MAC ? 'which brew' : 'which apt';
  }

  /**
   * Get human-readable OS name.
   * @returns {string} 'Windows' | 'macOS' | 'Linux'
   */
  static get osName() {
    return IS_WIN ? 'Windows' : IS_MAC ? 'macOS' : 'Linux';
  }
}

module.exports = { OSAbstraction, INSTALL_HINTS };
