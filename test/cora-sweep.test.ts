import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { AttentionStore } from "../server/store";
import { containsFullEmail } from "../shared/emailThread";
import { buildCard, cardIdForEmail, parseEmailDetail, type CoraEmail } from "../scripts/cora-sweep";

const roots: string[] = [];

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cora-sweep-test-"));
  roots.push(root);
  const store = new AttentionStore(root);
  await store.init();
  return { store, domain: new AttentionDomain(store) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const correspondence: CoraEmail = {
  id: "gmail-thread-19e8570055b2e4ed",
  from: "Priya Anand <priya@northwind.vc>",
  to: "danielle@standardcybernetics.com",
  subject: "Follow-up: pre-seed allocation",
  snippet: "Confirming you're open to a small allocation — can you send the SAFE details?",
  body: "Hi Danielle,\n\nGreat chatting earlier. Can you send over the final SAFE details this week?\n\nBest,\nPriya",
  mailbox: "danielle@standardcybernetics.com",
};

const automated: CoraEmail = {
  id: "gmail-thread-19e0f349c4e9039f",
  from: "Substack <no-reply@substack.com>",
  to: "danielle@standardcybernetics.com",
  subject: "New posts from 4 writers you follow",
  snippet: "This week: essays on agent design and a market teardown.",
  body: "You're receiving this because you follow these publications.",
};

describe("cora-sweep transform", () => {
  test("stable, safe card id per email (idempotency key)", () => {
    expect(cardIdForEmail("gmail-thread-19e8570055b2e4ed")).toBe("cora-gmail-thread-19e8570055b2e4ed");
    // Shell/path-hostile ids are sanitized to the safeIdentifier charset.
    expect(cardIdForEmail("weird/id with spaces")).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(buildCard(correspondence, "cora-inbox").id).toBe(buildCard(correspondence, "cora-inbox").id);
  });

  test("email_thread block carries full From/To/Subject headers", () => {
    const card = buildCard(correspondence, "cora-inbox");
    const emailBlock = card.blocks.find((block) => block.type === "email_thread");
    expect(emailBlock).toBeTruthy();
    expect(containsFullEmail(emailBlock?.text)).toBe(true);
  });

  test("correspondence proposes a draft reply and never auto-sends", () => {
    const card = buildCard(correspondence, "cora-inbox");
    expect(card.proposedAction?.label).toBe("Draft reply");
    expect(card.proposedAction?.externalMutation ?? false).toBe(false);
    for (const action of card.actions ?? []) {
      expect(action.behavior).toBe("queue_instruction");
      expect(action.externalMutation ?? false).toBe(false);
    }
    expect(card.blocks.some((block) => block.type === "editable_text" && block.id === "draft")).toBe(true);
  });

  test("automated sender proposes archive + unsubscribe, no draft", () => {
    const card = buildCard(automated, "cora-inbox");
    expect(card.proposedAction?.label).toBe("Archive");
    expect((card.actions ?? []).map((action) => action.id)).toEqual(["archive", "unsubscribe"]);
    expect(card.blocks.some((block) => block.id === "draft")).toBe(false);
  });

  test("adapter tolerates alternate Cora JSON key names and wrapping", () => {
    const email = parseEmailDetail({
      message: { messageId: "abc123", sender: "x@y.com", recipient: "me@z.com", title: "Hi there", preview: "yo", content: "the body" },
    });
    expect(email?.id).toBe("abc123");
    expect(email?.from).toBe("x@y.com");
    expect(email?.subject).toBe("Hi there");
    expect(parseEmailDetail({ nope: true })).toBeNull();
  });

  test("built cards pass the real card:upsert validation and re-sweep idempotently", async () => {
    const { store, domain } = await setup();
    const feed = await domain.createFeedFromBrief("Cora Inbox\nOne card per inbox email via Cora.", "thread-cora");

    for (const email of [correspondence, automated]) {
      const saved = await domain.upsertCard(feed.id, buildCard(email, feed.id));
      expect(saved.id).toBe(buildCard(email, feed.id).id);
      expect(saved.status).toBe("to_review_new");
    }

    const afterFirst = await store.listCards(feed.id);
    const coraCards = afterFirst.filter((card) => card.id.startsWith("cora-"));
    expect(coraCards).toHaveLength(2);

    // A card the user has already acted on (queued/in-flight)…
    const queuedId = cardIdForEmail(correspondence.id);
    const queued = await store.readCard(feed.id, queuedId);
    await store.writeCard({ ...queued, status: "queued" });

    // …must keep its status across a re-sweep (no clobbering in-flight work), and no duplicate.
    await domain.upsertCard(feed.id, buildCard(correspondence, feed.id));
    const afterResweep = (await store.listCards(feed.id)).filter((card) => card.id.startsWith("cora-"));
    expect(afterResweep).toHaveLength(2);
    expect((await store.readCard(feed.id, queuedId)).status).toBe("queued");
  });
});
