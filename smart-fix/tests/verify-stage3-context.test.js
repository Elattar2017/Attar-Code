const { extractEnclosingFunction } = require("../function-extractor");
const { buildComplexContext } = require("../fix-engine/tier3-complex");

describe("Stage 3 Verification: Function Extraction Edge Cases", () => {
  test("TypeScript: async arrow function", () => {
    const code = "import { db } from './db';\n\nconst fetchUser = async (id: string) => {\n  const user = await db.query(id);\n  if (!user) {\n    throw new Error('Not found');\n  }\n  return user.rows[0];\n};\n\nexport default fetchUser;";
    const result = extractEnclosingFunction(code, 6, "TypeScript");
    expect(result.name).toBe("fetchUser");
    expect(result.code).toContain("async");
    expect(result.code).toContain("return user.rows[0]");
  });

  test("Python: class method", () => {
    const code = "class UserService:\n    def __init__(self, db):\n        self.db = db\n\n    def get_user(self, user_id):\n        result = self.db.query(user_id)\n        if not result:\n            raise ValueError('Not found')\n        return result\n\n    def delete_user(self, user_id):\n        pass";
    const result = extractEnclosingFunction(code, 7, "Python");
    expect(result.name).toBe("get_user");
    expect(result.code).toContain("def get_user");
    expect(result.code).toContain("return result");
  });

  test("Rust: pub fn with return type", () => {
    const code = "struct App { name: String }\n\nimpl App {\n    pub fn new(name: &str) -> Self {\n        App { name: name.to_string() }\n    }\n\n    pub fn run(&self) -> Result<(), Box<dyn std::error::Error>> {\n        let config = self.load_config()?;\n        self.start(config)?;\n        Ok(())\n    }\n}";
    const result = extractEnclosingFunction(code, 10, "Rust");
    expect(result.name).toBe("run");
    expect(result.code).toContain("pub fn run");
    expect(result.code).toContain("Ok(())");
  });

  test("Java: method with annotation on previous line", () => {
    const code = "public class UserController {\n    private final UserService service;\n\n    @GetMapping(\"/users/{id}\")\n    public ResponseEntity<User> getUser(@PathVariable Long id) {\n        User user = service.findById(id);\n        if (user == null) {\n            return ResponseEntity.notFound().build();\n        }\n        return ResponseEntity.ok(user);\n    }\n}";
    const result = extractEnclosingFunction(code, 7, "Java");
    expect(result.name).toBe("getUser");
    expect(result.code).toContain("getUser");
  });

  test("Go: method receiver", () => {
    const code = "package main\n\nimport \"fmt\"\n\nfunc (s *Server) handleRequest(w http.ResponseWriter, r *http.Request) {\n    data := s.fetchData(r.URL.Path)\n    if data == nil {\n        http.Error(w, \"not found\", 404)\n        return\n    }\n    fmt.Fprintf(w, \"%v\", data)\n}";
    const result = extractEnclosingFunction(code, 8, "Go");
    expect(result.code).toContain("handleRequest");
  });

  test("PHP: class method", () => {
    const code = "<?php\nclass UserController {\n    public function index(Request $request) {\n        $users = User::all();\n        $filtered = array_filter($users);\n        return json_encode($filtered);\n    }\n\n    public function show($id) {\n        return User::find($id);\n    }\n}";
    const result = extractEnclosingFunction(code, 5, "PHP");
    expect(result.name).toBe("index");
    expect(result.code).toContain("function index");
  });

  test("fallback for unsupported language", () => {
    const code = Array.from({ length: 40 }, (_, i) => "line " + (i + 1)).join("\n");
    const result = extractEnclosingFunction(code, 20, "Haskell");
    expect(result.startLine).toBe(5);
    expect(result.endLine).toBe(35);
    expect(result.name).toBeNull();
  });

  test("buildComplexContext includes Language in prompt", () => {
    const error = { file: "main.go", line: 5, code: "ERR", message: "undefined: foo", fixHint: null };
    const content = "package main\n\nfunc main() {\n\tx := 1\n\tfoo(x)\n}\n";
    const result = buildComplexContext(error, content, null, null);
    expect(result.promptBlock).toContain("Go");
  });
});
