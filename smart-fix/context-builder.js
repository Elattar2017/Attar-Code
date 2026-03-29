// smart-fix/context-builder.js
const path = require("path");

function buildCreateFileResponse(filePath, validationResults, projectSummary, fileCount, availableExports) {
  const lines = [`\u2713 Created ${filePath}`];

  // Validation section
  if (validationResults.length > 0) {
    lines.push("", "Validation:");
    for (const v of validationResults) {
      if (v.status === "ok") {
        lines.push(`  \u2713 Line ${v.line}: import from '${v.source}' \u2192 ${v.message}`);
      } else if (v.status === "error") {
        lines.push(`  \u2717 Line ${v.line}: import from '${v.source}' \u2192 WARNING: ${v.message}`);
      } else if (v.status === "external") {
        lines.push(`  \u2713 Line ${v.line}: import from '${v.source}' \u2192 external package`);
      }
    }
  }

  // Available exports section — tells model what it can import from existing files
  if (availableExports && Object.keys(availableExports).length > 0 && fileCount <= 20) {
    const exportEntries = Object.entries(availableExports).filter(([, syms]) => syms.length > 0);
    if (exportEntries.length > 0) {
      lines.push("", "Available imports from existing files:");
      for (const [file, syms] of exportEntries.slice(0, 8)) {
        const basename = path.basename(file).replace(/\.(ts|tsx|js|jsx|py|go|rs)$/, "");
        lines.push(`  ${basename}: ${syms.slice(0, 10).join(", ")}${syms.length > 10 ? ` (+${syms.length - 10} more)` : ""}`);
      }
    }
  }

  // Project structure section (compact for large projects)
  if (fileCount <= 15) {
    lines.push("", "Project structure:", `  ${projectSummary}`);
  }

  return lines.join("\n");
}

function buildEditFileResponse(filePath, updateResult) {
  const lines = [`\u2713 Edited ${filePath}`];

  if (updateResult.exportsChanged) {
    lines.push("", "Changes detected:");
    if (updateResult.addedExports.length > 0) {
      lines.push(`  Added exports: ${updateResult.addedExports.join(", ")}`);
    }
    if (updateResult.removedExports.length > 0) {
      lines.push(`  Removed exports: ${updateResult.removedExports.join(", ")}`);
    }
    if (updateResult.affectedDependents.length > 0) {
      lines.push(`  Dependents that may need updates: ${updateResult.affectedDependents.map(f => path.basename(f)).join(", ")}`);
    }
  }

  return lines.join("\n");
}

function buildBuildErrorAnalysis(fixPlan, totalErrors) {
  const lines = [`\u2717 Build failed: ${totalErrors} errors`, "", "Error Analysis (fix in this order):", ""];

  // Priority 1: Root cause errors
  if (fixPlan.queue1.length > 0) {
    lines.push("Priority 1 \u2014 Fix first (root cause errors):");
    for (const group of fixPlan.queue1) {
      const rankInfo = group.rank.isHub ? `hub file, ${group.rank.dependentCount || 0} dependents` : `depth ${group.rank.depth}`;
      lines.push(`  ${path.basename(group.file)} (${group.errorCount} errors, ${rankInfo}):`);
      for (const err of group.errors.slice(0, 3)) {
        lines.push(`    ${err.code}: ${err.message}`);
      }
      if (group.errors.length > 3) lines.push(`    ... and ${group.errors.length - 3} more`);
    }
    lines.push("");
  }

  // Priority 2: Isolated errors
  if (fixPlan.queue2.length > 0) {
    lines.push("Priority 2 \u2014 Fix next (isolated errors):");
    for (const group of fixPlan.queue2) {
      const safety = group.rank.isLeaf ? "leaf file, safe to fix" : `depth ${group.rank.depth}`;
      lines.push(`  ${path.basename(group.file)} (${group.errorCount} errors, ${safety}):`);
      for (const err of group.errors.slice(0, 2)) {
        lines.push(`    ${err.code}: ${err.message}`);
      }
      if (group.errors.length > 2) lines.push(`    ... and ${group.errors.length - 2} more`);
    }
    lines.push("");
  }

  // Auto-resolvable
  if (fixPlan.autoResolvable.length > 0) {
    lines.push(`May auto-resolve (${fixPlan.autoResolvable.length} errors):`);
    const byOrigin = new Map();
    for (const err of fixPlan.autoResolvable) {
      const list = byOrigin.get(err.autoResolveWhen) || [];
      list.push(err);
      byOrigin.set(err.autoResolveWhen, list);
    }
    for (const [origin, errs] of byOrigin) {
      lines.push(`  ${errs.length} errors trace to ${path.basename(origin)} \u2014 likely auto-resolve after fixing it`);
    }
    lines.push("");
  }

  // Summary
  lines.push(`Suggested approach: Fix Priority 1 first, then rebuild. ${fixPlan.autoResolvable.length} errors may auto-resolve.`);

  return lines.join("\n");
}

module.exports = { buildCreateFileResponse, buildEditFileResponse, buildBuildErrorAnalysis };
