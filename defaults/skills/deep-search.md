# Deep Search & Research Skill
# trigger: deep.*search|research|investigate|find.*solution|look.*up|documentation|how.*implement|best.*way

## When to Use Each Search Tool

### web_search — Quick lookup (snippets only)
- Simple factual questions: "what port does Express default to"
- Quick error lookup: "TS2749 refers to value used as type"
- Returns: titles + URLs + 1-2 sentence snippets
- Follow up with web_fetch to read the full page

### search_docs — Official documentation
- Technology-specific errors: search_docs("typescript", "TS2749")
- API reference: search_docs("express", "Router.use middleware")
- Targets official docs site (typescriptlang.org, react.dev, etc.)
- Returns: titles + URLs + snippets from the official docs only

### deep_search — Full investigation (fetches and reads pages)
- Complex errors that need full context
- Unfamiliar APIs or patterns you haven't seen before
- When web_search snippets aren't enough
- Returns: full page content + code examples extracted from top 3-5 pages
- Use follow_up_query to refine if first results miss the mark

### research — Multi-source deep research
- Complex topics requiring multiple sources
- Automatically: searches → fetches top 2 pages → extracts code → combines
- Best for: "how to implement X pattern" where you need examples

### search_all — Web + Knowledge Base combined
- When you want both internet results AND local documents
- Good for: "how does our project handle authentication" (checks KB + web)

## Deep Search Strategy for Error Resolution

### Step 1: Identify the Error
Read the EXACT error message. Don't paraphrase. Copy the error code if present.

### Step 2: Choose the Right Tool
- Known error code (TS2749, E0382) → search_docs first
- Unknown error message → deep_search with the exact message
- Framework-specific issue → search_docs with framework name
- Complex/multi-part error → research for comprehensive analysis

### Step 3: Read the Results
- Don't just read the snippet — if deep_search returns full page content, read it carefully
- Look for code examples that match your situation
- Check the date — old solutions may not apply to current versions

### Step 4: Apply and Verify
- Apply the fix from search results
- Run build_and_test to verify
- If the fix didn't work, deep_search with a MORE specific query including what you tried

## Query Writing Best Practices
- EXACT error messages: "TS2749: 'User' refers to a value, but is being used as a type here"
- Include technology + version: "Express 4 TypeScript extend Request type"
- Include what you're trying to do: "Express middleware add custom property to Request TypeScript"
- If first search fails, try the error + "solution" or "fix": "TS2749 solution TypeScript"
- Use follow_up_query in deep_search for refinement without starting over

## Anti-Patterns (Don't Do This)
- Don't search for vague terms like "TypeScript error" — too broad
- Don't ignore search results and guess the fix anyway
- Don't search the same query twice — refine it instead
- Don't skip reading the full page when code examples are available
- Don't assume the first search result is always correct — check 2-3 sources
