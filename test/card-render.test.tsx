import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CardView } from "../src/feed/CardView";
import type { Card } from "../shared/types";

test("renders structured evidence hrefs as clickable anchors", () => {
  const card: Card = {
    id: "linked-evidence",
    feedId: "company-attention",
    kind: "attention",
    status: "to_review_new",
    title: "Linked evidence",
    eyebrow: "Source",
    why: "The source should open from the card.",
    blocks: [{
      id: "sources",
      type: "evidence",
      label: "Sources",
      items: [{ label: "Signed agreement", href: "https://example.com/agreement" }],
    }],
    readyForPass: 1,
    createdAt: "2026-06-10T12:00:00.000Z",
    updatedAt: "2026-06-10T12:00:00.000Z",
    history: [],
  };

  const html = renderToStaticMarkup(
    <CardView
      card={card}
      active={false}
      onActivate={() => {}}
      onChanged={() => {}}
      onAction={() => {}}
      onReturnToReview={() => {}}
    />,
  );

  expect(html).toContain('href="https://example.com/agreement"');
  expect(html).toContain(">Signed agreement</a>");
});
