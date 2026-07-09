import assert from "node:assert/strict";
import test from "node:test";

import { bettingPerformanceAdjustment, buildBettingPerformance } from "../src/betting-performance.mjs";

test("betting performance tracks ROI and closing line value by market", () => {
  const outcomes = [
    ...Array.from({ length: 10 }, (_item, index) => outcome({
      id: `loss-${index}`,
      status: index < 2 ? "won" : "lost",
      decimalOdds: 2.1,
      market: "both_teams_to_score",
      fixtureId: `fixture-${index}`
    }))
  ];
  const oddsSnapshots = outcomes.map((item) => odds({
    fixtureId: item.fixtureId,
    market: item.market,
    outcome: item.outcome,
    decimalOdds: 2.35,
    capturedAt: "2026-06-20T18:50:00.000Z"
  }));
  const performance = buildBettingPerformance({ outcomes, oddsSnapshots, now: new Date("2026-06-21T12:00:00.000Z") });
  const market = performance.market.both_teams_to_score;

  assert.equal(market.count, 10);
  assert.equal(market.stakedCount, 10);
  assert.ok(market.cashRoi < -0.5);
  assert.ok(market.averageClv < 0);
  assert.equal(market.action, "downgrade");
});

test("betting performance can suppress a poor cash market and flag price-gone legs", () => {
  const outcomes = Array.from({ length: 14 }, (_item, index) => outcome({
    id: `poor-${index}`,
    status: index < 2 ? "won" : "lost",
    decimalOdds: 1.95,
    market: "over_2_5_goals",
    fixtureId: `fixture-poor-${index}`
  }));
  const oddsSnapshots = outcomes.map((item) => odds({
    fixtureId: item.fixtureId,
    market: item.market,
    outcome: item.outcome,
    decimalOdds: 2.18,
    capturedAt: "2026-06-20T18:50:00.000Z"
  }));
  const performance = buildBettingPerformance({ outcomes, oddsSnapshots, now: new Date("2026-06-21T12:00:00.000Z") });
  const adjustment = bettingPerformanceAdjustment({
    market: "over_2_5_goals",
    riskTag: "steady_edge",
    decimalOdds: 1.72,
    movement: {
      previousAverageDecimalOdds: 2.04,
      averageDecimalOdds: 1.72,
      bookmakerCount: 3
    },
    bettingPerformance: performance,
    risk: 0
  });

  assert.equal(performance.market.over_2_5_goals.action, "suppress_for_cash");
  assert.equal(adjustment.priceGone, true);
  assert.equal(adjustment.hardBlock, true);
  assert.ok(adjustment.scorePenalty > 10);
  assert.ok(adjustment.reasons.some((reason) => reason.includes("price shortened")));
});

function outcome(overrides = {}) {
  return {
    id: overrides.id || "outcome",
    fixtureId: overrides.fixtureId || "fixture-a",
    fixtureDate: "2026-06-20T19:00:00.000Z",
    market: overrides.market || "match_winner",
    outcome: overrides.outcome || "Alpha",
    selectionLabel: "Alpha to win",
    bookmaker: overrides.bookmaker || "Public Test Book",
    decimalOdds: overrides.decimalOdds ?? 2,
    status: overrides.status || "lost",
    modelProbability: overrides.modelProbability ?? 0.58,
    impliedProbability: overrides.impliedProbability ?? 0.5,
    marketImpliedProbability: overrides.marketImpliedProbability ?? 0.5,
    riskTag: overrides.riskTag || "steady_edge",
    settledAt: "2026-06-20T22:00:00.000Z"
  };
}

function odds(overrides = {}) {
  return {
    fixtureId: overrides.fixtureId || "fixture-a",
    fixtureDate: "2026-06-20T19:00:00.000Z",
    homeTeam: "Alpha",
    awayTeam: "Beta",
    market: overrides.market || "match_winner",
    outcome: overrides.outcome || "Alpha",
    bookmaker: overrides.bookmaker || "Public Test Book",
    decimalOdds: overrides.decimalOdds ?? 2,
    capturedAt: overrides.capturedAt || "2026-06-20T18:50:00.000Z"
  };
}
