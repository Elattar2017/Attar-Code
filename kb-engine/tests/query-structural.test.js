'use strict';

const { analyzeQuery } = require('../retrieval/query-analyzer');

describe('query-analyzer — structural queries', () => {
  test('detects "how many chapters" as structural', () => {
    const result = analyzeQuery('how many chapters does this book have');
    expect(result.type).toBe('structural');
  });

  test('detects "what is in chapter 2" as structural', () => {
    const result = analyzeQuery('what is covered in chapter 2');
    expect(result.type).toBe('structural');
  });

  test('detects "table of contents" as structural', () => {
    const result = analyzeQuery('show me the table of contents');
    expect(result.type).toBe('structural');
  });

  test('detects "what topics" as structural', () => {
    const result = analyzeQuery('what topics does this document cover');
    expect(result.type).toBe('structural');
  });

  test('detects "list all sections" as structural', () => {
    const result = analyzeQuery('list all sections in the python book');
    expect(result.type).toBe('structural');
  });

  test('detects "chapter 5 subject" as structural', () => {
    const result = analyzeQuery('what is the subject of chapter 5');
    expect(result.type).toBe('structural');
  });

  test('structural queries prefer dense', () => {
    const result = analyzeQuery('how many chapters are there');
    expect(result.preferVector).toBe('dense');
  });

  test('non-structural query remains unchanged', () => {
    const result = analyzeQuery('how to use async/await in python');
    expect(result.type).not.toBe('structural');
  });

  test('error query still detected as error (higher priority)', () => {
    const result = analyzeQuery('TypeError in chapter 3');
    expect(result.type).toBe('error');
  });
});
