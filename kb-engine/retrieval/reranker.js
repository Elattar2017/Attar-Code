// kb-engine/retrieval/reranker.js
// Node.js client managing the Python reranker sidecar lifecycle.
"use strict";

const { spawn } = require("child_process");
const path = require("path");

const SERVER_SCRIPT = path.join(__dirname, "reranker-server.py");
const DEFAULT_PORT = 6334;
const STARTUP_TIMEOUT_MS = 30000;
const HEALTH_TIMEOUT_MS = 2000;

class Reranker {
  constructor(port) {
    this._port = port || DEFAULT_PORT;
    this._proc = null;
    this._url = `http://127.0.0.1:${this._port}`;
  }

  // ─── isRunning ──────────────────────────────────────────────────────────────

  async isRunning() {
    try {
      const res = await fetch(`${this._url}/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      const data = await res.json();
      return data.ok === true;
    } catch (_) {
      return false;
    }
  }

  // ─── start ──────────────────────────────────────────────────────────────────

  async start(modelName) {
    if (await this.isRunning()) return true;

    const args = [SERVER_SCRIPT];
    if (modelName) args.push(modelName);
    args.push(String(this._port));

    try {
      this._proc = spawn("python", args, {
        detached: false,
        stdio: ["ignore", "ignore", "ignore"],
      });

      this._proc.on("error", () => {
        this._proc = null;
      });

      this._proc.on("exit", () => {
        this._proc = null;
      });
    } catch (_) {
      return false;
    }

    // Poll until healthy or timeout
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await _sleep(500);
      if (await this.isRunning()) return true;
    }
    return false;
  }

  // ─── stop ───────────────────────────────────────────────────────────────────

  stop() {
    if (!this._proc) return;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(this._proc.pid), "/F", "/T"], {
          detached: false,
          stdio: "ignore",
        });
      } else {
        this._proc.kill("SIGTERM");
      }
    } catch (_) {
      // ignore
    }
    this._proc = null;
  }

  // ─── rerank ─────────────────────────────────────────────────────────────────

  async rerank(query, documents) {
    if (!Array.isArray(documents) || documents.length === 0) return null;
    if (!(await this.isRunning())) return null;

    try {
      const res = await fetch(`${this._url}/rerank`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, documents }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data.scores) ? data.scores : null;
    } catch (_) {
      return null;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { Reranker };
