# Backend Development Skill
# trigger: api|rest|endpoint|server|express|flask|fastapi|spring|controller|route|middleware|crud

## Architecture Rules
- Separate concerns: routes → controllers → services → data layer
- Routes ONLY define HTTP method + path + middleware chain. No business logic in routes.
- Controllers handle request/response. Parse input, call services, format output.
- Services contain business logic. Never import express/http objects.
- Use consistent response format: { success: boolean, data: T, error?: { code, message } }
- Use proper HTTP status codes: 200 OK, 201 Created, 204 No Content, 400 Bad Request, 401 Unauthorized, 404 Not Found, 500 Internal Error

## Error Handling
- Wrap all async handlers in try/catch
- Create a custom AppError class with statusCode and code properties
- Use a global error handler middleware (must have 4 params: err, req, res, next)
- Never expose stack traces in production — only in development
- Validate ALL input with a schema validator (Zod, Joi, Yup, etc.)

## Security
- Always validate and sanitize input — never trust user data
- Use parameterized queries — never string-concatenate SQL
- Implement rate limiting on auth endpoints
- Use CORS with explicit allowed origins — never use "*" in production
- Hash passwords with bcrypt (cost factor 12+) — never store plaintext
- Use JWT with expiry for stateless auth — verify on every protected route

## API Design
- Use plural nouns for resources: /api/users not /api/user
- Use HTTP methods correctly: GET=read, POST=create, PUT/PATCH=update, DELETE=remove
- Version your API: /api/v1/users
- Support pagination: ?page=1&perPage=20 — always return { data, meta: { page, total, totalPages } }
- Support filtering and sorting via query params
- Return 201 + Location header for created resources
- Return 204 with empty body for successful deletes

## Testing
- Test every endpoint: happy path + error cases + edge cases
- Use test_endpoint tool to validate responses after starting server
- Check status codes, response body structure, and specific field values
- Test with invalid input to verify validation works
- Test auth: without token (401), with expired token, with valid token
