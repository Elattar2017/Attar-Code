# Testing Skill
# trigger: test|spec|assert|expect|jest|mocha|pytest|unittest|coverage|mock|stub|e2e|integration|unit

## Testing Strategy
- Unit tests: test individual functions/methods in isolation
- Integration tests: test components working together (API → DB, service → service)
- E2E tests: test full user flows (login → browse → add to cart → checkout)
- Aim for testing pyramid: many unit tests, fewer integration, fewest E2E

## Writing Good Tests
- Test behavior, not implementation — tests should survive refactoring
- One assertion per test (or closely related assertions)
- Descriptive test names: "should return 404 when user not found" not "test1"
- Arrange-Act-Assert pattern: setup data → call function → verify result
- Test happy path AND error paths AND edge cases
- Use factories/fixtures for test data — don't hardcode in every test

## API Testing with test_endpoint
- Test each endpoint: correct status code + response body structure
- Test with valid data (200/201) and invalid data (400/422)
- Test auth: without token (401), with invalid token (401), with valid token (200)
- Test not found: request non-existent resource (404)
- Test pagination: verify meta.page, meta.total, data.length
- Test filters: apply filter, verify all results match

## Common Test Patterns
- Mock external services (APIs, databases) — don't hit real services in tests
- Use beforeEach/setUp to reset state between tests
- Use afterEach/tearDown to clean up (close connections, clear mocks)
- Test boundary values: empty string, 0, negative, max int, very long string
- Test concurrent access if relevant (race conditions)
- Snapshot tests for UI components — verify rendering doesn't change unexpectedly

## Test Organization
- Mirror source structure: src/utils/calc.ts → tests/utils/calc.test.ts
- Group related tests with describe/context blocks
- Keep test files close to source (same directory or parallel test/ directory)
- Name test files consistently: *.test.ts, *.spec.ts, test_*.py
