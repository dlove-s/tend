---
title: "feat: Cora inbox sweep — one card per email, talk your way through the inbox"
type: feat
status: in-progress
date: 2026-07-12
owner: Danielle (framing) / build in personal Tend fork
---

# Goal: Cora inbox sweep

## The one-sentence goal

Turn the Cora-connected inbox into a Tend feed where **every inbox email becomes one card** that
says what the email is about and proposes a concrete next action, so Danielle can scroll the inbox
and clear it **just by talking to each card** — with the app owning all state on the filesystem,
the app rendering the view, every step tracked, and the whole thing driven from inside a Claude
session's in-app browser preview.

## Why this is mostly assembly, not a rebuild

Tend already is ~80% of this app. This goal reuses, unchanged:

- **App owns state on the filesystem** — cards persist in `~/.attention` (SQLite + readable `data/`
  mirrors). The sweep never holds state; it only calls the app's CLI.
- **App renders the view** — the 4321 preview renders cards, the dock, and history.
- **Talk to each card** — the dock submits per-card instructions to the armed Claude lane.
- **Every step tracked** — `events.jsonl` (`card.created`/`card.updated`/`work.*`), per-card
  `history`, and the work-item lifecycle already record each step.
- **Claude-native** — the feed drains through the Claude lane (front-door work from earlier).

The **only genuinely new piece** is the email source: swap the Gmail recipe for **Cora's CLI**, via
a deterministic sweep that reads the inbox and upserts one card per email.

## Requirements

- **R1.** Each email currently in the inbox produces exactly one card (idempotent — re-sweeping the
  same email updates its card, never duplicates it).
- **R2.** A card shows *what the email is about* (a grounded headline + a short brief + the full
  source email) and *proposes a next action* (a draft reply when a reply makes sense, otherwise the
  most sensible move — archive, delegate, schedule, unsubscribe).
- **R3.** Danielle can act on a card by talking to it (the dock), and by the card's buttons.
- **R4.** Every step is tracked by the app: card creation/update, each instruction, each claim, each
  completion — all in `events.jsonl` + card `history`, not in the sweep script.
- **R5.** The app owns state (filesystem) and rendering; the sweep is a stateless pipeline that only
  calls the Tend CLI (`card:upsert`) and the Cora CLI (read).
- **R6.** No external mutation happens without an explicit approval gate. Reading the inbox is fine;
  **sending a reply is never automatic** — it goes through Tend's `approve_action` + `action:verify`
  path. Archiving and draft-queueing are reversible/non-sending and are the default proposed moves.
- **R7.** Built to run inside a Claude session's in-app browser preview (127.0.0.1:4321), draining
  through the armed Claude lane.

## Prerequisites (Danielle's steps — I can't do these)

1. **Authenticate Cora.** `cora` is installed at `~/.local/bin/cora` but not logged in. Run
   `cora login` (token from https://cora.computer/api_tokens) or set `CORA_API_TOKEN`. Entering an
   API token is a credential step I can't perform on your behalf.
2. **Confirm which inbox Cora is connected to.** Cora covers one Gmail account. The sweep covers
   whatever inbox Cora is authenticated to; multi-account (standardcybernetics.com + mindvehicles.com)
   depends on Cora's own account setup.

## Design

### The pipeline (`scripts/cora-sweep.ts`)

Stateless, deterministic, re-runnable. One pass:

1. **Preflight** — `cora whoami` (skipped in `--fixture` mode). If not authenticated, stop with a
   clear message; never guess.
2. **List** — `cora email glimpse --format json` (or `cora email search "<query>" --format json`
   when `--query` is given) → inbox emails with metadata.
3. **Detail** — `cora email show <id> --format json` per email → sender, recipients, subject, body.
4. **Transform** (the one function under test) — email → Tend `Card` JSON:
   - `id`: `cora-<emailId>` (stable → idempotent upsert; R1).
   - `title`: a concrete grounded headline about what the email needs.
   - `why`: the decision/action it implies.
   - `sourceMailbox`: the received-at address (drives reply-from).
   - `blocks`:
     - `rich_text` "What it's about" — short brief.
     - `email_thread` "Email" — the full source email with `From:`/`To:`/`Subject:` headers
       (required by block validation).
     - `editable_text` "Draft reply" — a proposed reply, only when a reply is the right move.
   - `proposedAction` + `actions`: `Draft reply` (queues `cora email draft <id>`), `Archive`
     (queues `cora email archive <id>`), and — when a send is genuinely appropriate — a
     `Send reply` **`approve_action`** that requires `action:verify` before any send (R6).
5. **Upsert** — write the card JSON to a temp file and call
   `tend cli card:upsert --feed <feed> --card-file <tmp>`. The app persists + renders + emits
   `card.created`/`card.updated` (R4, R5).
6. **Report** — one line per email; a final summary. Card events are the durable step trace.

Flags: `--feed <id>` (default `cora-inbox`), `--query <gmail-query>`, `--limit <n>`,
`--fixture <path>` (inject sample emails, no Cora auth needed — enables validation),
`--dry-run` (print card JSON, skip upsert).

The Cora JSON shape is isolated in one adapter (`parseGlimpse` / `parseEmail`) so that when Cora is
authenticated and the real shape is confirmed, only that adapter changes — the transform, upsert,
card shape, and tests are stable.

### Action → Cora mapping

| Card action | Behavior | Cora effect | Gate |
| --- | --- | --- | --- |
| Draft reply | `queue_instruction` | `cora email draft <id>` (async draft, no send) | none (non-sending) |
| Archive | `queue_instruction` | `cora email archive <id>` (reversible via `email inbox`) | none (reversible) |
| Send reply | `approve_action` | send the approved draft | `action:verify` before send (R6) |
| Unsubscribe | `queue_instruction` | `cora email unsubscribe <id>` | none |

### State & step tracking

- **State**: 100% in the app (`~/.attention`). The script is stateless.
- **Idempotency**: stable `cora-<emailId>` card ids → safe re-sweeps (R1).
- **Steps**: `card.created`/`card.updated` on sweep; `work.queued`/`work.claimed`/`work.completed`
  and per-card `history` when Danielle talks to a card. Visible in the card's timeline and
  `events.jsonl` (R4).

## Validation plan (I step through this myself)

1. **Static**: `pnpm check` green (typecheck + lint + the new transform unit test).
2. **Transform test** (`test/cora-sweep.test.ts`): fixture emails → cards; assert stable ids, valid
   block shapes (email_thread carries full headers), Draft/Archive present, `proposedAction` never
   auto-sends, shell-hostile content survives via file-backed upsert.
3. **Live-in-app, fixture-fed**: `feed:create cora-inbox`, bind the Claude lane, then
   `pnpm cora:sweep --fixture test/fixtures/cora-inbox-sample.json --feed cora-inbox`. Open the
   preview, screenshot, confirm one card per fixture email renders with headline + brief + email +
   proposed action.
4. **Talk-to-card**: queue an instruction on a card from the dock; confirm it enters the work queue
   for the Claude lane and the card `history`/events record the step.
5. **Idempotency**: re-run the sweep; confirm no duplicate cards (same ids updated).
6. **Live email (pending `cora login`)**: after Danielle authenticates Cora, run
   `pnpm cora:sweep --feed cora-inbox` against the real inbox and repeat steps 3–4. Confirm the
   adapter matches Cora's real JSON; adjust only the adapter if needed.

## Out of scope (v1)

- Auto-sending replies (always gated).
- Full `source:record-run`/`sweep:record-batch` provenance (card events cover step tracking for v1).
- Multi-account aggregation beyond what Cora itself is connected to.
- Changes to Tend's work-queue/claim/lane-safety internals (untouched — the sweep only calls
  `card:upsert`).
