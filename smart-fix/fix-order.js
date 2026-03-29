// smart-fix/fix-order.js

function computeFixOrder(classifiedErrors, ranks) {
  const queue1 = []; // Root cause errors (have downstream dependents that also error)
  const queue2 = []; // Isolated errors (no downstream impact)
  const autoResolvable = []; // Likely auto-resolve when root cause is fixed
  const external = []; // External package errors

  // Group errors by file
  const byFile = new Map();
  for (const err of classifiedErrors) {
    const list = byFile.get(err.file) || [];
    list.push(err);
    byFile.set(err.file, list);
  }

  // Identify which files are origin files for other errors
  const originFiles = new Set();
  for (const err of classifiedErrors) {
    if (err.originFile && err.originFile !== err.file) {
      originFiles.add(err.originFile);
    }
  }

  // Build coOccurrence graph: which error codes appear together?
  const coOccurrenceCount = new Map();
  for (const err of classifiedErrors) {
    if (err.coOccurrence?.length > 0) {
      for (const coCode of err.coOccurrence) {
        if (classifiedErrors.some(e => e.code === coCode)) {
          coOccurrenceCount.set(err.code, (coOccurrenceCount.get(err.code) || 0) + 1);
        }
      }
    }
  }

  // Classify each error group
  for (const [file, errors] of byFile) {
    const rank = ranks.get(file) || { depth: 0, isRoot: false, isLeaf: true, isHub: false, dependentCount: 0, transitiveDependentCount: 0, inCircularDependency: false };

    // Check if ALL errors in this file trace to the SAME origin
    const uniqueOrigins = new Set(errors.map(e => e.originFile).filter(o => o && o !== file));
    const allFromSameOrigin = uniqueOrigins.size === 1;
    const originFile = allFromSameOrigin ? [...uniqueOrigins][0] : null;

    // If all errors trace to another file that ALSO has errors, this group is auto-resolvable
    if (allFromSameOrigin && originFile && byFile.has(originFile)) {
      for (const err of errors) {
        autoResolvable.push({ ...err, autoResolveWhen: originFile });
      }
      continue;
    }

    // Score for sorting within queues
    let score = 0;

    // Depth factor
    if (errors.some(e => e.crossFileProbability > 0.5)) {
      score += rank.depth * 30;
    }

    // CoOccurrence bonus: errors that co-occur with many present errors are likely root causes
    const maxCoOccurrence = Math.max(...errors.map(e => coOccurrenceCount.get(e.code) || 0), 0);
    if (maxCoOccurrence >= 2) score -= 25;

    // Hub bonus for local errors (fix hubs early — unblocks dependents)
    if (rank.isHub && errors.some(e => !e.originFile || e.originFile === file)) {
      const transitiveWeight = Math.min(rank.transitiveDependentCount || rank.dependentCount, 20);
      score -= (10 + transitiveWeight);
    }

    // Leaf bonus (safe to fix, no cascade risk)
    if (rank.isLeaf && errors.every(e => !e.originFile || e.originFile === file)) {
      score -= 30;
    }

    // Hub penalty for cross-file errors (wait for origin to be fixed)
    if (rank.isHub && errors.some(e => e.originFile && e.originFile !== file)) {
      score += 50;
    }

    // Large group penalty
    if (errors.length > 10) score += 15;

    const group = {
      file,
      errors,
      score,
      rank,
      errorCount: errors.length,
    };

    // Route to queue
    if (originFiles.has(file) || (rank.isHub && errors.some(e => !e.originFile || e.originFile === file)) || maxCoOccurrence >= 2 || (rank.isRoot && rank.dependentCount > 0)) {
      queue1.push(group);
    } else {
      queue2.push(group);
    }
  }

  // Sort each queue by score ascending (lower = fix first)
  queue1.sort((a, b) => a.score - b.score);
  queue2.sort((a, b) => a.score - b.score);

  return {
    queue1,
    queue2,
    autoResolvable,
    external,
    stats: {
      totalErrors: classifiedErrors.length,
      rootCauseGroups: queue1.length,
      isolatedGroups: queue2.length,
      autoResolvableCandidates: autoResolvable.length,
      externalErrors: external.length,
    },
  };
}

module.exports = { computeFixOrder };
