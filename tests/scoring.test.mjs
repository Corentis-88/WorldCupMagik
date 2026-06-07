import test from "node:test";
import assert from "node:assert/strict";
import { buildRiskPolicy } from "../src/app-service.mjs";
import { buildBetRecommendations } from "../src/portfolio-builder.mjs";
import { buildLegCandidates } from "../src/scoring.mjs";
import basePolicy from "../config/engine-policy.json" with { type: "json" };

const fixtures = [
  fixture("mex-rsa", "Mexico", "South Africa", "2026-06-11T19:00:00.000Z"),
  fixture("bra-hai", "Brazil", "Haiti", "2026-06-13T19:00:00.000Z"),
  fixture("eng-cro", "England", "Croatia", "2026-06-17T20:00:00.000Z"),
  fixture("fra-egy", "France", "Egypt", "2026-06-16T20:00:00.000Z")
];

test("scores positive-edge legs with calculated risk tags", () => {
  const now = new Date("2026-06-07T09:00:00.000Z");
  const policy = buildRiskPolicy(basePolicy, 62);
  const legs = buildLegCandidates({
    fixtures,
    oddsSnapshots: sampleOdds(fixtures, now),
    newsArticles: sampleNews(now),
    teamStats: sampleTeamStats(),
    policy,
    now
  });
  const eligible = legs.filter((leg) => !leg.hardBlocks.length);

  assert.ok(legs.length > 0);
  assert.ok(legs.some((leg) => leg.market === "anytime_scorer"));
  assert.ok(eligible.length > 0);
  assert.ok(eligible.some((leg) => ["calculated_risk", "longshot_value", "contrarian_value"].includes(leg.riskTag)));
});

test("builds fixed-category combinations without same-fixture legs", () => {
  const now = new Date("2026-06-07T09:00:00.000Z");
  const policy = buildRiskPolicy(basePolicy, 72);
  const legs = buildLegCandidates({
    fixtures,
    oddsSnapshots: sampleOdds(fixtures, now),
    newsArticles: sampleNews(now),
    teamStats: sampleTeamStats(),
    policy,
    now
  });
  const recommendations = buildBetRecommendations(legs, policy);

  assert.ok(recommendations.singles.length > 0);
  assert.ok(recommendations.doubles.length > 0);
  assert.ok(recommendations.trixies.length > 0);
  assert.ok(recommendations.accumulatorsByLegCount[3]?.length > 0);

  for (const combo of [...recommendations.doubles, ...recommendations.trixies, ...recommendations.accumulators]) {
    const fixtureIds = new Set(combo.legs.map((leg) => leg.fixtureId));
    assert.equal(fixtureIds.size, combo.legs.length);
    assert.equal(combo.hardBlocks.length, 0);
  }
});

function fixture(id, homeTeam, awayTeam, date) {
  return {
    id,
    date,
    stage: "group",
    homeTeam,
    awayTeam,
    neutralVenue: true,
    sourceType: "public-web"
  };
}

function sampleOdds(items, now) {
  const prices = {
    "Mexico": 1.86,
    "South Africa": 5.8,
    "Brazil": 1.72,
    "Haiti": 9.2,
    "England": 2.18,
    "Croatia": 3.7,
    "France": 1.96,
    "Egypt": 4.4
  };
  const records = [];

  for (const item of items) {
    records.push(
      odds(item, "match_winner", item.homeTeam, prices[item.homeTeam], now),
      odds(item, "match_winner", "Draw", 4.1, now),
      odds(item, "match_winner", item.awayTeam, prices[item.awayTeam], now),
      odds(item, "over_2_5_goals", "Over", 2.05, now),
      odds(item, "under_2_5_goals", "Under", 1.9, now),
      odds(item, "both_teams_to_score", "Yes", 2.12, now),
      odds(item, "both_teams_to_score", "No", 1.82, now),
      odds(item, "anytime_scorer", `${item.homeTeam} striker`, 4.5, now)
    );
  }

  return records;
}

function odds(fixture, market, outcome, decimalOdds, now) {
  return {
    id: `${fixture.id}-${market}-${outcome}`,
    capturedAt: now.toISOString(),
    provider: "public-web",
    bookmaker: "Public Test Book",
    fixtureId: fixture.id,
    fixtureDate: fixture.date,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    market,
    outcome,
    decimalOdds
  };
}

function sampleNews(now) {
  return [
    article("Mexico", "Mexico training sharp with settled attacking shape", 0.16, now),
    article("Brazil", "Brazil forwards fit and pressing well before opener", 0.18, now),
    article("England", "England injury doubts in defence but strong midfield shape", -0.04, now),
    article("France", "France receive attacking boost and clear lineup clues", 0.14, now)
  ];
}

function article(team, title, sentiment, now) {
  return {
    id: `news-${team}`,
    createdAt: now.toISOString(),
    publishedAt: now.toISOString(),
    provider: "self-gather",
    source: "Public test source",
    title,
    teamTags: [team],
    sentiment,
    signals: {
      injury: sentiment < 0 ? 0.2 : 0,
      lineupClarity: 0.72,
      tacticalFit: 0.68,
      morale: 0.6,
      rotationRisk: 0.12
    },
    sourceReliability: 0.78,
    acceptedSource: true
  };
}

function sampleTeamStats() {
  return [
    stats("Mexico", 1740, 2.1, 1.55, 0.9, 58),
    stats("South Africa", 1605, 1.1, 1.0, 1.35, 47),
    stats("Brazil", 1815, 2.2, 1.8, 0.8, 61),
    stats("Haiti", 1540, 0.9, 0.85, 1.6, 43),
    stats("England", 1760, 1.9, 1.5, 1.0, 56),
    stats("Croatia", 1705, 1.4, 1.2, 1.15, 53),
    stats("France", 1800, 2.0, 1.7, 0.9, 59),
    stats("Egypt", 1660, 1.3, 1.1, 1.2, 50)
  ];
}

function stats(team, rating, ppg, xgFor, xgAgainst, possession) {
  return {
    team,
    provider: "public-web",
    rating,
    recentPointsPerGame: ppg,
    xgFor,
    xgAgainst,
    shotsFor: 12,
    shotsAgainst: 9,
    possession,
    highPressIndex: possession,
    setPieceThreat: 55,
    transitionThreat: 57,
    keeperForm: 54,
    statsCompleteness: 0.78,
    intelligenceConfidence: 0.72,
    sourceMatchCount: 3
  };
}
