# Smart Search & Documentation Skill
# trigger: search|docs|documentation|how to|tutorial|error.*fix|stack.*overflow|official.*docs

## Search Strategy
When you encounter an error or need documentation:

1. IDENTIFY the technology from the error output (TypeScript, React, Express, Go, Rust, Python, Java)
2. USE search_docs for technology-specific documentation — it targets the right official site
3. USE web_search for general programming questions, Stack Overflow solutions, and community answers
4. USE research for complex multi-source research (auto: search → fetch → combine)
5. USE web_fetch to read the full page when search snippets aren't enough

## Error Search Patterns
- TypeScript: search_docs("typescript", "TS2749 refers to value used as type")
- Express: search_docs("express", "Router.use requires middleware function")
- React: search_docs("react", "useEffect cleanup function")
- Python: search_docs("python", "ModuleNotFoundError no module named")
- Go: search_docs("go", "undefined struct field")
- Rust: search_docs("rust", "E0382 borrow of moved value")

## When to Search
- ALWAYS search after the same build error appears twice
- ALWAYS search when you don't recognize an error code (TS2749, E0382, etc.)
- ALWAYS search before guessing a fix for an unfamiliar API
- ALWAYS search when the user asks "how to" do something you're not 100% sure about

## Search Query Best Practices
- Use the EXACT error message, not a paraphrase
- Include the technology name: "TypeScript TS2749" not just "TS2749"
- Include the specific API or function name if relevant
- Keep queries short (5-10 words) for best results
- If first search returns irrelevant results, try a more specific query

## Multi-Source Research
For complex questions, use the `research` tool which automatically:
1. Searches the web for your query
2. Fetches the top 2-3 results in full
3. Combines everything into a comprehensive answer
This saves you from doing search → fetch → fetch manually.

## Official Documentation Sites
- TypeScript: typescriptlang.org
- React: react.dev
- Express: expressjs.com
- Node.js: nodejs.org
- Next.js: nextjs.org
- Go: pkg.go.dev
- Rust: doc.rust-lang.org
- Python: docs.python.org
- Java: docs.oracle.com
- Prisma: prisma.io
- Docker: docs.docker.com
