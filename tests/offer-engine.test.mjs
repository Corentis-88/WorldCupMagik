import test from "node:test";
import assert from "node:assert/strict";
import { rankBookmakerOffers } from "../src/offer-engine.mjs";
import policy from "../config/engine-policy.json" with { type: "json" };
import offers from "../data/bookmaker-offers.json" with { type: "json" };

test("ranks available offers and excludes expired or mismatched offers", () => {
  const now = new Date("2026-06-05T09:00:00.000Z");
  const ranking = rankBookmakerOffers([
    ...offers,
    {
      ...offers[0],
      bookmaker: "Expired Demo",
      expiresAt: "2026-01-01T00:00:00.000Z"
    },
    {
      ...offers[0],
      bookmaker: "Wrong Region Demo",
      region: "US"
    }
  ], policy, now);

  assert.ok(ranking.length > 0);
  assert.equal(ranking.some((offer) => offer.bookmaker === "Expired Demo"), false);
  assert.equal(ranking.some((offer) => offer.bookmaker === "Wrong Region Demo"), false);
  assert.equal(ranking[0].rank, 1);
});
