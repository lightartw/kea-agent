import { randomUUID } from "node:crypto";

import type {
  ContentBlock,
  ModelConfig,
  StopReason,
  TokenUsage,
} from "../../ai/types.js";
import type { AgentMessage } from "../types.js";
import {
  SessionError,
  type SessionNode,
  type SessionRecord,
} from "./types.js";

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted"]);

/** Generate one ID valid for a Session or SessionNode. */
export function newId(): string {
  return randomUUID().slice(0, 12);
}

/** Validate an untrusted Session ID before resolving a storage path. */
export function parseSessionId(raw: unknown): string {
  if (typeof raw !== "string" || !SESSION_ID_PATTERN.test(raw)) {
    throw new SessionError("invalid_session", "Session ID is invalid");
  }
  return raw;
}

// ── Value predicates ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

// ── Message parsing ──

function invalidRecord(message: string): never {
  throw new SessionError("invalid_record", message);
}

function parseContentBlock(raw: unknown): ContentBlock {
  if (!isRecord(raw) || !isString(raw.type)) {
    invalidRecord("Session message content block is invalid");
  }

  switch (raw.type) {
    case "text":
      if (!isString(raw.text)) {
        invalidRecord("Session message content block is invalid");
      }
      return { type: "text", text: raw.text };
    case "thinking":
      if (!isString(raw.thinking) ||
        (raw.signature !== undefined && !isString(raw.signature))) {
        invalidRecord("Session message content block is invalid");
      }
      return {
        type: "thinking",
        thinking: raw.thinking,
        ...(raw.signature === undefined ? {} : { signature: raw.signature }),
      };
    case "toolCall":
      if (!isString(raw.id) || !isString(raw.name) || !isRecord(raw.arguments)) {
        invalidRecord("Session message content block is invalid");
      }
      return {
        type: "toolCall",
        id: raw.id,
        name: raw.name,
        arguments: structuredClone(raw.arguments),
      };
    default:
      invalidRecord("Session message content block is invalid");
  }
}

function parseUsage(raw: unknown): TokenUsage {
  if (!isRecord(raw) || !isFiniteNumber(raw.inputTokens) ||
    !isFiniteNumber(raw.outputTokens) || !isFiniteNumber(raw.totalTokens)) {
    invalidRecord("Session assistant message usage is invalid");
  }
  return {
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    totalTokens: raw.totalTokens,
  };
}

function parseMessage(raw: unknown): AgentMessage {
  if (!isRecord(raw) || !isString(raw.role)) {
    invalidRecord("Session message is invalid");
  }

  switch (raw.role) {
    case "user":
      if (!isString(raw.content)) {
        invalidRecord("Session user message is invalid");
      }
      return { role: "user", content: raw.content };
    case "tool":
      if (!isString(raw.toolCallId) || !isString(raw.name) || !isString(raw.content) ||
        (raw.isError !== undefined && typeof raw.isError !== "boolean") ||
        (raw.details !== undefined && !isJsonValue(raw.details))) {
        invalidRecord("Session tool message is invalid");
      }
      return {
        role: "tool",
        toolCallId: raw.toolCallId,
        name: raw.name,
        content: raw.content,
        ...(raw.isError === undefined ? {} : { isError: raw.isError }),
        ...(raw.details === undefined
          ? {}
          : { details: structuredClone(raw.details) }),
      };
    case "assistant":
      if (!Array.isArray(raw.content) || !isString(raw.model) ||
        !isString(raw.stopReason) || !STOP_REASONS.has(raw.stopReason) ||
        !isFiniteNumber(raw.latencyMs) ||
        (raw.errorMessage !== undefined && !isString(raw.errorMessage))) {
        invalidRecord("Session assistant message is invalid");
      }
      const usage = raw.usage === undefined ? undefined : parseUsage(raw.usage);
      return {
        role: "assistant",
        content: raw.content.map((block) => parseContentBlock(block)),
        model: raw.model,
        stopReason: raw.stopReason as StopReason,
        latencyMs: raw.latencyMs,
        ...(usage === undefined ? {} : { usage }),
        ...(raw.errorMessage === undefined
          ? {}
          : { errorMessage: raw.errorMessage }),
      };
    default:
      invalidRecord("Session message has an unknown role");
  }
}

function parseModelSelection(raw: unknown): ModelConfig {
  if (!isRecord(raw) || !isString(raw.provider) || !isString(raw.model)) {
    invalidRecord("Session model selection is invalid");
  }
  return { provider: raw.provider, model: raw.model };
}

// ── Record parsing ──

/**
 * Decode and detach one untrusted SessionRecord. Constructs the exact matching
 * union variant and clones nested message data, so caller-owned references and
 * unknown properties never enter Session memory.
 */
export function parseSessionRecord(raw: unknown): SessionRecord {
  if (!isRecord(raw) || !isString(raw.type) || !isTimestamp(raw.createdAt)) {
    invalidRecord("Session record has invalid metadata");
  }

  if (raw.type === "message" || raw.type === "model_selection") {
    if (!isString(raw.id) || !SESSION_ID_PATTERN.test(raw.id) ||
      (raw.parentId !== null && (!isString(raw.parentId) || !SESSION_ID_PATTERN.test(raw.parentId)))) {
      invalidRecord(`Session ${raw.type} record is invalid`);
    }
    if (raw.type === "message") {
      return {
        type: "message",
        id: raw.id,
        parentId: raw.parentId as string | null,
        createdAt: raw.createdAt,
        message: parseMessage(raw.message),
      };
    }
    return {
      type: "model_selection",
      id: raw.id,
      parentId: raw.parentId as string | null,
      createdAt: raw.createdAt,
      selection: parseModelSelection(raw.selection),
    };
  }

  if (raw.type === "session_title") {
    if (!isString(raw.title) || raw.title.trim() === "" || raw.title.includes("\n")) {
      invalidRecord("Session title record is invalid");
    }
    return { type: "session_title", createdAt: raw.createdAt, title: raw.title };
  }

  invalidRecord("Session record has an unknown type");
}

/**
 * Validate IDs, parent-before-child ordering, one root, and no missing parent.
 * Title records do not participate in the tree.
 */
export function validateSessionRecords(records: readonly SessionRecord[]): void {
  const byId = new Set<string>();
  let rootCount = 0;

  for (const record of records) {
    if (!isSessionNode(record)) continue;
    if (byId.has(record.id)) {
      invalidRecord("Session contains duplicate node IDs");
    }
    if (record.parentId === null) {
      rootCount += 1;
    } else if (!byId.has(record.parentId)) {
      invalidRecord("Session node references a missing parent");
    }
    byId.add(record.id);
  }

  if (records.some(isSessionNode) && rootCount !== 1) {
    invalidRecord("Session nodes must form one rooted tree");
  }
}

/** Whether a durable record participates in the parent-linked tree. */
export function isSessionNode(record: SessionRecord): record is SessionNode {
  return record.type !== "session_title";
}
