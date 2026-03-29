'use strict';

const { OSAbstraction, INSTALL_HINTS } = require('../os-abstraction');

describe('OSAbstraction', () => {
  describe('platform detection', () => {
    test('platform is a valid string', () => {
      expect(['win32', 'darwin', 'linux']).toContain(OSAbstraction.platform);
    });

    test('exactly one of isWin/isMac/isLinux is true', () => {
      const flags = [OSAbstraction.isWin, OSAbstraction.isMac, OSAbstraction.isLinux];
      expect(flags.filter(Boolean).length).toBe(1);
    });

    test('osName returns human-readable name', () => {
      expect(['Windows', 'macOS', 'Linux']).toContain(OSAbstraction.osName);
    });

    test('pythonBinary is platform-correct', () => {
      if (OSAbstraction.isWin) {
        expect(OSAbstraction.pythonBinary).toBe('python');
      } else {
        expect(OSAbstraction.pythonBinary).toBe('python3');
      }
    });
  });

  describe('exec', () => {
    test('returns trimmed output', () => {
      const result = OSAbstraction.exec('echo hello');
      expect(result).toBe('hello');
    });

    test('silent mode returns null on failure', () => {
      const result = OSAbstraction.exec('nonexistent_command_12345', { silent: true });
      expect(result).toBeNull();
    });

    test('throws on failure without silent', () => {
      expect(() => OSAbstraction.exec('nonexistent_command_12345')).toThrow();
    });
  });

  describe('which', () => {
    test('finds node binary', () => {
      const result = OSAbstraction.which('node');
      expect(result).toBeTruthy();
    });

    test('returns null for nonexistent binary', () => {
      expect(OSAbstraction.which('nonexistent_binary_xyz_12345')).toBeNull();
    });
  });

  describe('getVersion', () => {
    test('gets node version', () => {
      const result = OSAbstraction.getVersion('node');
      expect(result).not.toBeNull();
      expect(result.version).toMatch(/^\d+\.\d+/);
    });

    test('returns null for nonexistent binary', () => {
      expect(OSAbstraction.getVersion('nonexistent_xyz')).toBeNull();
    });
  });

  describe('activateVenv', () => {
    test('returns platform-correct activation command', () => {
      const cmd = OSAbstraction.activateVenv('.venv');
      if (OSAbstraction.isWin) {
        expect(cmd).toContain('Scripts\\activate');
      } else {
        expect(cmd).toContain('bin/activate');
      }
    });
  });

  describe('checkVenv', () => {
    test('reports nonexistent venv', () => {
      const result = OSAbstraction.checkVenv('/nonexistent/path');
      expect(result.exists).toBe(false);
    });
  });

  describe('normalizePath', () => {
    test('uses forward slashes', () => {
      const result = OSAbstraction.normalizePath('some\\path\\file.txt');
      expect(result).not.toContain('\\');
    });
  });

  describe('getInstallHint', () => {
    test('returns install command for known tools', () => {
      expect(OSAbstraction.getInstallHint('node')).toBeTruthy();
      expect(OSAbstraction.getInstallHint('python')).toBeTruthy();
      expect(OSAbstraction.getInstallHint('cargo')).toBeTruthy();
    });

    test('returns null for unknown tools', () => {
      expect(OSAbstraction.getInstallHint('nonexistent_tool')).toBeNull();
    });

    test('is case-insensitive', () => {
      expect(OSAbstraction.getInstallHint('Node')).toBeTruthy();
    });
  });

  describe('INSTALL_HINTS', () => {
    test('every tool has all three platforms', () => {
      for (const [tool, hints] of Object.entries(INSTALL_HINTS)) {
        expect(hints).toHaveProperty('win32');
        expect(hints).toHaveProperty('darwin');
        expect(hints).toHaveProperty('linux');
      }
    });
  });
});
