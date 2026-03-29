// kb-engine/qdrant-manager.js — Qdrant binary lifecycle manager
// Downloads, spawns, health-checks, and stops the Qdrant vector-DB binary.
// Cross-platform: Windows (.zip via PowerShell) + macOS/Linux (.tar.gz via tar).
"use strict";

const fs            = require("fs");
const path          = require("path");
const http          = require("http");
const https         = require("https");
const { spawn }     = require("child_process");
const {
  QDRANT_PORT,
  QDRANT_HOST,
  QDRANT_BIN_DIR,
  QDRANT_STORAGE,
  QDRANT_DOWNLOAD_URLS,
} = require("./config");

// ─── Constants ────────────────────────────────────────────────────────────────

const HEALTH_CHECK_TIMEOUT_MS = 2000;
const START_WAIT_MS           = 45000; // 45s — cold start on Windows needs time for collection creation
const START_POLL_INTERVAL_MS  = 300;

// ─── QdrantManager ────────────────────────────────────────────────────────────

class QdrantManager {
  /**
   * @param {object} [opts]
   * @param {string}  [opts.host]     Override host (default: QDRANT_HOST)
   * @param {number}  [opts.port]     Override port (default: QDRANT_PORT)
   * @param {string}  [opts.binDir]   Override binary directory
   * @param {string}  [opts.platform] Override platform (for testing)
   * @param {string}  [opts.arch]     Override CPU architecture (for testing)
   */
  constructor(opts = {}) {
    this._host     = opts.host     ?? QDRANT_HOST;
    this._port     = opts.port     ?? QDRANT_PORT;
    this._binDir   = opts.binDir   ?? QDRANT_BIN_DIR;
    this._platform = opts.platform ?? process.platform;
    this._arch     = opts.arch     ?? process.arch;

    /** @type {import("child_process").ChildProcess | null} */
    this._proc     = null;
  }

  // ── Download URL ───────────────────────────────────────────────────────────

  /**
   * Return the GitHub release download URL for the current OS + arch.
   * @returns {string}
   * @throws {Error} if the platform/arch combo is not supported
   */
  getDownloadUrl() {
    const key = `${this._platform}-${this._arch}`;
    const url = QDRANT_DOWNLOAD_URLS[key];
    if (!url) {
      throw new Error(
        `Unsupported platform/arch: ${key}. ` +
        `Supported: ${Object.keys(QDRANT_DOWNLOAD_URLS).join(", ")}`
      );
    }
    return url;
  }

  // ── Binary path ────────────────────────────────────────────────────────────

  /**
   * Absolute path to the Qdrant executable (qdrant.exe on Windows, qdrant elsewhere).
   * @returns {string}
   */
  getBinaryPath() {
    const name = this._platform === "win32" ? "qdrant.exe" : "qdrant";
    return path.join(this._binDir, name);
  }

  // ── isInstalled ────────────────────────────────────────────────────────────

  /**
   * Returns true if the Qdrant binary exists on disk.
   * @returns {boolean}
   */
  isInstalled() {
    return fs.existsSync(this.getBinaryPath());
  }

  // ── isRunning ──────────────────────────────────────────────────────────────

  /**
   * Ping Qdrant's /healthz endpoint with a 2-second timeout.
   * Resolves to true if the service responds 200, false otherwise.
   * Never rejects.
   * @returns {Promise<boolean>}
   */
  isRunning() {
    return new Promise((resolve) => {
      const options = {
        hostname : this._host,
        port     : this._port,
        path     : "/healthz",
        method   : "GET",
        timeout  : HEALTH_CHECK_TIMEOUT_MS,
      };

      const req = http.request(options, (res) => {
        // Consume response body so the socket is released
        res.resume();
        resolve(res.statusCode === 200);
      });

      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });

      req.on("error", () => resolve(false));
      req.end();
    });
  }

  // ── getStatus ──────────────────────────────────────────────────────────────

  /**
   * Return a status snapshot.
   * @returns {Promise<{
   *   running: boolean,
   *   managedByUs: boolean,
   *   pid: number | null,
   *   collections: string[] | null
   * }>}
   */
  async getStatus() {
    const running = await this.isRunning();

    if (!running) {
      return {
        running     : false,
        managedByUs : false,
        pid         : null,
        collections : null,
      };
    }

    const managedByUs = this._proc !== null && this._proc.exitCode === null;
    const pid         = managedByUs ? this._proc.pid ?? null : null;

    let collections = null;
    try {
      collections = await this._fetchCollections();
    } catch {
      // Best-effort; leave null if Qdrant is mid-startup
    }

    return { running: true, managedByUs, pid, collections };
  }

  // ── download ───────────────────────────────────────────────────────────────

  /**
   * Download and extract the Qdrant binary for the current platform.
   * @param {(pct: number) => void} [onProgress]  Called with 0-100 percent
   * @returns {Promise<void>}
   */
  async download(onProgress) {
    const url     = this.getDownloadUrl();
    const binDir  = this._binDir;
    const binPath = this.getBinaryPath();

    // Ensure bin directory exists
    fs.mkdirSync(binDir, { recursive: true });

    const isZip    = url.endsWith(".zip");
    const archName = isZip ? "qdrant-download.zip" : "qdrant-download.tar.gz";
    const archPath = path.join(binDir, archName);

    // Download archive, following redirects
    await this._downloadFile(url, archPath, onProgress);

    // Extract
    if (isZip) {
      await this._extractZipWindows(archPath, binDir);
    } else {
      await this._extractTarGz(archPath, binDir);
    }

    // Mark executable on Unix
    if (this._platform !== "win32" && fs.existsSync(binPath)) {
      fs.chmodSync(binPath, 0o755);
    }

    // Clean up archive
    try { fs.unlinkSync(archPath); } catch { /* ignore */ }
  }

  // ── start ──────────────────────────────────────────────────────────────────

  /**
   * Start the Qdrant process if it is not already running.
   * Waits up to 15 s for the health endpoint to respond.
   * @returns {Promise<void>}
   * @throws {Error} if Qdrant fails to become healthy within the timeout
   */
  async start() {
    if (await this.isRunning()) return; // already up (external instance)

    if (!this.isInstalled()) {
      throw new Error(
        `Qdrant binary not found at ${this.getBinaryPath()}. ` +
        `Run manager.download() first.`
      );
    }

    fs.mkdirSync(QDRANT_STORAGE, { recursive: true });

    this._proc = spawn(
      this.getBinaryPath(),
      [],
      {
        detached : false,
        stdio    : "ignore",
        env      : {
          ...process.env,
          QDRANT__SERVICE__HTTP_PORT : String(this._port),
          QDRANT__SERVICE__HOST      : this._host,
          QDRANT__STORAGE__STORAGE_PATH : QDRANT_STORAGE,
        },
      }
    );

    this._proc.on("error", (err) => {
      console.error(`[QdrantManager] spawn error: ${err.message}`);
    });

    // Wait up to START_WAIT_MS for /healthz to respond
    const deadline = Date.now() + START_WAIT_MS;
    while (Date.now() < deadline) {
      if (await this.isRunning()) return;
      await _sleep(START_POLL_INTERVAL_MS);
    }

    // Timed out — kill what we spawned and throw
    this._killProc();
    throw new Error(
      `Qdrant did not become healthy within ${START_WAIT_MS / 1000}s.`
    );
  }

  // ── stop ───────────────────────────────────────────────────────────────────

  /**
   * Stop the Qdrant process managed by this instance.
   * On Windows: taskkill /F /PID; on Unix: SIGTERM.
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this._proc || this._proc.exitCode !== null) {
      this._proc = null;
      return; // Nothing to stop
    }

    const pid = this._proc.pid;
    this._proc = null;

    if (this._platform === "win32") {
      // taskkill is safer than proc.kill() on Windows
      await new Promise((resolve) => {
        const killer = spawn("taskkill", ["/F", "/PID", String(pid)], {
          stdio: "ignore",
        });
        killer.on("close", resolve);
        killer.on("error", resolve); // best-effort
      });
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch { /* already dead */ }
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Kill the managed process without caring about the result. */
  _killProc() {
    if (!this._proc) return;
    try { this._proc.kill(); } catch { /* ignore */ }
    this._proc = null;
  }

  /**
   * Fetch the list of collection names from Qdrant's REST API.
   * @returns {Promise<string[]>}
   */
  _fetchCollections() {
    return new Promise((resolve, reject) => {
      const options = {
        hostname : this._host,
        port     : this._port,
        path     : "/collections",
        method   : "GET",
        timeout  : HEALTH_CHECK_TIMEOUT_MS,
      };

      const req = http.request(options, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const body   = JSON.parse(Buffer.concat(chunks).toString());
            const names  = (body?.result?.collections ?? []).map((c) => c.name);
            resolve(names);
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      req.on("error", reject);
      req.end();
    });
  }

  /**
   * Download a URL to a local file, following HTTP/HTTPS redirects.
   * @param {string} url
   * @param {string} destPath
   * @param {((pct: number) => void) | undefined} onProgress
   * @returns {Promise<void>}
   */
  _downloadFile(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
      const doGet = (currentUrl) => {
        const lib = currentUrl.startsWith("https") ? https : http;
        lib.get(currentUrl, (res) => {
          // Follow redirects (GitHub releases use 302)
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            doGet(res.headers.location);
            return;
          }

          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`Download failed: HTTP ${res.statusCode} for ${currentUrl}`));
            return;
          }

          const total  = parseInt(res.headers["content-length"] ?? "0", 10);
          let received = 0;
          const out    = fs.createWriteStream(destPath);

          res.on("data", (chunk) => {
            received += chunk.length;
            if (onProgress && total > 0) {
              onProgress(Math.round((received / total) * 100));
            }
          });

          res.pipe(out);
          out.on("finish", () => {
            out.close(resolve);
          });
          out.on("error", reject);
        }).on("error", reject);
      };

      doGet(url);
    });
  }

  /**
   * Extract a .zip archive using PowerShell (Windows only).
   * @param {string} archPath  Full path to the .zip file
   * @param {string} destDir   Directory to extract into
   * @returns {Promise<void>}
   */
  _extractZipWindows(archPath, destDir) {
    return new Promise((resolve, reject) => {
      // PowerShell Expand-Archive is available on all modern Windows
      const ps = spawn(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -Force -Path '${archPath}' -DestinationPath '${destDir}'`,
        ],
        { stdio: "ignore" }
      );
      ps.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`PowerShell Expand-Archive exited with code ${code}`));
      });
      ps.on("error", reject);
    });
  }

  /**
   * Extract a .tar.gz archive using the system tar command (macOS/Linux).
   * @param {string} archPath  Full path to the .tar.gz file
   * @param {string} destDir   Directory to extract into
   * @returns {Promise<void>}
   */
  _extractTarGz(archPath, destDir) {
    return new Promise((resolve, reject) => {
      const tar = spawn(
        "tar",
        ["-xzf", archPath, "-C", destDir],
        { stdio: "ignore" }
      );
      tar.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tar exited with code ${code}`));
      });
      tar.on("error", reject);
    });
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { QdrantManager };
