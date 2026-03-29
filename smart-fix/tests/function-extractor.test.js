// smart-fix/tests/function-extractor.test.js
const { extractEnclosingFunction } = require("../function-extractor");

describe("Function Extractor", () => {
  test("extracts JavaScript function containing error line", () => {
    const code = `const x = 1;

function processUser(user) {
  const name = user.name;
  const email = user.email;
  const age = user.ag; // error line 6
  return { name, email, age };
}

function other() {}`;
    const result = extractEnclosingFunction(code, 6, "JavaScript");
    expect(result.startLine).toBe(3);
    expect(result.endLine).toBe(8);
    expect(result.name).toBe("processUser");
    expect(result.code).toContain("function processUser");
    expect(result.code).toContain("return { name, email, age }");
  });

  test("extracts Python function", () => {
    const code = `import os

def process_user(user):
    name = user.name
    email = user.email
    age = user.ag  # error line 6
    return name, email, age

def other():
    pass`;
    const result = extractEnclosingFunction(code, 6, "Python");
    expect(result.startLine).toBe(3);
    expect(result.endLine).toBe(7);
    expect(result.name).toBe("process_user");
  });

  test("falls back to ±15 lines when no function found", () => {
    const code = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = extractEnclosingFunction(code, 25, "JavaScript");
    expect(result.startLine).toBe(10);
    expect(result.endLine).toBe(40);
    expect(result.name).toBeNull();
  });

  test("extracts Go function", () => {
    const code = `package main

func processUser(u User) string {
\tname := u.Name
\temail := u.Email
\tage := u.Ag // error line 6
\treturn name
}`;
    const result = extractEnclosingFunction(code, 6, "Go");
    expect(result.startLine).toBe(3);
    expect(result.name).toBe("processUser");
  });

  test("Kotlin: fun keyword", () => {
    const code = "class App {\n    fun processUser(id: Int): User {\n        val user = db.find(id)\n        if (user == null) {\n            throw Exception(\"Not found\")\n        }\n        return user\n    }\n}";
    const result = extractEnclosingFunction(code, 5, "Kotlin");
    expect(result.name).toBe("processUser");
    expect(result.code).toContain("fun processUser");
  });

  test("C++: function with return type", () => {
    const code = "#include <iostream>\n\nvoid processUser(int id) {\n    auto user = db.find(id);\n    if (!user) {\n        throw std::runtime_error(\"not found\");\n    }\n    std::cout << user.name;\n}";
    const result = extractEnclosingFunction(code, 6, "C++");
    expect(result.name).toBe("processUser");
    expect(result.code).toContain("processUser");
  });

  test("Dart: method extraction", () => {
    const code = "class UserService {\n  Future<User> getUser(int id) async {\n    final user = await db.find(id);\n    if (user == null) {\n      throw Exception('Not found');\n    }\n    return user;\n  }\n}";
    const result = extractEnclosingFunction(code, 5, "Dart");
    expect(result.name).toBe("getUser");
    expect(result.code).toContain("getUser");
  });
});
