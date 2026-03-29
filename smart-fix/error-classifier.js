// smart-fix/error-classifier.js

function classifyErrors(parsedErrors, tree, plugin) {
  if (!plugin?.errorCatalog?.categories) return parsedErrors.map(e => ({ ...e, crossFileProbability: 0.5, originFile: null, originType: "unknown", fixHint: null }));

  // Build lookup from plugin
  const errorLookup = new Map();
  for (const cat of plugin.errorCatalog.categories) {
    for (const err of cat.errors) {
      errorLookup.set(err.code, err);
    }
  }

  return parsedErrors.map(error => {
    const catalogEntry = errorLookup.get(error.code);
    if (!catalogEntry) {
      return { ...error, crossFileProbability: 0.5, originFile: null, originType: "unknown", fixHint: null };
    }

    let crossFileProbability = catalogEntry.baseCrossFileProbability;
    let originFile = null;
    let originType = crossFileProbability > 0.5 ? "likely_cross_file" : "likely_local";

    // Extract captures from message
    let captures = {};
    if (catalogEntry.messagePattern) {
      try {
        const match = error.message.match(new RegExp(catalogEntry.messagePattern));
        if (match?.groups) captures = match.groups;
        else if (match) {
          // Positional captures
          (catalogEntry.captures || []).forEach((cap, i) => {
            if (match[i + 1]) captures[cap.name] = match[i + 1];
          });
        }
      } catch (e) { /* regex failed */ }
    }

    // Apply refinements using tree and resolve originFile
    if (tree && catalogEntry.refinements) {
      for (const ref of catalogEntry.refinements) {
        const targetValue = captures[ref.check.target];
        if (!targetValue) continue;

        let matches = false;
        let resolvedOrigin = null;
        const analysis = tree.getFileAnalysis?.(error.file);

        switch (ref.check.type) {
          case "is_imported": {
            if (analysis) {
              const matchingImport = analysis.imports.find(imp =>
                !imp.isExternal && imp.symbols.some(s => s === targetValue || s.startsWith(targetValue + " as "))
              );
              if (matchingImport) {
                matches = true;
                // Resolve the import source to actual file path
                resolvedOrigin = tree._resolveImportPath?.(error.file, matchingImport.rawSource) || null;
              }
            }
            break;
          }
          case "is_local": {
            if (analysis) {
              matches = analysis.definitions.some(d => d.name === targetValue);
            }
            break;
          }
          case "is_external": {
            if (analysis) {
              matches = analysis.imports.some(imp => imp.isExternal && imp.symbols.some(s => s === targetValue || s.includes(targetValue)));
            }
            break;
          }
          default:
            break;
        }

        if (matches) {
          crossFileProbability = ref.adjustedProbability;
          originType = ref.traceTarget || originType;
          if (resolvedOrigin) originFile = resolvedOrigin;
          break; // First matching refinement wins
        }
      }
    }

    // Recursive tracing — follow import chain to find true root cause
    let originChain = [];
    if (originFile && tree) {
      let current = originFile;
      const visited = new Set([error.file]);
      const MAX_DEPTH = 5;
      for (let depth = 0; depth < MAX_DEPTH; depth++) {
        if (visited.has(current)) break;
        visited.add(current);
        originChain.push(current);
        const currentAnalysis = tree.getFileAnalysis?.(current);
        if (!currentAnalysis) break;
        const targetSymbol = captures.symbol || captures.symbolName || captures.name || captures.expected || captures.wrong || Object.values(captures)[0];
        if (!targetSymbol) break;
        const reExport = currentAnalysis.imports?.find(imp =>
          !imp.isExternal && imp.symbols.some(s => s === targetSymbol || s.startsWith(targetSymbol + " as "))
        );
        if (!reExport) break; // Symbol is defined here — this is the root
        const deeper = tree._resolveImportPath?.(current, reExport.rawSource);
        if (!deeper || deeper === current) break;
        current = deeper;
      }
      if (originChain.length > 0) {
        originFile = originChain[originChain.length - 1];
      }
    }

    // If probability is high but originFile not yet set, try to find it from imports
    if (crossFileProbability > 0.5 && !originFile && tree) {
      const analysis = tree.getFileAnalysis?.(error.file);
      if (analysis) {
        for (const imp of analysis.imports) {
          if (imp.isExternal) continue;
          const resolved = tree._resolveImportPath?.(error.file, imp.rawSource);
          if (resolved && imp.symbols.some(s => {
            const clean = s.includes(" as ") ? s.split(" as ")[0].trim() : s;
            return Object.values(captures).includes(clean);
          })) {
            originFile = resolved;
            break;
          }
        }
      }
    }

    return {
      ...error,
      captures,
      crossFileProbability,
      originFile,
      originChain,
      originType,
      fixHint: catalogEntry.fixHint || null,
      coOccurrence: catalogEntry.coOccurrence || [],
    };
  });
}

module.exports = { classifyErrors };
