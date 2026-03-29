'use strict';

/**
 * plugins/version-resolver.js — Semver comparison + live registry resolution.
 *
 * Resolves latest stable versions from package registries (npm, PyPI, crates.io,
 * Maven Central, Go proxy). Caches results for 24h at ~/.attar-code/version-cache.json.
 * Falls back to bundled defaults/versions.json when offline.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Registry Definitions ──────────────────────────────────────────────────────

const REGISTRIES = {
  npm: {
    urlTemplate: 'https://registry.npmjs.org/{pkg}/latest',
    extractVersion: (data) => data.version,
  },
  pypi: {
    urlTemplate: 'https://pypi.org/pypi/{pkg}/json',
    extractVersion: (data) => data.info && data.info.version,
  },
  crates: {
    urlTemplate: 'https://crates.io/api/v1/crates/{pkg}',
    extractVersion: (data) => data.crate && data.crate.max_stable_version,
  },
  maven: {
    urlTemplate: 'https://search.maven.org/solrsearch/select?q=g:{group}+AND+a:{artifact}&rows=1&wt=json',
    extractVersion: (data) => data.response && data.response.docs && data.response.docs[0] && data.response.docs[0].latestVersion,
  },
  go: {
    urlTemplate: 'https://proxy.golang.org/{pkg}/@latest',
    extractVersion: (data) => data.Version && data.Version.replace(/^v/, ''),
  },
};

// 24-hour cache TTL
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ─── Semver Utilities ──────────────────────────────────────────────────────────

/**
 * Parse a semver string into [major, minor, patch].
 * Handles: '3.12.9', 'v22.14.0', '1.85.1'
 * @param {string} ver
 * @returns {number[]} [major, minor, patch]
 */
function parseSemver(ver) {
  if (!ver) return [0, 0, 0];
  const clean = String(ver).replace(/^v/, '').trim();
  const parts = clean.split('.').map(Number);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/**
 * Compare two semver strings.
 * @param {string} a
 * @param {string} b
 * @returns {number} -1 if a < b, 0 if equal, 1 if a > b
 */
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

/**
 * Check if version satisfies a minimum requirement.
 * @param {string} version  Installed version (e.g., '3.10.5')
 * @param {string} minimum  Required minimum (e.g., '3.10.0')
 * @returns {boolean}
 */
function satisfiesMinimum(version, minimum) {
  return compareSemver(version, minimum) >= 0;
}

/**
 * Get the major version number from a semver string.
 * @param {string} ver
 * @returns {number}
 */
function majorVersion(ver) {
  return parseSemver(ver)[0];
}

// ─── VersionResolver ───────────────────────────────────────────────────────────

class VersionResolver {
  /**
   * @param {object} [opts]
   * @param {string} [opts.proxyUrl]   Search-proxy URL (for /fetch endpoint)
   * @param {string} [opts.cacheFile]  Override cache file path
   * @param {string} [opts.fallbackFile] Override bundled versions file path
   */
  constructor(opts = {}) {
    this._proxyUrl = opts.proxyUrl || null;
    this._cacheFile = opts.cacheFile ||
      path.join(os.homedir(), '.attar-code', 'version-cache.json');
    this._fallbackFile = opts.fallbackFile ||
      path.join(__dirname, '..', 'defaults', 'versions.json');
    this._cache = this._loadCache();
  }

  // ─── Cache ───────────────────────────────────────────────────────────────────

  _loadCache() {
    try {
      const raw = fs.readFileSync(this._cacheFile, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  _saveCache() {
    try {
      const dir = path.dirname(this._cacheFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._cacheFile, JSON.stringify(this._cache, null, 2));
    } catch { /* best effort */ }
  }

  /**
   * Get a cached version if still valid (< 24h old).
   * @param {string} key  Cache key (e.g., 'npm:express')
   * @returns {string|null}
   */
  getCached(key) {
    const entry = this._cache[key];
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) return null;
    return entry.version;
  }

  /**
   * Store a version in cache.
   * @param {string} key
   * @param {string} version
   */
  updateCache(key, version) {
    this._cache[key] = { version, timestamp: Date.now() };
    this._saveCache();
  }

  // ─── Fallback ────────────────────────────────────────────────────────────────

  /**
   * Get a version from the bundled fallback file.
   * @param {string} key  Cache key (e.g., 'npm:express')
   * @returns {string|null}
   */
  getFallback(key) {
    try {
      const raw = fs.readFileSync(this._fallbackFile, 'utf-8');
      const data = JSON.parse(raw);
      return data[key] || null;
    } catch {
      return null;
    }
  }

  // ─── Fetch ───────────────────────────────────────────────────────────────────

  /**
   * Fetch a URL. Uses search-proxy /fetch if available, else direct fetch().
   * @param {string} url
   * @returns {Promise<object|null>} Parsed JSON or null on failure
   */
  async _fetch(url) {
    // Try via search-proxy first (reuses existing infrastructure)
    if (this._proxyUrl) {
      try {
        const res = await fetch(`${this._proxyUrl}/fetch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, raw: true }),
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
          const body = await res.json();
          // Proxy returns { content, ... } — for JSON APIs we need the raw content
          if (body.content) {
            try { return JSON.parse(body.content); } catch { return body; }
          }
          return body;
        }
      } catch { /* proxy unavailable, fall through */ }
    }

    // Direct fetch
    try {
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'attar-code-cli/1.0' },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return await res.json();
    } catch { /* network error */ }

    return null;
  }

  // ─── Resolve ─────────────────────────────────────────────────────────────────

  /**
   * Resolve the latest stable version of a package from a registry.
   *
   * Resolution order:
   * 1. Cache (if < 24h old)
   * 2. Live registry API
   * 3. Bundled fallback (defaults/versions.json)
   *
   * @param {string} registry  'npm' | 'pypi' | 'crates' | 'maven' | 'go'
   * @param {string} pkg       Package name (e.g., 'express', 'django')
   * @param {object} [opts]    For maven: { group, artifact }
   * @returns {Promise<string|null>} Version string or null
   */
  async resolve(registry, pkg, opts = {}) {
    const cacheKey = `${registry}:${pkg}`;

    // 1. Check cache
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

    // 2. Live fetch
    const reg = REGISTRIES[registry];
    if (reg) {
      let url = reg.urlTemplate.replace('{pkg}', encodeURIComponent(pkg));
      // Maven needs group:artifact split
      if (registry === 'maven' && opts.group && opts.artifact) {
        url = reg.urlTemplate
          .replace('{group}', encodeURIComponent(opts.group))
          .replace('{artifact}', encodeURIComponent(opts.artifact));
      }

      const data = await this._fetch(url);
      if (data) {
        const version = reg.extractVersion(data);
        if (version) {
          this.updateCache(cacheKey, version);
          return version;
        }
      }
    }

    // 3. Fallback
    return this.getFallback(cacheKey);
  }

  /**
   * Batch-resolve multiple packages.
   * @param {Array<{ registry: string, pkg: string, opts?: object }>} deps
   * @returns {Promise<Object<string, string>>}  { packageName: version }
   */
  async resolveAll(deps) {
    const results = {};
    // Sequential to avoid flooding registries
    for (const dep of deps) {
      const version = await this.resolve(dep.registry, dep.pkg, dep.opts);
      if (version) results[dep.pkg] = version;
    }
    return results;
  }

  /**
   * Force refresh all cached entries.
   * @returns {Promise<number>} Number of entries refreshed
   */
  async refreshAll() {
    let count = 0;
    for (const key of Object.keys(this._cache)) {
      const [registry, pkg] = key.split(':');
      if (REGISTRIES[registry]) {
        // Clear cache entry to force re-fetch
        delete this._cache[key];
        const version = await this.resolve(registry, pkg);
        if (version) count++;
      }
    }
    return count;
  }

  /**
   * Get all cached versions (for display).
   * @returns {Object<string, { version: string, timestamp: number }>}
   */
  getAllCached() {
    return { ...this._cache };
  }
}

module.exports = {
  VersionResolver,
  parseSemver,
  compareSemver,
  satisfiesMinimum,
  majorVersion,
  REGISTRIES,
};
