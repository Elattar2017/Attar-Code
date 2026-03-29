// smart-fix/graph-builder.js
class DependencyGraph {
  constructor() {
    this.nodes = new Map();       // filePath → fileAnalysis
    this.edges = new Map();       // filePath → Set(dependencyFilePath)
    this.reverseEdges = new Map(); // filePath → Set(dependentFilePath)
    this.edgeSymbols = new Map(); // "from|to" → [symbols]
  }

  addNode(filePath, analysis) {
    this.nodes.set(filePath, analysis);
    if (!this.edges.has(filePath)) this.edges.set(filePath, new Set());
    if (!this.reverseEdges.has(filePath)) this.reverseEdges.set(filePath, new Set());
  }

  removeNode(filePath) {
    // Clean up forward edges
    const deps = this.edges.get(filePath) || new Set();
    for (const dep of deps) {
      const rev = this.reverseEdges.get(dep);
      if (rev) rev.delete(filePath);
      this.edgeSymbols.delete(`${filePath}|${dep}`);
    }
    // Clean up reverse edges
    const dependents = this.reverseEdges.get(filePath) || new Set();
    for (const dep of dependents) {
      const fwd = this.edges.get(dep);
      if (fwd) fwd.delete(filePath);
      this.edgeSymbols.delete(`${dep}|${filePath}`);
    }
    this.nodes.delete(filePath);
    this.edges.delete(filePath);
    this.reverseEdges.delete(filePath);
  }

  hasNode(filePath) {
    return this.nodes.has(filePath);
  }

  getNode(filePath) {
    return this.nodes.get(filePath) || null;
  }

  addEdge(fromFile, toFile, symbols) {
    if (!this.edges.has(fromFile)) this.edges.set(fromFile, new Set());
    if (!this.reverseEdges.has(toFile)) this.reverseEdges.set(toFile, new Set());
    this.edges.get(fromFile).add(toFile);
    this.reverseEdges.get(toFile).add(fromFile);
    this.edgeSymbols.set(`${fromFile}|${toFile}`, symbols);
  }

  getDependenciesOf(filePath) {
    return [...(this.edges.get(filePath) || [])];
  }

  getDependentsOf(filePath) {
    return [...(this.reverseEdges.get(filePath) || [])];
  }

  getTransitiveDependentsOf(filePath) {
    const visited = new Set();
    const queue = [filePath];
    while (queue.length > 0) {
      const current = queue.shift();
      const dependents = this.reverseEdges.get(current) || new Set();
      for (const dep of dependents) {
        if (!visited.has(dep)) {
          visited.add(dep);
          queue.push(dep);
        }
      }
    }
    return [...visited];
  }

  getImportedSymbols(fromFile, toFile) {
    return this.edgeSymbols.get(`${fromFile}|${toFile}`) || [];
  }

  getAllExports() {
    const result = {};
    for (const [filePath, analysis] of this.nodes) {
      result[filePath] = analysis.exports.flatMap(e => e.symbols);
    }
    return result;
  }

  getNodeCount() {
    return this.nodes.size;
  }

  getAllFiles() {
    return [...this.nodes.keys()];
  }

  detectCycles() {
    const cycles = [];
    const visited = new Set();
    const inStack = new Set();

    for (const startNode of this.nodes.keys()) {
      if (visited.has(startNode)) continue;
      const stack = [[startNode, [...(this.edges.get(startNode) || [])]]];
      const pathStack = [startNode];
      visited.add(startNode);
      inStack.add(startNode);

      while (stack.length > 0) {
        const [node, neighbors] = stack[stack.length - 1];
        if (neighbors.length === 0) {
          stack.pop();
          pathStack.pop();
          inStack.delete(node);
          continue;
        }
        const dep = neighbors.pop();
        if (!visited.has(dep)) {
          visited.add(dep);
          inStack.add(dep);
          pathStack.push(dep);
          stack.push([dep, [...(this.edges.get(dep) || [])]]);
        } else if (inStack.has(dep)) {
          const cycleStart = pathStack.indexOf(dep);
          if (cycleStart >= 0) cycles.push(pathStack.slice(cycleStart));
        }
      }
    }

    return cycles;
  }

  clear() {
    this.nodes.clear();
    this.edges.clear();
    this.reverseEdges.clear();
    this.edgeSymbols.clear();
  }
}

module.exports = { DependencyGraph };
