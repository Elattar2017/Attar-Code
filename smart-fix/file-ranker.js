// smart-fix/file-ranker.js

function rankFiles(graph) {
  const ranks = new Map();
  const files = graph.getAllFiles();
  const cycles = graph.detectCycles();
  const filesInCycles = new Set(cycles.flat());

  // Compute depths via BFS from roots (files with no dependencies)
  const depths = new Map();
  const roots = files.filter(f => graph.getDependenciesOf(f).length === 0);

  // Initialize all depths to -1 (unvisited)
  for (const f of files) depths.set(f, -1);

  // BFS from roots using reverse edges (dependents)
  const queue = [];
  for (const root of roots) {
    depths.set(root, 0);
    queue.push(root);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    const currentDepth = depths.get(current);
    for (const dependent of graph.getDependentsOf(current)) {
      const newDepth = currentDepth + 1;
      if (depths.get(dependent) < newDepth) {
        depths.set(dependent, newDepth);
        queue.push(dependent);
      }
    }
  }

  // Files still at -1 are in pure cycles with no root — assign depth 0
  for (const f of files) {
    if (depths.get(f) === -1) depths.set(f, 0);
  }

  // Compute ranks
  const HUB_THRESHOLD = 3; // file is a hub if 3+ files depend on it

  for (const f of files) {
    const dependents = graph.getDependentsOf(f);
    const dependencies = graph.getDependenciesOf(f);
    const transitiveDependents = graph.getTransitiveDependentsOf(f);
    const dependentCount = dependents.length;
    const transitiveDependentCount = transitiveDependents.length;

    ranks.set(f, {
      file: f,
      depth: depths.get(f),
      dependentCount,
      transitiveDependentCount,
      dependencyCount: dependencies.length,
      hubScore: dependentCount + transitiveDependentCount,
      isLeaf: dependentCount === 0,
      isRoot: dependencies.length === 0,
      isHub: dependentCount >= HUB_THRESHOLD,
      inCircularDependency: filesInCycles.has(f),
    });
  }

  return ranks;
}

module.exports = { rankFiles };
