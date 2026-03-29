# CLI Enhancement Findings — E-Commerce Test Analysis

**Date:** 2026-03-26
**Context:** 9 endpoint failures in e-commerce full-stack test

---

## Root Causes of the 9 Failures

| # | Endpoint | Cause | CLI Could Have Helped? |
|---|----------|-------|----------------------|
| 1 | POST /api/cart | Missing auth token in test_endpoint headers | **YES** — detect 401/500 + "req.user" error pattern |
| 2 | GET /api/cart | Same — no auth token | **YES** |
| 3 | POST /api/cart | Same after edit — still no token | **YES** |
| 4 | POST /api/cart | Same | **YES** |
| 5 | POST /api/cart | Same | **YES** |
| 6 | POST /register | Duplicate email — expected behavior | **YES** — detect "unique constraint" and suggest new email |
| 7 | POST /register | Same duplicate | **YES** |
| 8 | POST /register | Same duplicate | **YES** |
| 9 | FAIL (build) | Build error during fix cycle | Already handled |

**8 of 9 failures were preventable with smarter CLI guidance.**

---

## Enhancement 1: Auth Token Chain Detection

**Problem:** Model logs in (gets token), then calls authenticated endpoint WITHOUT passing the token.

**When this happens:**
- test_endpoint returns 401 or 500
- Response or server logs contain "req.user" / "unauthorized" / "jwt" / "token required"
- A previous test_endpoint returned a token in its response body

**Proposed fix in test_endpoint handler:**

When an authenticated endpoint fails with 401/500 and the error mentions auth/user/token:
1. Check recent SESSION.messages for a login response containing a token
2. If found, inject guidance:
```
❌ FAIL — POST /api/cart
Status: 401

⚠ AUTH TOKEN REQUIRED: This endpoint needs authentication.
You logged in earlier and received a token. Use it:
  test_endpoint(
    url: "http://localhost:5000/api/cart",
    method: "POST",
    body: '{"productId": 1, "quantity": 2}',
    headers: '{"Authorization": "Bearer <paste the token from your login response>"}'
  )
```

**Implementation:** ~20 lines in the test_endpoint handler, after the FAIL detection.

---

## Enhancement 2: Duplicate Record Detection

**Problem:** Model tries to register same email twice, gets "unique constraint" error.

**When this happens:**
- test_endpoint returns 400/409
- Response contains "unique" / "duplicate" / "already exists" / "UNIQUE constraint"

**Proposed fix:**
```
❌ FAIL — POST /api/auth/register
Response: {"error": "Email already exists"}

⚠ DUPLICATE RECORD: This email is already registered.
Use a DIFFERENT email address. Try: test_user_N@test.com where N is a random number.
```

**Implementation:** ~10 lines, simple pattern match on response text.

---

## Enhancement 3: Smarter web_search Queries for Auth Errors

**Problem:** Model searched for `"Cannot read properties of undefined (reading 'id')" express` — a generic JS error. The actual problem was missing auth middleware, not a code bug.

**Proposed fix in buildSmartSearchQuery:**
Add auth-specific query patterns:
```javascript
// If error mentions req.user, auth, token, jwt:
if (/req\.user|unauthorized|jwt|token.*required/i.test(errorText)) {
  return "Express JWT authentication middleware req.user undefined fix";
}
```

The search should look for "how to set up auth middleware" not "why is undefined.id failing."

---

## Enhancement 4: Response Value Extraction for Chaining

**Problem:** The model needs to extract a token from a login response and use it in the next request. This requires:
1. Parse JSON response
2. Extract `data.token` field
3. Remember it across tool calls
4. Pass it as headers in the next test_endpoint call

**This is too many steps for a 30B model.**

**Proposed fix — Auto-extract and store auth tokens:**

In test_endpoint, when a response contains a JWT token:
```javascript
// After successful login/register response:
if (responseBody?.data?.token || responseBody?.token) {
  const token = responseBody.data?.token || responseBody.token;
  SESSION._lastAuthToken = token;
  lines.push(`\n💡 AUTH TOKEN received and stored. Use it for authenticated endpoints:`);
  lines.push(`  test_endpoint with headers: {"Authorization": "Bearer ${token.slice(0, 20)}..."}`);
}

// Before making a request, if no auth header but we have a stored token:
if (!reqHeaders["Authorization"] && SESSION._lastAuthToken &&
    !args.url.includes("/auth/") && !args.url.includes("/products")) {
  reqHeaders["Authorization"] = `Bearer ${SESSION._lastAuthToken}`;
  lines.push(`💡 Auto-attached stored auth token to request`);
}
```

**This is the highest-impact enhancement.** It would have prevented all 5 cart failures automatically.

---

## Enhancement 5: web_search Usage Is Too Passive

**Problem:** The CLI only auto-searches after 3+ same-error retries. The model itself rarely calls web_search voluntarily.

**Current behavior:**
- Model gets an error
- Model tries to fix from memory
- After 3 failures: auto-search triggers
- By then, 3 cycles were wasted

**Proposed improvements:**

A) **Auto-search on FIRST 500 error from test_endpoint** (not just after 3 retries):
```javascript
if (actualStatus >= 500 && CONFIG.proxyUrl) {
  // Immediately search — don't wait for retries
  autoSearchForSolution(serverErrorText, "test_endpoint");
}
```

B) **web_fetch after web_search**: Currently auto-search returns snippets. For runtime errors, it should also fetch the top result page for detailed fix instructions.

C) **Search results should be more actionable**: Instead of:
```
💡 Web search for: "Express req.user undefined"
  1. Stack Overflow: Express req.user is undefined...
```

It should be:
```
💡 Web search found: "Express req.user is undefined"
  FIX: You need JWT authentication middleware BEFORE your routes.
  Add: app.use('/api/cart', authMiddleware, cartRoutes);
  The authMiddleware should decode the JWT token from the Authorization header.
```

---

## Enhancement 6: Prompt Rule for Testing Authenticated Endpoints

**Add to prompt.txt:**
```
23. When testing authenticated endpoints (cart, orders, profile):
    - FIRST login to get a JWT token from the response
    - THEN pass it as headers: {"Authorization": "Bearer <token>"} in subsequent test_endpoint calls
    - If test_endpoint returns 401: you forgot the auth token
```

---

## Impact Assessment

| Enhancement | Failures Prevented | Effort | Priority |
|------------|-------------------|--------|----------|
| Auto-attach auth token | 5 (all cart fails) | ~15 lines | **CRITICAL** |
| Duplicate record detection | 3 (register fails) | ~10 lines | HIGH |
| Auth error search query | Indirect (better search) | ~5 lines | MEDIUM |
| Prompt rule for auth testing | Indirect (model guidance) | ~3 lines | HIGH |
| Auto-search on first 500 | Speeds up all debugging | ~5 lines | MEDIUM |
| web_fetch after search | Better fix quality | ~10 lines | MEDIUM |

**If Enhancement 1 (auto-attach token) was implemented, the results would have been:**
- Cart PASS: 5 (instead of 0)
- Register: 2 FAIL (duplicate) + 1 PASS
- Total: 14 PASS, 2 FAIL (expected duplicates)

**That's 14/16 PASS instead of 11/20.**
