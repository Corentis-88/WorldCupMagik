import test from "node:test";
import assert from "node:assert/strict";
import { filterOddsIntegrity } from "../src/providers/odds-integrity.mjs";

const base = {
  capturedAt: "2026-06-11T10:00:00.000Z",
  fixtureId: "mex-rsa",
  source: "Comparison publisher",
  pricePublisher: "Comparison publisher",
  bookmaker: "ExampleBook"
};

function record(market, outcome, decimalOdds, extra = {}) {
  return { ...base, market, outcome, decimalOdds, ...extra };
}

test("odds integrity rejects malformed, duplicate, conflicting, non-monotonic, and implausible markets", () => {
  const duplicateAssist = record("anytime_assist", "Player One", 3.2, { playerName: "Player One" });
  const result = filterOddsIntegrity([
    duplicateAssist,
    { ...duplicateAssist },
    record("anytime_scorer", "Player Two", 2.4, { playerName: "Player Two" }),
    record("anytime_scorer", "Player Two", 2.8, { playerName: "Player Two" }),
    record("first_goalscorer", "Bad Price", 2000, { playerName: "Bad Price" }),
    record("over_1_5_goals", "Over", 2.2),
    record("over_2_5_goals", "Over", 1.6),
    record("under_2_5_goals", "Under", 1.9),
    record("under_3_5_goals", "Under", 2.1),
    record("both_teams_to_score", "Yes", 1.1),
    record("both_teams_to_score", "No", 1.1),
    record("match_winner", "Mexico", 1.1),
    record("match_winner", "Draw", 1.1),
    record("match_winner", "South Africa", 1.1)
  ]);

  assert.deepEqual(result.accepted.map((item) => `${item.market}:${item.outcome}`), ["anytime_assist:Player One"]);
  assert.equal(result.reasonCounts.duplicate_selection, 1);
  assert.equal(result.reasonCounts.conflicting_selection_prices, 2);
  assert.equal(result.reasonCounts.malformed_price, 1);
  assert.equal(result.reasonCounts.non_monotonic_total_odds, 4);
  assert.equal(result.reasonCounts.implausible_two_way_implied_sum, 2);
  assert.equal(result.reasonCounts.implausible_three_way_implied_sum, 3);
});

test("odds integrity accepts coherent total-goal curves and ordinary overround", () => {
  const records = [
    record("over_1_5_goals", "Over", 1.3),
    record("over_2_5_goals", "Over", 1.9),
    record("under_2_5_goals", "Under", 2),
    record("under_3_5_goals", "Under", 1.4),
    record("under_4_5_goals", "Under", 1.15),
    record("match_winner", "Mexico", 1.7),
    record("match_winner", "Draw", 3.8),
    record("match_winner", "South Africa", 5.2)
  ];
  const result = filterOddsIntegrity(records);

  assert.equal(result.accepted.length, records.length);
  assert.equal(result.quarantined.length, 0);
  assert.deepEqual(result.reasonCounts, {});
});
