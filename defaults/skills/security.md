# Security Skill
# trigger: security|xss|csrf|injection|sanitize|encrypt|hash|bcrypt|helmet|cors|rate.?limit|owasp|vulnerability

## OWASP Top 10 Prevention
1. Injection: parameterized queries, input validation, escape output
2. Broken Auth: strong passwords, MFA, secure session management, JWT with expiry
3. Sensitive Data: encrypt at rest + in transit, never log secrets, use env vars
4. XXE: disable external entity processing in XML parsers
5. Access Control: check permissions on every request, deny by default
6. Misconfiguration: remove defaults, disable debug in production, security headers
7. XSS: escape all user output, use CSP headers, avoid raw innerHTML
8. Deserialization: validate input types, use safe parsing (JSON.parse not eval)
9. Vulnerable Dependencies: audit regularly (npm audit, pip audit), update promptly
10. Logging: log security events, don't log sensitive data, monitor for anomalies

## Authentication Best Practices
- Hash passwords with bcrypt (cost 12+) — NEVER store plaintext
- JWT: use RS256 or ES256, set short expiry (15min access, 7d refresh)
- Refresh tokens: store in httpOnly cookie, rotate on use
- Rate limit login attempts: 5 per minute per IP
- Lock accounts after 10 failed attempts
- Never reveal whether email exists in error messages

## HTTP Security Headers
- Content-Security-Policy: restrict script/style sources
- X-Content-Type-Options: nosniff
- X-Frame-Options: DENY (or SAMEORIGIN)
- Strict-Transport-Security: max-age=31536000; includeSubDomains
- Referrer-Policy: strict-origin-when-cross-origin

## Input Validation Rules
- Validate on both client AND server — client validation is UX, server validation is security
- Whitelist valid input patterns — don't blacklist bad patterns
- Limit string lengths, number ranges, array sizes
- Sanitize HTML input if needed (use a dedicated sanitizer library)
- Validate file uploads: check MIME type, extension, and file header bytes
- Reject unexpected fields — don't just ignore them
