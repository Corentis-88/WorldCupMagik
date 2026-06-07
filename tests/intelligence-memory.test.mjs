import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOutcomeLearning,
  buildOddsMovementSummaries,
  buildScanIntelligence,
  buildTeamStatsWithIntelligence,
  deriveTeamForm,
  outcomeLearningAdjustment
} from "../src/intelligence-memory.mjs";

const baseStats = [
  teamStats("Japan", 1710),
  teamStats("Canada", 1660)
];
const matchHistory = [
  match("2026-03-31T19:00:00.000Z", "Japan", "Canada", 2, 1),
  match("2026-03-27T19:00:00.000Z", "Japan", "Uruguay", 1, 1),
  match("2025-11-15T19:00:00.000Z", "Canada", "Mexico", 0, 1),
  match("2025-11-12T19:00:00.000Z", "Canada", "Panama", 3, 1)
];

test("derives recent team form from local match history", () => {
  const form = deriveTeamForm(matchHistory, "Japan", new Date("2026-06-06T10:00:00.000Z"));

  assert.ok(form.matchCount >= 2);
  assert.ok(form.pointsPerGame > 1);
  assert.ok(form.confidence > 0.4);
});

test("20-match intelligence keeps long form and short momentum separate", () => {
  const now = new Date("2026-06-06T10:00:00.000Z");
  const longHistory = Array.from({ length: 20 }, (_item, index) => {
    const day = String(25 - index).padStart(2, "0");
    const latestGoodRun = index < 6;
    return match(`2026-05-${day}T19:00:00.000Z`, "Japan", `Opponent ${index}`, latestGoodRun ? 2 : 0, latestGoodRun ? 0 : 1);
  });
  const form = deriveTeamForm(longHistory, "Japan", now);

  assert.equal(form.matchCount, 20);
  assert.equal(form.longForm.matchCount, 20);
  assert.equal(form.shortForm.matchCount, 6);
  assert.ok(form.shortForm.pointsPerGame > form.longForm.pointsPerGame);
  assert.ok(form.formMomentum > 0);
});

test("builds odds movement summaries from repeated snapshots", () => {
  const snapshots = [
    odds("2026-06-06T08:00:00.000Z", 2.2, "Book A"),
    odds("2026-06-06T08:00:00.000Z", 2.1, "Book B"),
    odds("2026-06-06T14:00:00.000Z", 2.0, "Book A"),
    odds("2026-06-06T14:00:00.000Z", 1.96, "Book B")
  ];
  const summary = buildOddsMovementSummaries(snapshots).get("fixture-1|match_winner|Japan");

  assert.equal(summary.bookmakerCount, 2);
  assert.equal(summary.shortening, true);
  assert.ok(summary.movement < 0);
});

test("scan intelligence feeds learned edge back into team stats", () => {
  const now = new Date("2026-06-06T15:00:00.000Z");
  const fixtures = [{ id: "fixture-1", homeTeam: "Japan", awayTeam: "Canada", date: now.toISOString() }];
  const oddsRecords = [
    odds("2026-06-06T08:00:00.000Z", 2.3, "Book A"),
    odds("2026-06-06T15:00:00.000Z", 2.02, "Book A")
  ];
  const newsArticles = [{
    id: "news-1",
    publishedAt: now.toISOString(),
    source: "Public sample",
    sourceReliability: 0.8,
    teamTags: ["Japan"],
    sentiment: 0.35,
    signals: {
      injury: 0,
      tacticalFit: 0.75,
      lineupClarity: 0.72,
      rotationRisk: 0.1
    }
  }];
  const intelligence = buildScanIntelligence({
    fixtures,
    oddsRecords,
    allOddsSnapshots: oddsRecords,
    newsArticles,
    teamStats: baseStats,
    matchHistory,
    previousTeamIntelligence: [],
    now
  });
  const enriched = buildTeamStatsWithIntelligence({
    baseStats,
    matchHistory,
    teamIntelligence: intelligence.teamIntelligence,
    now
  });
  const japan = enriched.find((team) => team.team === "Japan");

  assert.ok(intelligence.observations.length >= 2);
  assert.ok(japan.intelligenceConfidence > 0.4);
  assert.ok(Number.isFinite(japan.learnedEdge));
});

test("outcome learning waits for sample size then adjusts market/risk patterns", () => {
  const outcomes = Array.from({ length: 10 }, (_, index) => ({
    status: index < 7 ? "won" : "lost",
    market: "both_teams_to_score",
    riskTags: ["market_confirmed_edge"]
  }));
  const learning = buildOutcomeLearning(outcomes);
  const adjustment = outcomeLearningAdjustment({
    market: "both_teams_to_score",
    riskTag: "market_confirmed_edge",
    outcomeLearning: learning
  });

  assert.equal(learning.outcomeCount, 10);
  assert.ok(adjustment.adjustment > 0);
  assert.ok(adjustment.reasons.length > 0);
});

function odds(capturedAt, decimalOdds, bookmaker) {
  return {
    id: `${capturedAt}-${bookmaker}`,
    capturedAt,
    bookmaker,
    fixtureId: "fixture-1",
    market: "match_winner",
    outcome: "Japan",
    decimalOdds
  };
}

function teamStats(team, rating) {
  return {
    team,
    provider: "public-web",
    rating,
    recentPointsPerGame: 1.6,
    xgFor: 1.35,
    xgAgainst: 1.1,
    shotsFor: 11,
    shotsAgainst: 9,
    possession: 53,
    highPressIndex: 54,
    setPieceThreat: 52,
    transitionThreat: 55,
    keeperForm: 53,
    statsCompleteness: 0.72
  };
}

function match(date, homeTeam, awayTeam, homeGoals, awayGoals) {
  return {
    id: `${date}-${homeTeam}-${awayTeam}`,
    date,
    homeTeam,
    awayTeam,
    homeGoals,
    awayGoals,
    homeXg: homeGoals + 0.4,
    awayXg: awayGoals + 0.35,
    homeShots: 10 + homeGoals,
    awayShots: 9 + awayGoals,
    homePossession: 53,
    awayPossession: 47,
    sourceType: "public-web"
  };
}
