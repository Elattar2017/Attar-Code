# Code Review Skill
# trigger: review|refactor|clean|optimize|improve|quality|lint|best.?practice|code.?smell|dry|solid

## Review Checklist
Before declaring code "done", verify:
1. Does it handle errors? Every async operation needs try/catch or .catch()
2. Does it validate input? Never trust data from users, APIs, or files
3. Are there magic numbers/strings? Extract to named constants
4. Is there code duplication? Extract to shared functions if 3+ occurrences
5. Are function names descriptive? Should describe WHAT not HOW
6. Are types correct? No 'any' in TypeScript — use proper interfaces
7. Is it testable? Pure functions where possible, dependency injection for side effects
8. Are edge cases handled? Empty arrays, null values, zero, negative numbers

## Common Code Smells
- Function > 30 lines → break into smaller functions
- Function > 3 parameters → use an options object
- Nested if/else > 2 levels → use early returns or guard clauses
- Comments explaining WHAT → code should be self-documenting; comments explain WHY
- Catching errors silently (catch {}) → at minimum log the error
- Hardcoded URLs/ports/secrets → use environment variables or config
- console.log left in production code → use proper logging or remove

## Refactoring Patterns
- Extract Method: long function → smaller named functions
- Guard Clause: nested if → early return for edge cases
- Replace Magic Number: 86400 → SECONDS_PER_DAY
- Introduce Parameter Object: fn(a, b, c, d) → fn({ a, b, c, d })
- Replace Conditional with Polymorphism: if/else chain → strategy pattern
- Decompose Conditional: if (complex && condition) → if (isEligible(user))

## When NOT to Refactor
- Don't refactor working code just for style preferences
- Don't add abstractions for one-time operations
- Don't create helpers for simple 2-line operations
- Three similar lines > one premature abstraction
- Don't change public APIs without checking all callers
