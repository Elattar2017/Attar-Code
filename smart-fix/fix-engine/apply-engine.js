// smart-fix/fix-engine/apply-engine.js
// Applies patches to files with backup and revert capability

const fs = require("fs");
const path = require("path");

// In-memory backup store: Map<filePath, string[]> (last 3 versions)
const backups = new Map();
const MAX_BACKUPS_PER_FILE = 3;

/**
 * Apply a patch to a file on disk.
 * @param {string} filePath - Absolute path to the file
 * @param {object} patch - { line, oldText, newText } or { insertAtLine, text } or { deleteLine }
 * @param {object} tree - TreeManager instance (optional, for updating dependency graph)
 * @returns {object} { success, backupContent, newContent, linesChanged, error? }
 */
function applyPatch(filePath, patch, tree) {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: `File not found: ${filePath}` };
    }

    const originalContent = fs.readFileSync(filePath, "utf-8");

    // Store backup
    if (!backups.has(filePath)) backups.set(filePath, []);
    const fileBackups = backups.get(filePath);
    fileBackups.push(originalContent);
    if (fileBackups.length > MAX_BACKUPS_PER_FILE) fileBackups.shift();

    const lines = originalContent.split("\n");
    let newContent;
    let linesChanged = 0;

    if (patch.type === "replace_line" || patch.oldText !== undefined) {
      // Replace text on a specific line
      const lineIdx = (patch.line || 1) - 1;
      if (lineIdx >= 0 && lineIdx < lines.length) {
        if (patch.oldText && lines[lineIdx].includes(patch.oldText)) {
          lines[lineIdx] = lines[lineIdx].replace(patch.oldText, patch.newText);
          linesChanged = 1;
        } else if (patch.newText !== undefined) {
          lines[lineIdx] = patch.newText;
          linesChanged = 1;
        }
      }
      newContent = lines.join("\n");
    } else if (patch.type === "insert") {
      // Insert text at a specific line
      const insertIdx = (patch.insertAtLine || 1) - 1;
      lines.splice(Math.max(0, insertIdx), 0, patch.text);
      linesChanged = 1;
      newContent = lines.join("\n");
    } else if (patch.type === "delete_line") {
      // Delete a specific line
      const deleteIdx = (patch.deleteLine || 1) - 1;
      if (deleteIdx >= 0 && deleteIdx < lines.length) {
        lines.splice(deleteIdx, 1);
        linesChanged = 1;
      }
      newContent = lines.join("\n");
    } else if (patch.type === "replace_content") {
      // Full content replacement
      newContent = patch.newContent;
      linesChanged = originalContent.split("\n").length;
    } else {
      return { success: false, error: `Unknown patch type: ${patch.type}` };
    }

    if (linesChanged === 0) {
      return { success: false, error: "Patch did not match any content" };
    }

    // Write the fixed file
    fs.writeFileSync(filePath, newContent, "utf-8");

    // Update dependency tree if available
    if (tree && typeof tree.updateFile === "function") {
      try { tree.updateFile(filePath); } catch (_) {}
    }

    return { success: true, backupContent: originalContent, newContent, linesChanged };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Revert a file to its backup content.
 * @param {string} filePath - Absolute path
 * @param {string} backupContent - Content to restore (or null to use stored backup)
 * @param {object} tree - TreeManager instance (optional)
 * @returns {boolean} success
 */
function revertPatch(filePath, backupContent, tree) {
  try {
    const content = backupContent || (backups.has(filePath) ? backups.get(filePath).pop() : null);
    if (!content) return false;
    fs.writeFileSync(filePath, content, "utf-8");
    if (tree && typeof tree.updateFile === "function") {
      try { tree.updateFile(filePath); } catch (_) {}
    }
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Clear all backups (call after successful build).
 */
function clearBackups() {
  backups.clear();
}

/**
 * Get backup content for a file.
 */
function getBackup(filePath) {
  const fileBackups = backups.get(filePath);
  return fileBackups && fileBackups.length > 0 ? fileBackups[fileBackups.length - 1] : null;
}

module.exports = { applyPatch, revertPatch, clearBackups, getBackup };
