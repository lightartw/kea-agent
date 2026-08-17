import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_LINES,
  truncateHead,
  truncateTail,
} from "../../../src/coding-agent/tools/output.js";

test("exact-limit output is not truncated", () => {
  const text = Array.from({ length: MAX_OUTPUT_LINES }, (_, index) => `line-${index + 1}`).join("\n");
  const result = truncateHead(text);
  assert.equal(result.truncated, false);
  assert.equal(result.totalLines, MAX_OUTPUT_LINES);
  assert.equal(result.shownLines, MAX_OUTPUT_LINES);
  assert.equal(result.totalBytes, Buffer.byteLength(text, "utf8"));
  assert.equal(result.shownBytes, result.totalBytes);
  assert.equal(result.content, text);
});

test("head and tail retain opposite ends and report metrics", () => {
  const text = Array.from({ length: 2001 }, (_, index) => `line-${index + 1}`).join("\n");
  const head = truncateHead(text);
  const tail = truncateTail(text);
  assert.equal(head.truncated, true);
  assert.equal(head.totalLines, 2001);
  assert.equal(head.shownLines, 2000);
  assert.match(head.content, /^line-1\n/);
  assert.doesNotMatch(head.content, /line-2001$/);
  assert.match(tail.content, /^line-2\n/);
  assert.match(tail.content, /line-2001$/);
  assert.ok(head.shownBytes <= MAX_OUTPUT_BYTES);
  assert.ok(tail.shownBytes <= MAX_OUTPUT_BYTES);
});

test("byte truncation never emits invalid UTF-8", () => {
  const result = truncateHead("目录".repeat(20_000));
  assert.equal(result.truncated, true);
  assert.ok(result.shownBytes <= MAX_OUTPUT_BYTES);
  assert.equal(Buffer.from(result.content, "utf8").toString("utf8"), result.content);
});

test("byte truncation from the tail keeps the same character count ratio", () => {
  const text = "目录".repeat(20_000);
  const tail = truncateTail(text);
  assert.equal(tail.truncated, true);
  assert.ok(tail.shownBytes <= MAX_OUTPUT_BYTES);
  assert.equal(Buffer.from(tail.content, "utf8").toString("utf8"), tail.content);
  assert.match(tail.content, /目录$/);
  assert.ok(tail.totalBytes > tail.shownBytes);
});

test("empty text has zero lines and no truncation", () => {
  const head = truncateHead("");
  const tail = truncateTail("");
  for (const result of [head, tail]) {
    assert.equal(result.content, "");
    assert.equal(result.truncated, false);
    assert.equal(result.totalLines, 0);
    assert.equal(result.shownLines, 0);
    assert.equal(result.totalBytes, 0);
    assert.equal(result.shownBytes, 0);
  }
});

test("a trailing newline is normalized away without counting as truncation", () => {
  const result = truncateTail("hello\n");
  assert.equal(result.content, "hello");
  assert.equal(result.truncated, false);
  assert.equal(result.totalLines, 1);
  assert.equal(result.shownLines, 1);
  assert.equal(result.totalBytes, 5);
  assert.equal(result.shownBytes, 5);
});
