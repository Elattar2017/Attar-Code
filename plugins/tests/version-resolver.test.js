'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { VersionResolver, parseSemver, compareSemver, satisfiesMinimum, majorVersion } = require('../version-resolver');

describe('Semver Utilities', () => {
  describe('parseSemver', () => {
    test('parses standard semver', () => {
      expect(parseSemver('3.12.9')).toEqual([3, 12, 9]);
    });

    test('strips v prefix', () => {
      expect(parseSemver('v22.14.0')).toEqual([22, 14, 0]);
    });

    test('handles two-part version', () => {
      expect(parseSemver('1.85')).toEqual([1, 85, 0]);
    });

    test('handles null/undefined', () => {
      expect(parseSemver(null)).toEqual([0, 0, 0]);
      expect(parseSemver(undefined)).toEqual([0, 0, 0]);
    });
  });

  describe('compareSemver', () => {
    test('equal versions', () => {
      expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    });

    test('major difference', () => {
      expect(compareSemver('2.0.0', '1.0.0')).toBe(1);
      expect(compareSemver('1.0.0', '2.0.0')).toBe(-1);
    });

    test('minor difference', () => {
      expect(compareSemver('1.2.0', '1.1.0')).toBe(1);
      expect(compareSemver('1.1.0', '1.2.0')).toBe(-1);
    });

    test('patch difference', () => {
      expect(compareSemver('1.2.4', '1.2.3')).toBe(1);
      expect(compareSemver('1.2.3', '1.2.4')).toBe(-1);
    });

    test('with v prefix', () => {
      expect(compareSemver('v22.14.0', '22.14.0')).toBe(0);
    });
  });

  describe('satisfiesMinimum', () => {
    test('version meets minimum', () => {
      expect(satisfiesMinimum('3.12.9', '3.10.0')).toBe(true);
    });

    test('exact match', () => {
      expect(satisfiesMinimum('3.10.0', '3.10.0')).toBe(true);
    });

    test('version below minimum', () => {
      expect(satisfiesMinimum('3.8.0', '3.10.0')).toBe(false);
    });

    test('major version higher', () => {
      expect(satisfiesMinimum('22.14.0', '18.0.0')).toBe(true);
    });
  });

  describe('majorVersion', () => {
    test('extracts major version', () => {
      expect(majorVersion('3.12.9')).toBe(3);
      expect(majorVersion('v22.14.0')).toBe(22);
      expect(majorVersion('1.85.1')).toBe(1);
    });
  });
});

describe('VersionResolver', () => {
  let resolver;
  let tmpCacheFile;

  beforeEach(() => {
    tmpCacheFile = path.join(os.tmpdir(), `attar-version-test-${Date.now()}.json`);
    resolver = new VersionResolver({
      cacheFile: tmpCacheFile,
      fallbackFile: path.join(__dirname, '..', '..', 'defaults', 'versions.json'),
    });
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpCacheFile); } catch {}
  });

  describe('cache', () => {
    test('returns null for empty cache', () => {
      expect(resolver.getCached('npm:express')).toBeNull();
    });

    test('stores and retrieves cached version', () => {
      resolver.updateCache('npm:express', '5.1.0');
      expect(resolver.getCached('npm:express')).toBe('5.1.0');
    });

    test('expired entries return null', () => {
      // Manually set old timestamp
      resolver._cache['npm:express'] = { version: '4.0.0', timestamp: Date.now() - 25 * 60 * 60 * 1000 };
      expect(resolver.getCached('npm:express')).toBeNull();
    });

    test('persists cache to file', () => {
      resolver.updateCache('npm:test', '1.0.0');
      expect(fs.existsSync(tmpCacheFile)).toBe(true);
      const data = JSON.parse(fs.readFileSync(tmpCacheFile, 'utf-8'));
      expect(data['npm:test'].version).toBe('1.0.0');
    });
  });

  describe('fallback', () => {
    test('returns version from bundled defaults', () => {
      const version = resolver.getFallback('npm:express');
      // Should find it in defaults/versions.json
      expect(version).toBeTruthy();
      expect(version).toMatch(/^\d+\.\d+/);
    });

    test('returns null for unknown package', () => {
      expect(resolver.getFallback('npm:nonexistent_pkg_xyz')).toBeNull();
    });
  });

  describe('resolve (offline)', () => {
    test('returns cached version without network', async () => {
      resolver.updateCache('npm:express', '5.1.0');
      const version = await resolver.resolve('npm', 'express');
      expect(version).toBe('5.1.0');
    });

    test('falls back to bundled versions when no cache and no network', async () => {
      // No proxy, no cache — should use fallback
      const version = await resolver.resolve('npm', 'express');
      expect(version).toBeTruthy(); // From defaults/versions.json
    });
  });

  describe('getAllCached', () => {
    test('returns all cached entries', () => {
      resolver.updateCache('npm:a', '1.0.0');
      resolver.updateCache('pypi:b', '2.0.0');
      const all = resolver.getAllCached();
      expect(all['npm:a'].version).toBe('1.0.0');
      expect(all['pypi:b'].version).toBe('2.0.0');
    });
  });
});
