// Cora inbox sweep: read the Cora-connected inbox and upsert one Tend card per email.
//
// The app owns all state (cards persist in ATTENTION_HOME via `card:upsert`); this script is a
// stateless, re-runnable pipeline. Stable `cora-<id>` card ids make re-sweeps idempotent.
//
//   bun scripts/cora-sweep.ts --feed cora-inbox [--query <gmail-query>] [--limit N]
//   bun scripts/cora-sweep.ts --feed cora-inbox --fixture test/fixtures/cora-inbox-sample.json
//   bun scripts/cora-sweep.ts --feed cora-inbox --dry-run
//
// See docs/plans/2026-07-12-cora-inbox-sweep.md.

import { rm } from "node:fs/promises";
import path from "node:path";
import type { Card } from "../shared/types";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const TEND_ENTRY = path.join(REPO_ROOT, "tend.ts");

/** Canonical email shape the transform consumes. The Cora adapter maps raw CLI JSON onto this. */
export interface CoraEmail {
  id: string;
  from: string;
  to?: string;
  subject?: string;
  snippet?: string;
  body?: string;
  receivedAt?: string;
  mailbox?: string;
}

/** What `card:upsert` accepts: a full card is optional except these fields. */
export type CardUpsertInput = Partial<Card> & Pick<Card, "id" | "title" | "why" | "blocks">;

interface SweepOptions {
  feed: string;
  query?: string;
  limit: number;
  fixture?: string;
  dryRun: boolean;
}

const AUTOMATED_SENDER = /no-?reply|do-?not-?reply|newsletter|notifications?@|mailer-daemon|postmaster@|updates?@|digest@/i;

/** Card ids must match ^[A-Za-z0-9][A-Za-z0-9._-]*$ (safeIdentifier). */
export function cardIdForEmail(emailId: string): string {
  const cleaned = emailId.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+/, "");
  return `cora-${cleaned || "unknown"}`;
}

function senderLooksAutomated(from: string): boolean {
  return AUTOMATED_SENDER.test(from);
}

function displayName(from: string): string {
  const named = /^\s*"?([^"<]+?)"?\s*</.exec(from);
  return (named?.[1] ?? from).trim() || from;
}

function clip(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}

/** Build the full source email with From/To/Subject headers (required by the email_thread block). */
export function emailThreadText(email: CoraEmail): string {
  const to = email.to?.trim() || email.mailbox?.trim() || "me";
  const headers = [
    `From: ${email.from.trim() || "unknown"}`,
    `To: ${to}`,
    `Subject: ${email.subject?.trim() || "(no subject)"}`,
  ];
  if (email.receivedAt?.trim()) headers.push(`Date: ${email.receivedAt.trim()}`);
  const body = email.body?.trim() || email.snippet?.trim() || "(no body captured)";
  return `${headers.join("\n")}\n\n${body}`;
}

/** The one function under test: email -> Tend card. Deterministic; the Claude lane enriches later. */
export function buildCard(email: CoraEmail, feedName: string): CardUpsertInput {
  const subject = email.subject?.trim() || "(no subject)";
  const sender = displayName(email.from);
  const automated = senderLooksAutomated(email.from);
  const brief = clip(email.snippet || email.body || subject, 320) || subject;

  const blocks: Card["blocks"] = [
    { id: "brief", type: "rich_text", label: "What it's about", text: `From ${sender}. ${brief}` },
    { id: "email", type: "email_thread", label: "Email", text: emailThreadText(email) },
  ];

  const actions: Card["actions"] = [];
  let proposedAction: Card["proposedAction"];

  if (automated) {
    // Low-attention senders: default to archive, offer unsubscribe. No reply drafted.
    proposedAction = {
      label: "Archive",
      instruction: `Archive this email in Cora: cora email archive ${email.id}.`,
    };
    actions.push(
      { id: "archive", label: "Archive", behavior: "queue_instruction", instruction: `Archive this email in Cora: cora email archive ${email.id}.`, variant: "primary", shortcut: "x" },
      { id: "unsubscribe", label: "Unsubscribe", behavior: "queue_instruction", instruction: `Create an unsubscribe rule for this sender in Cora: cora email unsubscribe ${email.id}.`, shortcut: "u" },
    );
  } else {
    // Correspondence: propose a draft reply (never an auto-send), keep archive available.
    blocks.push({ id: "draft", type: "editable_text", label: "Draft reply", value: "", editable: true });
    proposedAction = {
      label: "Draft reply",
      instruction: `Draft a reply to this email using Cora (cora email draft ${email.id}), preserving ${sender}'s counterpart's voice. Do not send; leave the draft for review.`,
      artifactBlockId: "draft",
    };
    actions.push(
      { id: "draft-reply", label: "Draft reply", behavior: "queue_instruction", instruction: `Draft a reply to this email using Cora (cora email draft ${email.id}). Do not send; leave the draft for review.`, artifactBlockId: "draft", variant: "primary", shortcut: "d" },
      { id: "archive", label: "Archive", behavior: "queue_instruction", instruction: `Archive this email in Cora: cora email archive ${email.id}.`, shortcut: "x" },
    );
  }

  return {
    id: cardIdForEmail(email.id),
    kind: "attention",
    // Status is intentionally omitted: card:upsert defaults new cards to "to_review_new" but
    // preserves an existing card's status, so a re-sweep never yanks queued/in-flight work back.
    eyebrow: `${feedName} · Cora`,
    title: subject,
    why: automated
      ? `Low-attention mail from ${sender}. Likely a quick archive.`
      : `From ${sender} — decide whether this needs a reply or another next step.`,
    sourceMailbox: email.mailbox?.trim() || undefined,
    blocks,
    proposedAction,
    actions,
  };
}

// ---- Cora adapter (isolated: only this maps raw Cora JSON onto CoraEmail) --------------------

function pick(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

export function parseEmailDetail(raw: unknown): CoraEmail | null {
  const record = unwrap(raw);
  if (!record) return null;
  const id = pick(record, "id", "messageId", "threadId", "gmailId");
  if (!id) return null;
  return {
    id,
    from: pick(record, "from", "sender", "fromAddress") ?? "unknown",
    to: pick(record, "to", "recipient", "toAddress"),
    subject: pick(record, "subject", "title"),
    snippet: pick(record, "snippet", "preview", "summary"),
    body: pick(record, "body", "text", "bodyText", "content", "plain"),
    receivedAt: pick(record, "receivedAt", "date", "internalDate", "timestamp"),
    mailbox: pick(record, "mailbox", "account", "deliveredTo"),
  };
}

/** Cora may wrap payloads under data/email/result; unwrap to the record we care about. */
function unwrap(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  for (const key of ["email", "message", "data", "result"]) {
    const nested = record[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested as Record<string, unknown>;
  }
  return record;
}

function parseGlimpseList(raw: unknown): string[] {
  const container = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(raw)
    ? raw
    : (container.emails ?? container.messages ?? container.data ?? container.results ?? []) as unknown[];
  const ids: string[] = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item === "string") ids.push(item);
    else if (item && typeof item === "object") {
      const id = pick(item as Record<string, unknown>, "id", "messageId", "threadId", "gmailId");
      if (id) ids.push(id);
    }
  }
  return ids;
}

// ---- Process runners -------------------------------------------------------------------------

async function run(cmd: string[], env?: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
  const subprocess = Bun.spawn(cmd, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  return { stdout, stderr, code };
}

async function coraJson(args: string[]): Promise<unknown> {
  const { stdout, stderr, code } = await run(["cora", ...args], { PATH: `${process.env.HOME}/.local/bin:${process.env.PATH ?? ""}` });
  if (code !== 0) throw new Error(`cora ${args.join(" ")} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`);
  return JSON.parse(stdout);
}

async function upsertCard(feed: string, card: CardUpsertInput): Promise<void> {
  const tmp = path.join(REPO_ROOT, ".cora-sweep-card.json");
  await Bun.write(tmp, JSON.stringify(card));
  try {
    const { stderr, code } = await run([process.execPath, TEND_ENTRY, "cli", "card:upsert", "--feed", feed, "--card-file", tmp]);
    if (code !== 0) throw new Error(`card:upsert failed for ${card.id} (exit ${code}): ${stderr.trim()}`);
  } finally {
    await rm(tmp, { force: true });
  }
}

// ---- Orchestration ---------------------------------------------------------------------------

async function loadEmails(options: SweepOptions): Promise<CoraEmail[]> {
  if (options.fixture) {
    const raw = await Bun.file(path.resolve(REPO_ROOT, options.fixture)).json();
    const list = Array.isArray(raw) ? raw : [];
    return list.map((item) => parseEmailDetail(item)).filter((email): email is CoraEmail => email !== null).slice(0, options.limit);
  }

  // Live path: preflight auth, list the inbox, then fetch each email's detail.
  const who = await run(["cora", "whoami"], { PATH: `${process.env.HOME}/.local/bin:${process.env.PATH ?? ""}` });
  if (who.code !== 0 || /not logged in|not authenticated/i.test(who.stdout + who.stderr)) {
    throw new Error("Cora is not authenticated. Run `cora login` (token from https://cora.computer/api_tokens) and retry.");
  }
  const listArgs = options.query
    ? ["email", "search", options.query, "--format", "json"]
    : ["email", "glimpse", "--format", "json"];
  const ids = parseGlimpseList(await coraJson(listArgs)).slice(0, options.limit);
  const emails: CoraEmail[] = [];
  for (const id of ids) {
    const email = parseEmailDetail(await coraJson(["email", "show", id, "--format", "json"]));
    if (email) emails.push(email);
  }
  return emails;
}

function parseArgs(argv: string[]): SweepOptions {
  const options: SweepOptions = { feed: "cora-inbox", limit: 50, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--feed") options.feed = argv[++i] ?? options.feed;
    else if (arg === "--query") options.query = argv[++i];
    else if (arg === "--limit") options.limit = Math.max(1, Number(argv[++i]) || options.limit);
    else if (arg === "--fixture") options.fixture = argv[++i];
    else if (arg === "--dry-run") options.dryRun = true;
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));
  const emails = await loadEmails(options);
  console.log(`Cora sweep → feed "${options.feed}": ${emails.length} email(s)${options.fixture ? " (fixture)" : ""}${options.dryRun ? " [dry-run]" : ""}`);

  let created = 0;
  for (const email of emails) {
    const card = buildCard(email, options.feed);
    if (options.dryRun) {
      console.log(`  · ${card.id} — ${card.title} → ${card.proposedAction?.label}`);
      console.log(JSON.stringify(card, null, 2));
    } else {
      await upsertCard(options.feed, card);
      created += 1;
      console.log(`  ✓ ${card.id} — ${card.title} → ${card.proposedAction?.label}`);
    }
  }
  if (!options.dryRun) console.log(`Done: ${created} card(s) upserted. State + step history live in the app.`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
