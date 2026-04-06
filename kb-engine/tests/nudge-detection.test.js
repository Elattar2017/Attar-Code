"use strict";

/**
 * Tests for the "thinking without acting" nudge detection logic.
 * Extracted from attar-code.js lines ~8592-8610 for testability.
 */

// Replicate the detection logic as a pure function
function shouldNudge({ userMsg, responseText, recentToolNames = [], retryCount = 0 }) {
  // Completion signals (expanded)
  const completionSignals = /\b(task completed|successfully created|project is ready|all files are ready|ready for your next|what would you like|would you like|what else|is there anything else|i'm ready for|ready for any future|what can i help|how can i help|do you approve|approve this plan|waiting for approval|ready for approval|plan saved|do you want me to|shall i|any questions|hope this helps|let me know if|feel free to ask)\b/i;
  const isCompletion = completionSignals.test(responseText);

  // Planning words
  const planningWords = /\b(let me|i need to|i'll|i will|now i|next i|let's|going to|should|set up)\b/i;
  const pastTenseCompletion = /\b(created|completed|installed|finished|done|ready|set up successfully|built successfully)\b/i;

  // Signal 1: User asked a question
  const isQuestion = /[?]\s*$/.test(userMsg.trim()) ||
    /^(how|what|why|when|where|who|explain|describe|search|find|show|tell|list|i need.*(?:explain|search|know|understand))/i.test(userMsg);

  // Signal 2: Substantive content
  const hasSubstantiveContent = responseText.length > 500 ||
    /```[\s\S]*?```/.test(responseText) ||
    responseText.split('\n').length > 15;

  // Signal 3: Recent search
  const searchTools = new Set(['kb_search', 'web_search', 'web_fetch', 'search_all', 'kb_read_section']);
  const justDidSearch = recentToolNames.some(t => searchTools.has(t));

  const isStillPlanning = planningWords.test(responseText)
    && !pastTenseCompletion.test(responseText)
    && !isCompletion
    && !isQuestion
    && !hasSubstantiveContent
    && !justDidSearch
    && retryCount < 4;

  return isStillPlanning;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Nudge detection — should NOT nudge", () => {
  test("T1: Q&A after web search → NO nudge", () => {
    expect(shouldNudge({
      userMsg: "how to create go class",
      responseText: "I'll explain Go structs and methods. In Go, there are no traditional classes. Instead..." + "x".repeat(500),
      recentToolNames: ["web_search", "web_fetch"],
    })).toBe(false);
  });

  test("T3: KB search answer → NO nudge", () => {
    expect(shouldNudge({
      userMsg: "explain decorators from kb",
      responseText: "Based on the KB results, I'll explain decorators in Python..." + "x".repeat(800),
      recentToolNames: ["kb_search"],
    })).toBe(false);
  });

  test("T5: Complete answer with 'would you like' → NO nudge", () => {
    expect(shouldNudge({
      userMsg: "what is polymorphism",
      responseText: "Polymorphism is a concept... Would you like me to show an example?",
    })).toBe(false);
  });

  test("T6: Long answer with code blocks → NO nudge", () => {
    expect(shouldNudge({
      userMsg: "build a calculator",
      responseText: "I'll build this step by step\n```js\nfunction add(a,b){ return a+b; }\nfunction sub(a,b){ return a-b; }\n```\nMore explanation here.",
    })).toBe(false);
  });

  test("T8: Past tense completion → NO nudge", () => {
    expect(shouldNudge({
      userMsg: "create the file",
      responseText: "I've created the server.js file successfully and it's ready to use.",
    })).toBe(false);
  });

  test("T9: Error search then explanation → NO nudge", () => {
    expect(shouldNudge({
      userMsg: "fix TypeError",
      responseText: "I'll explain the fix. The TypeError occurs because..." + "x".repeat(400),
      recentToolNames: ["web_search"],
    })).toBe(false);
  });

  test("question mark at end → NO nudge", () => {
    expect(shouldNudge({
      userMsg: "i need you to search how we i can create go class?",
      responseText: "I'll show you how to create classes in Go using structs.",
    })).toBe(false);
  });

  test("'hope this helps' → NO nudge (completion signal)", () => {
    expect(shouldNudge({
      userMsg: "tell me about Go",
      responseText: "Go is a statically typed language... Hope this helps!",
    })).toBe(false);
  });

  test("'let me know if' → NO nudge (completion signal)", () => {
    expect(shouldNudge({
      userMsg: "explain REST",
      responseText: "REST stands for... Let me know if you need more details.",
    })).toBe(false);
  });
});

describe("Nudge detection — SHOULD nudge", () => {
  test("T2: Task stalled — model plans but doesn't act → nudge", () => {
    expect(shouldNudge({
      userMsg: "create a REST API for me",
      responseText: "I'll create the server file next and set up routes",
    })).toBe(true);
  });

  test("T4: Short planning text after file edits → nudge", () => {
    expect(shouldNudge({
      userMsg: "fix all the bugs",
      responseText: "Now I need to update the config file",
    })).toBe(true);
  });

  test("T7: Model stuck — keeps saying 'let me' → nudge", () => {
    expect(shouldNudge({
      userMsg: "set up the project",
      responseText: "Let me think about this. I should first set up the environment.",
      retryCount: 2,
    })).toBe(true);
  });

  test("T10: Very short response → nudge", () => {
    expect(shouldNudge({
      userMsg: "create a dashboard",
      responseText: "Let me",
    })).toBe(true);
  });

  test("'going to' without content → nudge", () => {
    expect(shouldNudge({
      userMsg: "build the frontend",
      responseText: "I'm going to create the components now.",
    })).toBe(true);
  });
});
