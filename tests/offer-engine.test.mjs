import test from "node:test";
import assert from "node:assert/strict";
import { rankBookmakerOffers } from "../src/offer-engine.mjs";
import policy from "../config/engine-policy.json" with { type: "json" };

const offers = [{
  bookmaker: "Public Sample Sports",
  region: "GB",
  headline: "Verified public sample offer",
  estimatedBonusValue: 40,
  minDeposit: 10,
  minOddsDecimal: 1.5,
  wageringMultiplier: 0,
  withdrawalFriction: 0.15,
  accountFriction: 0.1,
  termsClarity: 0.82,
  worldCupMarketCoverage: 0.88,
  responsibleGamblingTools: true,
  expiresAt: "2026-07-20T00:00:00.000Z"
}];

test("ranks available offers and excludes expired or mismatched offers", () => {
  const now = new Date("2026-06-05T09:00:00.000Z");
  const ranking = rankBookmakerOffers([
    ...offers,
    {
      ...offers[0],
      bookmaker: "Expired Sample",
      expiresAt: "2026-01-01T00:00:00.000Z"
    },
    {
      ...offers[0],
      bookmaker: "Wrong Region Sample",
      region: "US"
    }
  ], policy, now);

  assert.ok(ranking.length > 0);
  assert.equal(ranking.some((offer) => offer.bookmaker === "Expired Sample"), false);
  assert.equal(ranking.some((offer) => offer.bookmaker === "Wrong Region Sample"), false);
  assert.equal(ranking[0].rank, 1);
});
