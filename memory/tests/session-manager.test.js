'use strict';

const { SessionManager } = require('../session-manager');

describe('SessionManager — turn tracking', () => {
  let sm;

  beforeEach(() => {
    sm = new SessionManager({ numCtx: 40960 });
  });

  describe('addMessage', () => {
    test('assigns incrementing turn numbers', () => {
      sm.addMessage({ role: 'user', content: 'hello' });
      sm.addMessage({ role: 'assistant', content: 'hi' });
      const msgs = sm.getMessages();
      expect(msgs[0]._turn).toBe(1);
      expect(msgs[1]._turn).toBe(1);
    });

    test('new user message starts a new turn', () => {
      sm.addMessage({ role: 'user', content: 'hello' });
      sm.addMessage({ role: 'assistant', content: 'hi' });
      sm.addMessage({ role: 'user', content: 'next question' });
      const msgs = sm.getMessages();
      expect(msgs[2]._turn).toBe(2);
    });

    test('tool messages belong to the current turn', () => {
      sm.addMessage({ role: 'user', content: 'read file' });
      sm.addMessage({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file' } }] });
      sm.addMessage({ role: 'tool', content: 'file content here...' });
      const msgs = sm.getMessages();
      expect(msgs[2]._turn).toBe(1);
    });

    test('estimates tokens for each message', () => {
      sm.addMessage({ role: 'user', content: 'hello world' });
      const msgs = sm.getMessages();
      expect(msgs[0]._tokens).toBeGreaterThan(0);
    });
  });

  describe('getTotalTokens', () => {
    test('returns sum of all message tokens', () => {
      sm.addMessage({ role: 'user', content: 'hello world' });
      sm.addMessage({ role: 'assistant', content: 'hi there friend' });
      expect(sm.getTotalTokens()).toBeGreaterThan(0);
    });

    test('returns 0 for empty messages', () => {
      expect(sm.getTotalTokens()).toBe(0);
    });
  });

  describe('getCurrentTurn', () => {
    test('returns 0 with no messages', () => {
      expect(sm.getCurrentTurn()).toBe(0);
    });

    test('returns current turn number', () => {
      sm.addMessage({ role: 'user', content: 'q1' });
      sm.addMessage({ role: 'assistant', content: 'a1' });
      sm.addMessage({ role: 'user', content: 'q2' });
      expect(sm.getCurrentTurn()).toBe(2);
    });
  });
});

describe('SessionManager — observation masking', () => {
  let sm;

  beforeEach(() => {
    sm = new SessionManager({ numCtx: 40960 });
  });

  test('does not mask tool results from current turn', () => {
    sm.addMessage({ role: 'user', content: 'read the file' });
    sm.addMessage({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file' } }] });
    sm.addMessage({ role: 'tool', content: 'A'.repeat(1000), _toolName: 'read_file', _toolArgs: 'big.js' });
    const saved = sm.applyMasking();
    expect(saved).toBe(0);
  });

  test('masks large tool results (>500 tokens) after model responds', () => {
    sm.addMessage({ role: 'user', content: 'read the file' });
    sm.addMessage({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file' } }] });
    sm.addMessage({ role: 'tool', content: 'x\n'.repeat(500), _toolName: 'read_file', _toolArgs: 'big.js' });
    sm.addMessage({ role: 'assistant', content: 'I read the file, here is what I found...' });
    sm.addMessage({ role: 'user', content: 'now do something else' });

    const saved = sm.applyMasking();
    expect(saved).toBeGreaterThan(0);

    const toolMsg = sm.getMessages().find(m => m.role === 'tool');
    expect(toolMsg._masked).toBe(true);
    expect(toolMsg.content).toContain('[read_file]');
    expect(toolMsg.content.length).toBeLessThan(200);
  });

  test('keeps small tool results for 3 turns before masking', () => {
    sm.addMessage({ role: 'user', content: 'check something' });
    sm.addMessage({ role: 'tool', content: 'ok done', _toolName: 'edit_file', _toolArgs: 'a.js' });
    sm.addMessage({ role: 'assistant', content: 'done' });

    sm.addMessage({ role: 'user', content: 'q2' });
    sm.addMessage({ role: 'assistant', content: 'a2' });

    sm.addMessage({ role: 'user', content: 'q3' });
    sm.applyMasking();
    const toolMsg2 = sm.getMessages().find(m => m.role === 'tool');
    expect(toolMsg2._masked).toBe(false);

    sm.addMessage({ role: 'assistant', content: 'a3' });
    sm.addMessage({ role: 'user', content: 'q4' });
    sm.applyMasking();
    const toolMsg3 = sm.getMessages().find(m => m.role === 'tool');
    expect(toolMsg3._masked).toBe(true);
  });

  test('keeps error results full for 5 turns', () => {
    sm.addMessage({ role: 'user', content: 'run build' });
    sm.addMessage({ role: 'tool', content: 'Error: module not found\nSTDERR: compilation failed', _toolName: 'build_and_test' });
    sm.addMessage({ role: 'assistant', content: 'build failed' });

    for (let i = 0; i < 4; i++) {
      sm.addMessage({ role: 'user', content: `q${i + 2}` });
      sm.addMessage({ role: 'assistant', content: `a${i + 2}` });
    }

    sm.applyMasking();
    const toolMsg = sm.getMessages().find(m => m.role === 'tool');
    expect(toolMsg._masked).toBe(false);
  });

  test('maskToolResult generates correct summary for read_file', () => {
    const { maskToolResult } = require('../session-manager');
    const result = maskToolResult({
      content: 'const x = 1;\nconst y = 2;\nconst z = 3;',
      _toolName: 'read_file',
      _toolArgs: 'src/index.js',
    });
    expect(result).toContain('[read_file]');
    expect(result).toContain('src/index.js');
    expect(result).toContain('3 lines');
  });
});

describe('SessionManager — tiered compression', () => {
  test('compress returns null when context is under threshold', () => {
    const sm = new SessionManager({ numCtx: 40960 });
    sm.addMessage({ role: 'user', content: 'hello' });
    const result = sm.compress(500, 200);
    expect(result.action).toBeNull();
    expect(result.tokensSaved).toBe(0);
  });

  test('summarizeOldTurns keeps first + last 8 messages', () => {
    const sm = new SessionManager({ numCtx: 40960 });
    for (let i = 0; i < 15; i++) {
      sm.addMessage({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Message ${i}: ${'x'.repeat(100)}` });
    }

    const saved = sm._summarizeOldTurns();
    const msgs = sm.getMessages();
    expect(msgs.length).toBe(10);
    expect(msgs[1].content).toContain('[SESSION SUMMARY');
  });

  test('fullCompaction keeps first + summary + last 4', () => {
    const sm = new SessionManager({ numCtx: 40960 });
    for (let i = 0; i < 20; i++) {
      sm.addMessage({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Message ${i}: ${'x'.repeat(100)}` });
    }

    const saved = sm._fullCompaction();
    const msgs = sm.getMessages();
    expect(msgs.length).toBe(6);
    expect(msgs[1].content).toContain('[SESSION SUMMARY');
  });

  test('rolling summary merges across compressions', () => {
    const sm = new SessionManager({ numCtx: 40960 });
    for (let i = 0; i < 15; i++) {
      sm.addMessage({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Batch1 msg ${i}: ${'y'.repeat(100)}` });
    }
    sm._summarizeOldTurns();
    const firstSummary = sm._rollingSummary;
    expect(firstSummary).toBeTruthy();

    for (let i = 0; i < 10; i++) {
      sm.addMessage({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Batch2 msg ${i}: ${'z'.repeat(100)}` });
    }
    sm._fullCompaction();

    expect(sm._rollingSummary.length).toBeGreaterThan(firstSummary.length);
  });

  test('getMessagesForOllama strips internal metadata', () => {
    const sm = new SessionManager({ numCtx: 40960 });
    sm.addMessage({ role: 'user', content: 'hello' });
    sm.addMessage({ role: 'assistant', content: 'hi' });

    const clean = sm.getMessagesForOllama();
    for (const msg of clean) {
      expect(msg).not.toHaveProperty('_turn');
      expect(msg).not.toHaveProperty('_tokens');
      expect(msg).not.toHaveProperty('_masked');
      expect(msg).toHaveProperty('role');
      expect(msg).toHaveProperty('content');
    }
  });

  test('_buildSummary extracts tool actions and files', () => {
    const sm = new SessionManager({ numCtx: 40960 });
    const trimmed = [
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: '{"filepath":"src/a.js"}' } }] },
      { role: 'tool', content: '✓ file read' },
      { role: 'assistant', content: 'I found the issue in the authentication logic' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'edit_file', arguments: '{"filepath":"src/a.js"}' } }] },
      { role: 'tool', content: '✓ edit applied' },
    ];
    const summary = sm._buildSummary(trimmed);
    expect(summary).toContain('read_file');
    expect(summary).toContain('edit_file');
    expect(summary).toContain('src/a.js');
    expect(summary).toContain('2 successes');
  });
});

describe('SessionManager — syncFromSession', () => {
  test('picks up new messages appended to session array', () => {
    const sm = new SessionManager({ numCtx: 40960 });
    const sessionMsgs = [
      { role: 'user', content: 'hello' },
    ];
    sm.syncFromSession(sessionMsgs);
    expect(sm.getMessages()).toHaveLength(1);
    expect(sm.getCurrentTurn()).toBe(1);

    sessionMsgs.push({ role: 'assistant', content: 'hi' });
    sessionMsgs.push({ role: 'user', content: 'next' });
    sm.syncFromSession(sessionMsgs);
    expect(sm.getMessages()).toHaveLength(3);
    expect(sm.getCurrentTurn()).toBe(2);
  });

  test('detects /clear (empty array) and resets', () => {
    const sm = new SessionManager({ numCtx: 40960 });
    sm.addMessage({ role: 'user', content: 'hello' });
    sm.addMessage({ role: 'assistant', content: 'hi' });
    expect(sm.getMessages()).toHaveLength(2);

    sm.syncFromSession([]);
    expect(sm.getMessages()).toHaveLength(0);
    expect(sm.getCurrentTurn()).toBe(0);
  });

  test('detects /rewind (messages shrunk) and re-syncs', () => {
    const sm = new SessionManager({ numCtx: 40960 });
    const fullSession = [];
    for (let i = 0; i < 10; i++) {
      const msg = { role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${i}` };
      fullSession.push(msg);
      sm.addMessage(msg);
    }
    expect(sm.getMessages()).toHaveLength(10);

    const rewound = fullSession.slice(0, 4);
    sm.syncFromSession(rewound);
    expect(sm.getMessages()).toHaveLength(4);
  });

  test('detects /load (different first message) and re-syncs', () => {
    const sm = new SessionManager({ numCtx: 40960 });
    sm.addMessage({ role: 'user', content: 'original session' });

    const loaded = [
      { role: 'user', content: 'loaded session' },
      { role: 'assistant', content: 'response from loaded session' },
    ];
    sm.syncFromSession(loaded);
    expect(sm.getMessages()).toHaveLength(2);
    expect(sm.getMessages()[0].content).toBe('loaded session');
  });
});
