const assert = require("node:assert/strict");
require("./selection-core.js");
const core = globalThis.WorldCupMagikSelectionCore;

const now = new Date("2026-06-20T18:30:00Z");
const fixture = {
  id: "fixture_test",
  date: "2026-06-20T19:00:00Z",
  dateKey: "2026-06-20",
  homeTeam: "Alpha",
  awayTeam: "Beta"
};
const base = {
  fixtureId: fixture.id,
  fixtureDate: fixture.date,
  homeTeam: fixture.homeTeam,
  awayTeam: fixture.awayTeam,
  decimalOdds: 2,
  modelProbability: 0.6,
  confidence: 0.8,
  score: 70,
  components: { nonMarketSignalCount: 5 }
};
const lineups = {
  lineups: [{
    fixtureId: fixture.id,
    fixtureDate: fixture.date,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    teams: {
      Alpha: { status: "confirmed", starters: ["A One", "A Two", "A Three", "A Four", "A Five", "A Six", "A Seven", "A Eight", "A Nine", "A Ten", "Starter Player"] },
      Beta: { status: "confirmed", starters: ["B One", "B Two", "B Three", "B Four", "B Five", "B Six", "B Seven", "B Eight", "B Nine", "B Ten", "B Eleven"] }
    }
  }]
};
const candidates = [
  { ...base, id: "starter", market: "anytime_scorer", playerName: "Starter Player", playerTeam: "Alpha", outcome: "Starter Player", selectionLabel: "Alpha vs Beta: Starter Player anytime scorer" },
  { ...base, id: "bench", market: "player_shot_on_target", playerName: "Bench Player", playerTeam: "Alpha", outcome: "Bench Player", selectionLabel: "Alpha vs Beta: Bench Player shot on target" },
  { ...base, id: "result", market: "match_winner", outcome: "Alpha", selectionLabel: "Alpha vs Beta: Alpha to win", decimalOdds: 1.5, modelProbability: 0.74 }
];

const confirmed = core.prepareCandidates({ candidates, fixtures: [fixture], lineups, now });
assert.deepEqual(confirmed.eligible.map((leg) => leg.id), ["starter", "result"]);
assert.deepEqual(confirmed.excluded.map((leg) => leg.id), ["bench"]);

const missing = core.prepareCandidates({ candidates, fixtures: [fixture], lineups: null, now });
assert.deepEqual(missing.eligible.map((leg) => leg.id), ["result"]);
assert.deepEqual(missing.provisional.map((leg) => leg.id), ["starter", "bench"]);

const riskCandidates = [
  ...confirmed.eligible,
  { ...base, id: "outsider", fixtureId: "fixture_two", homeTeam: "Gamma", awayTeam: "Delta", market: "match_winner", outcome: "Gamma", selectionLabel: "Gamma vs Delta: Gamma to win", decimalOdds: 7, modelProbability: 0.31, impliedProbability: 0.142, independentEdge: 0.168, confidence: 0.72, score: 72 }
];
const lowRisk = core.buildBetslip({ candidates: riskCandidates, risk: 10, slipTypes: [["single", "Single"]] });
const highRisk = core.buildBetslip({ candidates: riskCandidates, risk: 100, slipTypes: [["single", "Single"]] });
assert.equal(lowRisk[0].legs[0].id, "result");
assert.equal(highRisk[0].legs[0].id, "outsider");
assert.deepEqual(
  core.buildBetslip({ candidates: riskCandidates, risk: 65 }),
  core.buildBetslip({ candidates: riskCandidates, risk: 65 })
);
assert.ok(core.buildBetslip({ candidates: [...riskCandidates, riskCandidates[0]], risk: 65 }).every((bet) => new Set(bet.legs.map((leg) => leg.id)).size === bet.legs.length));
assert.equal(lowRisk[0].directlyPlaceable, false);
assert.equal(lowRisk[0].returnStatus, "research_only");

const sameFixtureIncompatible = [
  { ...base, id: "same-result", market: "match_winner", outcome: "Alpha", selectionLabel: "Alpha to win" },
  { ...base, id: "same-goals", market: "over_2_5_goals", outcome: "Over", selectionLabel: "Over 2.5 goals" }
];
assert.equal(core.buildBetslip({ candidates: sameFixtureIncompatible, risk: 100, slipTypes: [["double", "Double"]] }).length, 0);

const sameFixtureVerified = sameFixtureIncompatible.map((leg) => ({
  ...leg,
  bookmaker: "Verified Book",
  bookmakerKey: "verified-book",
  bookmakerVerified: true,
  betBuilderCompatible: true,
  betBuilderGroup: "alpha-beta-main"
}));
const distinctVerified = ["two", "three", "four", "five"].map((suffix, index) => ({
  ...sameFixtureVerified[0],
  id: `verified-${suffix}`,
  fixtureId: `fixture-${suffix}`,
  homeTeam: `Home ${suffix}`,
  awayTeam: `Away ${suffix}`,
  selectionLabel: `Home ${suffix} to win`,
  decimalOdds: 1.5 + index * 0.1
}));
const verifiedSix = core.buildBetslip({ candidates: [...sameFixtureVerified, ...distinctVerified], risk: 100, slipTypes: [["accumulator_6", "6-leg accumulator"]] })[0];
assert.equal(verifiedSix.legs.length, 6);
assert.equal(verifiedSix.directlyPlaceable, true);
assert.equal(verifiedSix.placeabilityStatus, "verified_single_bookmaker");
assert.equal(new Set(verifiedSix.legs.map((leg) => leg.fixtureId)).size, 5);

console.log("selection-core invariants passed");
