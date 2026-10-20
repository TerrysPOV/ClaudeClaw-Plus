import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  appendFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import type { Proposal, UnsignedProposal } from "./types.js";

export const SECRET_PATH = join(homedir(), ".config", "tuner", ".secret");
export const AUDIT_PATH = join(homedir(), ".config", "tuner", "audit.jsonl");

/** Audit file `auditLog()` appends to. `TUNER_AUDIT_PATH` overrides `AUDIT_PATH`
 *  — read on each call, so the test preload (#474) keeps every `bun test` run
 *  off the operator's live file. */
export function auditPath(): string {
  const override = process.env.TUNER_AUDIT_PATH;
  return override ? resolve(override) : AUDIT_PATH;
}

export function initSecret(): void {
  mkdirSync(dirname(SECRET_PATH), { recursive: true });
  if (existsSync(SECRET_PATH)) return;
  writeFileSync(SECRET_PATH, randomBytes(32));
  chmodSync(SECRET_PATH, 0o600);
}

export function loadSecret(): Buffer {
  if (!existsSync(SECRET_PATH)) initSecret();
  return readFileSync(SECRET_PATH);
}

function proposalCanonical(proposal: UnsignedProposal | Proposal): Buffer {
  const data = {
    alternatives: proposal.alternatives.map((a) => ({
      diff_or_content: a.diff_or_content,
      id: a.id,
      label: a.label,
      tradeoff: a.tradeoff,
    })),
    cluster_id: proposal.cluster_id,
    created_at: proposal.created_at.toISOString(),
    id: proposal.id,
    kind: proposal.kind,
    pattern_signature: proposal.pattern_signature,
    subject: proposal.subject,
    target_path: proposal.target_path,
  };
  return Buffer.from(JSON.stringify(data), "utf8");
}

export function computeProposalSignature(
  proposal: UnsignedProposal | Proposal,
  secret: Buffer,
): string {
  return createHmac("sha256", secret).update(proposalCanonical(proposal)).digest("hex");
}

export function verifyProposalSignature(proposal: Proposal, secret: Buffer): boolean {
  const expected = computeProposalSignature(proposal, secret);
  const got = proposal.signature ?? "";
  if (expected.length !== got.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(got, "hex"));
  } catch {
    return false;
  }
}

// Zero-width chars + prompt injection markers
const INJECTION_RE = /[​-‏‪-‮⁠﻿]/g;
const MARKER_RE = /<(\/?)(system|human|assistant|instruction|prompt|ignore|INST|SYS)[^>]*>/gi;
// Bracket-style markers (used by claude_cli buildPrompt format) — also neutralize
const BRACKET_MARKER_RE =
  /\[(\/?)(system|human|user|assistant|instruction|prompt|ignore|INST|SYS)\]/gi;

export function sanitizeObservationContent(text: string, maxLength = 10_000): string {
  let cleaned = text.replace(INJECTION_RE, "");
  cleaned = cleaned.replace(MARKER_RE, "<$1$2-neutralized>");
  cleaned = cleaned.replace(BRACKET_MARKER_RE, "($1$2-neutralized)");
  return cleaned.slice(0, maxLength);
}

export function auditLog(event: string, payload: Record<string, unknown>): void {
  const path = auditPath();
  mkdirSync(dirname(path), { recursive: true });
  const entry = { ts: new Date().toISOString(), event, ...payload };
  appendFileSync(path, JSON.stringify(entry) + "\n");
}
