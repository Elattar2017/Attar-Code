#!/usr/bin/env python3
"""
plugins/helpers/python_ast.py — Analyze Python source files using the ast module.

Usage: python python_ast.py <filepath>
Output: JSON with functions, classes, imports, exports.

Used by plugins/languages/python.js analyzeSource() for test generation Phase 1.
"""

import ast
import json
import sys
import os


def analyze_file(filepath):
    """Parse a Python file and extract functions, classes, imports, exports."""
    result = {
        "functions": [],
        "classes": [],
        "imports": [],
        "exports": [],
    }

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            source = f.read()
        tree = ast.parse(source, filename=filepath)
    except (SyntaxError, UnicodeDecodeError) as e:
        result["error"] = str(e)
        return result

    has_unparse = hasattr(ast, "unparse")

    for node in ast.iter_child_nodes(tree):
        # ─── Functions ───────────────────────────────────────────────────
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            params = []
            for arg in node.args.args:
                ptype = None
                if arg.annotation and has_unparse:
                    ptype = ast.unparse(arg.annotation)
                elif arg.annotation:
                    ptype = _annotation_str(arg.annotation)
                params.append({"name": arg.arg, "type": ptype})

            ret_type = None
            if node.returns:
                ret_type = ast.unparse(node.returns) if has_unparse else _annotation_str(node.returns)

            decorators = []
            for d in node.decorator_list:
                decorators.append(ast.unparse(d) if has_unparse else _annotation_str(d))

            result["functions"].append({
                "name": node.name,
                "params": params,
                "isAsync": isinstance(node, ast.AsyncFunctionDef),
                "line": node.lineno,
                "returnType": ret_type,
                "decorators": decorators,
            })

        # ─── Classes ─────────────────────────────────────────────────────
        elif isinstance(node, ast.ClassDef):
            methods = []
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    methods.append(item.name)

            bases = []
            for b in node.bases:
                bases.append(ast.unparse(b) if has_unparse else _annotation_str(b))

            result["classes"].append({
                "name": node.name,
                "methods": methods,
                "bases": bases,
                "line": node.lineno,
            })

        # ─── Imports ─────────────────────────────────────────────────────
        elif isinstance(node, ast.Import):
            for alias in node.names:
                result["imports"].append({
                    "module": alias.name,
                    "alias": alias.asname,
                    "names": [],
                    "isExternal": not alias.name.startswith("."),
                })

        elif isinstance(node, ast.ImportFrom):
            names = [a.name for a in node.names]
            module = node.module or ""
            is_relative = (node.level or 0) > 0
            result["imports"].append({
                "module": ("." * (node.level or 0)) + module,
                "alias": None,
                "names": names,
                "isExternal": not is_relative and not module.startswith("."),
            })

        # ─── Exports (__all__) ───────────────────────────────────────────
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "__all__":
                    if isinstance(node.value, (ast.List, ast.Tuple)):
                        for elt in node.value.elts:
                            if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                                result["exports"].append(elt.value)

    return result


def _annotation_str(node):
    """Fallback annotation stringifier for Python < 3.9 (no ast.unparse)."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return f"{_annotation_str(node.value)}.{node.attr}"
    if isinstance(node, ast.Subscript):
        return f"{_annotation_str(node.value)}[{_annotation_str(node.slice)}]"
    if isinstance(node, ast.Constant):
        return repr(node.value)
    if isinstance(node, ast.Tuple):
        return ", ".join(_annotation_str(e) for e in node.elts)
    return str(type(node).__name__)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python python_ast.py <filepath>"}))
        sys.exit(1)

    filepath = sys.argv[1]
    if not os.path.isfile(filepath):
        print(json.dumps({"error": f"File not found: {filepath}"}))
        sys.exit(1)

    result = analyze_file(filepath)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
