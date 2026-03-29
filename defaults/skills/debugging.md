# Debugging Skill
# trigger: debug|bug|error|fix|broken|not working|crash|fail|exception|stack trace|500|404|undefined|null

## Debugging Methodology (NEVER skip steps)

### Step 1: Read the Error
- Read the FULL error message — not just the first line
- Identify: file name, line number, error type, error message
- If it's a build error: use build_and_test to get structured output with per-file error counts

### Step 2: Locate the Source
- If the error gives a file + line: use read_file to see that exact location
- If no file given: use grep_search to find the error source
- If it's a server error (500): use get_server_logs to see the server-side stack trace
- If it's a runtime error: add console.log/print BEFORE the failing line, re-run, read the output

### Step 3: Understand the Root Cause
- Don't fix symptoms — fix the root cause
- "Cannot find name 'X'" → X is not imported or not defined in scope
- "Type X is not assignable to Y" → check both types, find the mismatch
- "Cannot read properties of undefined" → something is null/undefined before access
- "Module not found" → wrong import path or missing dependency
- "ECONNREFUSED" → server not running on that port

### Step 4: Search Before Guessing
- If you don't immediately know the fix: call search_docs or web_search
- Use the EXACT error message as the search query
- Read the search results — don't just guess from the snippet
- If the search result links to official docs, use web_fetch to read the full page

### Step 5: Fix and Verify
- Make the smallest possible fix — don't rewrite the entire file
- Use edit_file for targeted changes (not write_file for rewrites)
- After fixing: call build_and_test to verify the fix worked
- If the fix didn't work: DON'T retry the same fix. Go back to Step 1 with the new error

## Common Debugging Anti-Patterns (AVOID THESE)
- Editing the same file 3+ times without checking if the build passes
- Fixing a file that has 1 error when another file has 10 errors
- Guessing the fix without reading the error message carefully
- Retrying the same command that already failed
- Adding more code instead of fixing the broken code
- Reading the same file repeatedly without making changes

## Server Error Debugging
1. Call get_server_logs to see the server's console output
2. Find the stack trace — it shows the exact file and line that crashed
3. Read that file at that line with read_file
4. The error is usually: missing import, wrong variable name, null access, wrong type
5. Fix with edit_file, restart server with start_server, test with test_endpoint

## Build Error Debugging
1. Call build_and_test — it gives you a prioritized list of files with error counts
2. Fix the file with the MOST errors first
3. Read each error: file(line,col): error CODE: message
4. Fix errors in order — often fixing one fixes others in the same file
5. After fixing one file: call build_and_test again to see remaining errors
6. If stuck on same error 3+ times: call search_docs or web_search
