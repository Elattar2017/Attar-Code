// kb-engine/tests/qdrant-manager.test.js
// TDD: Tests written FIRST.
// Unit-only — no real download or Qdrant process is started.
// Run: npx jest kb-engine/tests/qdrant-manager.test.js --no-coverage

"use strict";

const path = require("path");
const os   = require("os");

// We import the class under test.  If the file doesn't exist yet every test
// in this suite will fail with "Cannot find module" — that is the expected
// RED state before implementation.
const { QdrantManager } = require("../qdrant-manager");
const {
  QDRANT_BIN_DIR,
  QDRANT_DOWNLOAD_URLS,
} = require("../config");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Create a QdrantManager whose host/port we can override for isolation. */
function makeManager(overrides = {}) {
  return new QdrantManager(overrides);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. getDownloadUrl()
// ─────────────────────────────────────────────────────────────────────────────
describe("getDownloadUrl()", () => {
  test("returns a string", () => {
    const mgr = makeManager();
    const url = mgr.getDownloadUrl();
    expect(typeof url).toBe("string");
  });

  test("URL is non-empty", () => {
    const mgr = makeManager();
    expect(mgr.getDownloadUrl().length).toBeGreaterThan(0);
  });

  test("URL starts with https://", () => {
    const mgr = makeManager();
    expect(mgr.getDownloadUrl()).toMatch(/^https:\/\//);
  });

  test("URL contains expected platform identifier for win32-x64", () => {
    const mgr = makeManager({ platform: "win32", arch: "x64" });
    expect(mgr.getDownloadUrl()).toContain("windows");
  });

  test("URL contains expected platform identifier for darwin-x64", () => {
    const mgr = makeManager({ platform: "darwin", arch: "x64" });
    expect(mgr.getDownloadUrl()).toContain("apple-darwin");
  });

  test("URL contains expected platform identifier for darwin-arm64", () => {
    const mgr = makeManager({ platform: "darwin", arch: "arm64" });
    expect(mgr.getDownloadUrl()).toContain("aarch64");
  });

  test("URL contains expected platform identifier for linux-x64", () => {
    const mgr = makeManager({ platform: "linux", arch: "x64" });
    expect(mgr.getDownloadUrl()).toContain("linux");
  });

  test("URL contains expected platform identifier for linux-arm64", () => {
    const mgr = makeManager({ platform: "linux", arch: "arm64" });
    expect(mgr.getDownloadUrl()).toContain("aarch64");
  });

  test("URL is the value from QDRANT_DOWNLOAD_URLS for win32-x64", () => {
    const mgr = makeManager({ platform: "win32", arch: "x64" });
    expect(mgr.getDownloadUrl()).toBe(QDRANT_DOWNLOAD_URLS["win32-x64"]);
  });

  test("URL is the value from QDRANT_DOWNLOAD_URLS for linux-x64", () => {
    const mgr = makeManager({ platform: "linux", arch: "x64" });
    expect(mgr.getDownloadUrl()).toBe(QDRANT_DOWNLOAD_URLS["linux-x64"]);
  });

  test("throws for unsupported platform/arch combo", () => {
    const mgr = makeManager({ platform: "freebsd", arch: "x64" });
    expect(() => mgr.getDownloadUrl()).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. getBinaryPath()
// ─────────────────────────────────────────────────────────────────────────────
describe("getBinaryPath()", () => {
  test("returns a string", () => {
    const mgr = makeManager();
    expect(typeof mgr.getBinaryPath()).toBe("string");
  });

  test("path is inside QDRANT_BIN_DIR", () => {
    const mgr = makeManager();
    expect(mgr.getBinaryPath()).toContain(QDRANT_BIN_DIR);
  });

  test("returns path ending with qdrant.exe on Windows", () => {
    const mgr = makeManager({ platform: "win32", arch: "x64" });
    expect(mgr.getBinaryPath()).toMatch(/qdrant\.exe$/);
  });

  test("returns path ending with 'qdrant' (no .exe) on Linux", () => {
    const mgr = makeManager({ platform: "linux", arch: "x64" });
    const p = mgr.getBinaryPath();
    expect(p).toMatch(/qdrant$/);        // ends with 'qdrant'
    expect(p).not.toMatch(/\.exe$/);     // no .exe
  });

  test("returns path ending with 'qdrant' (no .exe) on macOS", () => {
    const mgr = makeManager({ platform: "darwin", arch: "arm64" });
    const p = mgr.getBinaryPath();
    expect(p).toMatch(/qdrant$/);
    expect(p).not.toMatch(/\.exe$/);
  });

  test("path uses correct path separator (path.join semantics)", () => {
    const mgr = makeManager({ platform: "linux", arch: "x64" });
    // The path should be composed of the bin-dir joined with the binary name
    const expected = path.join(QDRANT_BIN_DIR, "qdrant");
    expect(mgr.getBinaryPath()).toBe(expected);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. isInstalled()
// ─────────────────────────────────────────────────────────────────────────────
describe("isInstalled()", () => {
  test("returns a boolean", () => {
    const mgr = makeManager();
    expect(typeof mgr.isInstalled()).toBe("boolean");
  });

  test("returns false when binary path does not exist", () => {
    // Point at a guaranteed-nonexistent path
    const mgr = makeManager({
      binDir: path.join(os.tmpdir(), `attar-test-nonexistent-${Date.now()}`),
    });
    expect(mgr.isInstalled()).toBe(false);
  });

  test("returns true when binary file exists", () => {
    // Create a temp file that simulates the binary presence
    const fs = require("fs");
    const tmpDir = path.join(os.tmpdir(), `attar-test-bin-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const platform = process.platform;
    const binName  = platform === "win32" ? "qdrant.exe" : "qdrant";
    const binPath  = path.join(tmpDir, binName);
    fs.writeFileSync(binPath, "fake binary");

    const mgr = makeManager({ binDir: tmpDir, platform });
    expect(mgr.isInstalled()).toBe(true);

    // Cleanup
    fs.unlinkSync(binPath);
    fs.rmdirSync(tmpDir);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. isRunning()  — network test against an unused port (16333)
// ─────────────────────────────────────────────────────────────────────────────
describe("isRunning()", () => {
  test("returns a Promise", () => {
    const mgr = makeManager({ port: 16333 });
    const result = mgr.isRunning();
    expect(result).toBeInstanceOf(Promise);
    // Consume promise to avoid unhandled-rejection noise
    return result.catch(() => {});
  });

  test("resolves to false on an unused port (16333)", async () => {
    const mgr = makeManager({ host: "127.0.0.1", port: 16333 });
    const running = await mgr.isRunning();
    expect(running).toBe(false);
  }, 5000);

  test("resolves (does not reject) even when Qdrant is not running", async () => {
    const mgr = makeManager({ host: "127.0.0.1", port: 16333 });
    await expect(mgr.isRunning()).resolves.toBeDefined();
  }, 5000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. getStatus()  — network test against an unused port (16333)
// ─────────────────────────────────────────────────────────────────────────────
describe("getStatus()", () => {
  test("returns a Promise", () => {
    const mgr = makeManager({ port: 16333 });
    const result = mgr.getStatus();
    expect(result).toBeInstanceOf(Promise);
    return result.catch(() => {});
  });

  test("resolves to an object", async () => {
    const mgr = makeManager({ host: "127.0.0.1", port: 16333 });
    const status = await mgr.getStatus();
    expect(typeof status).toBe("object");
    expect(status).not.toBeNull();
  }, 5000);

  test("status.running is false when Qdrant is not reachable (port 16333)", async () => {
    const mgr = makeManager({ host: "127.0.0.1", port: 16333 });
    const status = await mgr.getStatus();
    expect(status.running).toBe(false);
  }, 5000);

  test("status has managedByUs property", async () => {
    const mgr = makeManager({ host: "127.0.0.1", port: 16333 });
    const status = await mgr.getStatus();
    expect(status).toHaveProperty("managedByUs");
  }, 5000);

  test("status has pid property", async () => {
    const mgr = makeManager({ host: "127.0.0.1", port: 16333 });
    const status = await mgr.getStatus();
    expect(status).toHaveProperty("pid");
  }, 5000);

  test("status has collections property", async () => {
    const mgr = makeManager({ host: "127.0.0.1", port: 16333 });
    const status = await mgr.getStatus();
    expect(status).toHaveProperty("collections");
  }, 5000);

  test("status.managedByUs is false when not running", async () => {
    const mgr = makeManager({ host: "127.0.0.1", port: 16333 });
    const status = await mgr.getStatus();
    expect(status.managedByUs).toBe(false);
  }, 5000);

  test("status.pid is null when not running", async () => {
    const mgr = makeManager({ host: "127.0.0.1", port: 16333 });
    const status = await mgr.getStatus();
    expect(status.pid).toBeNull();
  }, 5000);

  test("status.collections is null or array when not running", async () => {
    const mgr = makeManager({ host: "127.0.0.1", port: 16333 });
    const status = await mgr.getStatus();
    // When Qdrant is down, collections should be null (can't fetch)
    expect(status.collections === null || Array.isArray(status.collections)).toBe(true);
  }, 5000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Class shape / export contract
// ─────────────────────────────────────────────────────────────────────────────
describe("QdrantManager class shape", () => {
  test("QdrantManager can be constructed without arguments", () => {
    expect(() => new QdrantManager()).not.toThrow();
  });

  test("instance has getDownloadUrl method", () => {
    expect(typeof new QdrantManager().getDownloadUrl).toBe("function");
  });

  test("instance has getBinaryPath method", () => {
    expect(typeof new QdrantManager().getBinaryPath).toBe("function");
  });

  test("instance has isInstalled method", () => {
    expect(typeof new QdrantManager().isInstalled).toBe("function");
  });

  test("instance has isRunning method", () => {
    expect(typeof new QdrantManager().isRunning).toBe("function");
  });

  test("instance has getStatus method", () => {
    expect(typeof new QdrantManager().getStatus).toBe("function");
  });

  test("instance has download method", () => {
    expect(typeof new QdrantManager().download).toBe("function");
  });

  test("instance has start method", () => {
    expect(typeof new QdrantManager().start).toBe("function");
  });

  test("instance has stop method", () => {
    expect(typeof new QdrantManager().stop).toBe("function");
  });
});
