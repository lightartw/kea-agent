/** Hard caps shared by every text-returning built-in Tool. */
export const MAX_OUTPUT_LINES = 2_000;
export const MAX_OUTPUT_BYTES = 50 * 1024;

/**
 * Split on CRLF/LF and drop the empty element left by a trailing newline, so
 * "a\n" and "a" both count as one line and byte metrics never flag the
 * normalized trailing break as truncation.
 */
function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/u);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** True when `byte` is a UTF-8 continuation byte (0b10xxxxxx). */
function isContinuationByte(byte: number): boolean {
  return (byte & 0b1100_0000) === 0b1000_0000;
}

/**
 * Trim `buffer` to at most MAX_OUTPUT_BYTES from one end, moving the boundary
 * past continuation bytes so the result always decodes as valid UTF-8.
 */
function trimBytes(buffer: Buffer, fromEnd: boolean): Buffer {
  if (buffer.length <= MAX_OUTPUT_BYTES) return buffer;
  if (fromEnd) {
    let end = MAX_OUTPUT_BYTES;
    while (end > 0 && isContinuationByte(buffer[end - 1]!)) end -= 1;
    return buffer.subarray(0, end);
  }
  let start = buffer.length - MAX_OUTPUT_BYTES;
  while (start < buffer.length && isContinuationByte(buffer[start]!)) start += 1;
  return buffer.subarray(start);
}

/**
 * Bound text by lines first, then by UTF-8 bytes, keeping either the head or
 * the tail. Metrics describe the original text and the final content; the
 * return type is deliberately inferred rather than a named interface.
 */
function truncate(text: string, direction: "head" | "tail"): {
  content: string;
  truncated: boolean;
  totalLines: number;
  shownLines: number;
  totalBytes: number;
  shownBytes: number;
} {
  const lines = splitLines(text);
  const keepHead = direction === "head";
  const selected = keepHead
    ? lines.slice(0, MAX_OUTPUT_LINES)
    : lines.slice(-MAX_OUTPUT_LINES);
  const linesRemoved = lines.length - selected.length;

  const joined = selected.join("\n");
  const buffer = Buffer.from(joined, "utf8");
  const bounded = trimBytes(buffer, keepHead);
  const content = bounded.toString("utf8");

  return {
    content,
    truncated: linesRemoved > 0 || bounded.length < buffer.length,
    totalLines: lines.length,
    shownLines: splitLines(content).length,
    totalBytes: Buffer.byteLength(joined, "utf8"),
    shownBytes: bounded.length,
  };
}

export function truncateHead(text: string): ReturnType<typeof truncate> {
  return truncate(text, "head");
}

export function truncateTail(text: string): ReturnType<typeof truncate> {
  return truncate(text, "tail");
}
