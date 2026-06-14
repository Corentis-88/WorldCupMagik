import test from "node:test";
import assert from "node:assert/strict";
import { buildMostLikelyPolicy, buildRiskPolicy, selectBetslip } from "../src/app-service.mjs";
import { buildBetRecommendations } from "../src/portfolio-builder.mjs";
import { bestLatestOddsByOutcome, buildLegCandidates, buildTournamentContextByFixture, fixtureModel } from "../src/scoring.mjs";
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

test("risk-zero single selection can choose a steady leg outside the general top twelve", () => {
  const policy = {
    riskProfile: {
      minLegEdge: 0.03,
      minLegConfidence: 0.72,
      maxFavoriteImpliedProbability: 0.82,
      maxCombinedOdds: 38,
      minRiskLegsForTrixie: 0,
      preferredCombinedOdds: {
        double: { min: 2, max: 4.6 },
        trixie: { min: 3.2, max: 10 },
        accumulatorByLegCount: {
          3: { min: 4.2, max: 14 },
          4: { min: 6.5, max: 26 },
          5: { min: 9, max: 42 },
          6: { min: 12, max: 68 },
          8: { min: 22, max: 140 }
        }
      }
    }
  };
  const highScoreLegs = Array.from({ length: 12 }, (_, index) => mockSingleLeg({
    id: `risk-${index}`,
    homeTeam: `Risk ${index}`,
    awayTeam: `Away ${index}`,
    decimalOdds: 2.7,
    modelProbability: 0.58,
    edge: 0.22,
    independentEdge: 0.23,
    confidence: 0.81,
    riskTag: "calculated_risk",
    score: 100
  }));
  const steadyLeg = mockSingleLeg({
    id: "steady-low-risk",
    homeTeam: "Belgium",
    awayTeam: "Egypt",
    market: "over_2_5_goals",
    outcome: "Over",
    decimalOdds: 1.77,
    modelProbability: 0.5933,
    edge: 0.03,
    independentEdge: 0.0323,
    confidence: 0.7941,
    riskTag: "steady_edge",
    score: 89.38
  });
  const recommendations = buildBetRecommendations([...highScoreLegs, steadyLeg], policy);
  const selected = selectBetslip({ recommendations, stake: 10, risk: 0 });
  const single = selected.find((item) => item.category === "single");

  assert.equal(recommendations.singles.length, 13);
  assert.equal(single?.legs[0].id, "steady-low-risk");
});

test("low-risk trixies respect an explicit zero calculated-risk-leg requirement", () => {
  const policy = {
    riskProfile: {
      minLegEdge: 0.03,
      minLegConfidence: 0.72,
      maxFavoriteImpliedProbability: 0.82,
      maxCombinedOdds: 38,
      minRiskLegsForTrixie: 0,
      preferredCombinedOdds: {
        trixie: { min: 3.2, max: 10 },
        accumulatorByLegCount: {
          3: { min: 4.2, max: 14 },
          4: { min: 6.5, max: 26 },
          5: { min: 9, max: 42 },
          6: { min: 12, max: 68 },
          8: { min: 22, max: 140 }
        }
      }
    }
  };
  const steadyLegs = ["France", "Belgium", "USA"].map((team, index) => mockSingleLeg({
    id: `steady-${index}`,
    homeTeam: team,
    awayTeam: `Opponent ${index}`,
    market: "over_2_5_goals",
    outcome: "Over",
    decimalOdds: 1.8,
    modelProbability: 0.61,
    edge: 0.05,
    independentEdge: 0.055,
    confidence: 0.79,
    riskTag: "steady_edge",
    score: 92
  }));
  const recommendations = buildBetRecommendations(steadyLegs, policy);

  assert.ok(recommendations.trixies.some((combo) => combo.riskLegCount === 0));
});

test("BTTS model requires balanced scoring threat, not just high total goals", () => {
  const now = new Date("2026-06-07T09:00:00.000Z");
  const oneSidedFixture = fixture("ger-cur", "Germany", "Curacao", "2026-06-14T19:00:00.000Z");
  const policy = buildRiskPolicy(basePolicy, 55);
  const oddsRecords = [
    odds(oneSidedFixture, "both_teams_to_score", "Yes", 2.05, now),
    odds(oneSidedFixture, "both_teams_to_score", "No", 1.8, now),
    odds(oneSidedFixture, "over_2_5_goals", "Over", 1.8, now),
    odds(oneSidedFixture, "match_winner", "Germany", 1.45, now),
    odds(oneSidedFixture, "match_winner", "Draw", 5.2, now),
    odds(oneSidedFixture, "match_winner", "Curacao", 10, now)
  ];
  const teamStats = [
    stats("Germany", 1830, 2.2, 2.55, 0.62, 62),
    stats("Curacao", 1480, 0.8, 0.42, 1.75, 42)
  ];
  const legs = buildLegCandidates({
    fixtures: [oneSidedFixture],
    oddsSnapshots: oddsRecords,
    newsArticles: [],
    teamStats,
    policy,
    now
  });
  const bttsYes = legs.find((leg) => leg.market === "both_teams_to_score" && leg.outcome === "Yes");
  const over25 = legs.find((leg) => leg.market === "over_2_5_goals");

  assert.ok(bttsYes);
  assert.ok(over25);
  assert.ok(bttsYes.modelProbability < 0.46, `BTTS was too high: ${bttsYes.modelProbability}`);
  assert.ok(over25.modelProbability > bttsYes.modelProbability, "one-sided goal shape should favour totals over BTTS");
  assert.ok(bttsYes.components.marketFocusReasons.some((reason) => /one-sided/.test(reason)));
});

test("heavy result-market favourite suppresses underdog BTTS and ignores isolated winner outliers", () => {
  const now = new Date("2026-06-14T09:00:00.000Z");
  const fixtureRecord = fixture("ger-cur", "Germany", "Curaçao", "2026-06-14T17:00:00.000Z");
  const consensusTime = new Date("2026-06-14T08:00:00.000Z");
  const laterOutlier = new Date("2026-06-14T08:30:00.000Z");
  const policy = buildMostLikelyPolicy(basePolicy);
  const oddsRecords = [
    odds(fixtureRecord, "match_winner", "Germany", 1.05, consensusTime, { bookmaker: "Coral" }),
    odds(fixtureRecord, "match_winner", "Germany", 1.04, consensusTime, { bookmaker: "Ladbrokes" }),
    odds(fixtureRecord, "match_winner", "Germany", 1.03, consensusTime, { bookmaker: "BetVictor" }),
    odds(fixtureRecord, "match_winner", "Germany", 1.03, consensusTime, { bookmaker: "William Hill" }),
    odds(fixtureRecord, "match_winner", "Germany", 2, laterOutlier, { bookmaker: "Noisy preview page" }),
    odds(fixtureRecord, "match_winner", "Draw", 17, consensusTime, { bookmaker: "Coral" }),
    odds(fixtureRecord, "match_winner", "Draw", 15, consensusTime, { bookmaker: "Ladbrokes" }),
    odds(fixtureRecord, "match_winner", "Curaçao", 71, consensusTime, { bookmaker: "Coral" }),
    odds(fixtureRecord, "match_winner", "Curaçao", 51, consensusTime, { bookmaker: "Ladbrokes" }),
    odds(fixtureRecord, "both_teams_to_score", "Yes", 3.4, consensusTime, { bookmaker: "Coral" }),
    odds(fixtureRecord, "both_teams_to_score", "No", 1.45, consensusTime, { bookmaker: "Coral" })
  ];
  const latest = bestLatestOddsByOutcome(oddsRecords);
  const legs = buildLegCandidates({
    fixtures: [fixtureRecord],
    oddsSnapshots: oddsRecords,
    newsArticles: [],
    teamStats: [
      stats("Germany", 1792, 2.49, 2.25, 1.32, 53),
      stats("Curaçao", 1760, 1.87, 2.35, 1.66, 52)
    ],
    policy,
    now
  });
  const germanyWin = legs.find((leg) => leg.market === "match_winner" && leg.outcome === "Germany");
  const bttsYes = legs.find((leg) => leg.market === "both_teams_to_score" && leg.outcome === "Yes");

  assert.equal(latest.get("ger-cur|match_winner|Germany")?.decimalOdds, 1.05);
  assert.ok(germanyWin);
  assert.equal(germanyWin.decimalOdds, 1.05);
  assert.equal(germanyWin.components.highCertaintySurvivalFavorite, true);
  assert.ok(!germanyWin.hardBlocks.includes("edge_below_policy_minimum"));
  assert.ok(bttsYes);
  assert.ok(bttsYes.components.marketDominancePressure > 0.55);
  assert.ok(bttsYes.components.awayExpectedGoals < 0.94);
  assert.ok(bttsYes.hardBlocks.includes("btts_yes_underdog_goal_share_suppressed_by_result_market"));
});

test("survival markets become scored candidates when public prices are captured", () => {
  const now = new Date("2026-06-11T09:00:00.000Z");
  const fixtureRecord = fixture("mex-rsa", "Mexico", "South Africa", "2026-06-11T19:00:00.000Z");
  const policy = buildMostLikelyPolicy(basePolicy);
  const oddsRecords = [
    odds(fixtureRecord, "double_chance", "Mexico or Draw", 1.28, now),
    odds(fixtureRecord, "over_1_5_goals", "Over", 1.45, now),
    odds(fixtureRecord, "under_3_5_goals", "Under", 1.52, now),
    odds(fixtureRecord, "under_4_5_goals", "Under", 1.2, now),
    odds(fixtureRecord, "match_winner", "Mexico", 1.86, now),
    odds(fixtureRecord, "match_winner", "Draw", 4.1, now),
    odds(fixtureRecord, "match_winner", "South Africa", 5.8, now)
  ];
  const legs = buildLegCandidates({
    fixtures: [fixtureRecord],
    oddsSnapshots: oddsRecords,
    newsArticles: [],
    teamStats: [
      stats("Mexico", 1740, 2.1, 1.55, 0.9, 58),
      stats("South Africa", 1605, 1.1, 1.0, 1.35, 47)
    ],
    policy,
    now
  });
  const byMarket = new Map(legs.map((leg) => [leg.market, leg]));

  assert.equal(byMarket.get("double_chance")?.selectionLabel, "Mexico vs South Africa: Double chance: Mexico or Draw");
  assert.ok(byMarket.get("over_1_5_goals")?.modelProbability > 0.65);
  assert.ok(byMarket.get("under_3_5_goals")?.components.nonMarketSignals.some((signal) => /under-3.5/.test(signal)));
  assert.ok(byMarket.get("under_4_5_goals")?.modelProbability > byMarket.get("under_3_5_goals")?.modelProbability);
});

test("scorer odds become anytime and first-goalscorer leg candidates when prices are captured", () => {
  const now = new Date("2026-06-11T09:00:00.000Z");
  const fixtureRecord = fixture("mex-rsa", "Mexico", "South Africa", "2026-06-11T19:00:00.000Z");
  const policy = buildRiskPolicy(basePolicy, 80);
  const oddsRecords = [
    odds(fixtureRecord, "anytime_scorer", "Raul Jimenez", 2.3, now, { playerName: "Raul Jimenez", playerTeam: "Mexico" }),
    odds(fixtureRecord, "first_goalscorer", "Raul Jimenez", 4.2, now, { playerName: "Raul Jimenez", playerTeam: "Mexico" })
  ];
  const teamStats = [
    {
      ...stats("Mexico", 1740, 2.1, 1.55, 0.9, 58),
      topScorers: [{ playerName: "Jimenez", goals: 6, matchesSampled: 20, scorerConfidence: 0.76 }]
    },
    stats("South Africa", 1605, 1.1, 1.0, 1.35, 47)
  ];
  const playerStats = [
    {
      team: "Mexico",
      playerName: "Jimenez",
      goals: 6,
      matchesSampled: 20,
      scoringMatches: 5,
      scorerConfidence: 0.76,
      updatedAt: now.toISOString()
    }
  ];
  const legs = buildLegCandidates({
    fixtures: [fixtureRecord],
    oddsSnapshots: oddsRecords,
    newsArticles: [],
    teamStats,
    policy,
    now,
    playerStats
  });
  const anytime = legs.find((leg) => leg.market === "anytime_scorer");
  const first = legs.find((leg) => leg.market === "first_goalscorer");

  assert.ok(anytime);
  assert.ok(first);
  assert.equal(first.selectionLabel, "Mexico vs South Africa: Raul Jimenez first goalscorer");
  assert.ok(first.modelProbability < anytime.modelProbability);
  assert.equal(first.components.scorerMarketType, "first_goalscorer");
  assert.ok(first.components.scorerGoalsPerTwentyTeamMatches > 0);
});

test("heat layer is capped as a small result and goals adjustment", () => {
  const fixtureRecord = fixture("ksa-nor", "Saudi Arabia", "Norway", "2026-06-18T20:00:00.000Z");
  const model = fixtureModel({
    fixture: fixtureRecord,
    homeStats: stats("Saudi Arabia", 1660, 1.4, 1.25, 1.2, 49),
    awayStats: stats("Norway", 1720, 1.6, 1.45, 1.05, 54),
    newsByTeam: new Map(),
    heatRecord: {
      fixtureId: fixtureRecord.id,
      capturedAt: "2026-06-07T09:00:00.000Z",
      provider: "public-web",
      sourceType: "public-web",
      source: "Test heat source",
      location: "Houston",
      temperatureC: 35,
      humidityPct: 76,
      heatIndexC: 49,
      heatStress: 1,
      confidence: 0.72
    }
  });

  assert.ok(Math.abs(model.components.heatEdge) <= 28);
  assert.ok(model.components.heatExpectedGoalsAdjustment >= -0.15);
  assert.ok(model.components.expectedGoals < 2.75);
  assert.ok(model.components.heatStress <= 1);
});

test("tournament context applies a capped opening-game caution to goal markets", () => {
  const fixtureRecord = fixture("qat-sui", "Qatar", "Switzerland", "2026-06-13T20:00:00.000Z");
  const homeStats = stats("Qatar", 1690, 1.6, 1.45, 1.2, 51);
  const awayStats = stats("Switzerland", 1740, 1.7, 1.48, 1.05, 55);
  const middleContext = {
    phase: "middle_group_game",
    homeGroupGameNumber: 2,
    awayGroupGameNumber: 2,
    bothOpeningGroupGame: false,
    oneOpeningGroupGame: false,
    note: "Middle group game."
  };
  const openingContext = {
    phase: "opening_group_game",
    homeGroupGameNumber: 1,
    awayGroupGameNumber: 1,
    bothOpeningGroupGame: true,
    oneOpeningGroupGame: false,
    note: "Both teams are playing their first group game, so the model adds a small don't-lose-first caution to goal-heavy bets."
  };
  const middle = fixtureModel({
    fixture: fixtureRecord,
    homeStats,
    awayStats,
    newsByTeam: new Map(),
    tournamentContext: middleContext
  });
  const opening = fixtureModel({
    fixture: fixtureRecord,
    homeStats,
    awayStats,
    newsByTeam: new Map(),
    tournamentContext: openingContext
  });

  assert.ok(opening.components.expectedGoals < middle.components.expectedGoals);
  assert.ok(opening.components.openingOver25Adjustment < 0);
  assert.ok(opening.components.preOpeningOver25ShapeProbability > opening.rawMarketProbabilities.over_2_5_goals.Over);
  assert.ok(opening.rawMarketProbabilities.over_2_5_goals.Over < middle.rawMarketProbabilities.over_2_5_goals.Over);
  assert.ok(opening.rawMarketProbabilities.both_teams_to_score.Yes < middle.rawMarketProbabilities.both_teams_to_score.Yes);
  assert.ok(opening.rawMarketProbabilities.match_winner.Draw > middle.rawMarketProbabilities.match_winner.Draw);
  assert.equal(opening.components.bothOpeningGroupGame, true);
  assert.ok(opening.components.tournamentContextNote.includes("don't-lose-first"));
});

test("opening group over 2.5 needs stronger two-sided evidence before eligibility", () => {
  const now = new Date("2026-06-12T09:00:00.000Z");
  const fixtureRecord = fixture("one-sided-opener", "Favourite", "Underdog", "2026-06-13T19:00:00.000Z");
  const policy = buildRiskPolicy(basePolicy, 65);
  const legs = buildLegCandidates({
    fixtures: [fixtureRecord],
    oddsSnapshots: [
      odds(fixtureRecord, "over_2_5_goals", "Over", 2.05, now),
      odds(fixtureRecord, "under_2_5_goals", "Under", 1.82, now)
    ],
    newsArticles: [],
    teamStats: [
      stats("Favourite", 1790, 1.8, 1.48, 0.95, 58),
      stats("Underdog", 1540, 1.1, 0.72, 1.45, 42)
    ],
    policy,
    now
  });
  const over25 = legs.find((leg) => leg.market === "over_2_5_goals");

  assert.ok(over25);
  assert.ok(over25.components.openingOver25Adjustment < -0.02);
  assert.ok(over25.hardBlocks.includes("opening_group_over25_requires_stronger_total_edge"));
});

test("tournament context counts group-game order from the known fixture list and ignores duplicate pair rows", () => {
  const context = buildTournamentContextByFixture([
    fixture("tun-jpn-a", "Tunisia", "Japan", "2026-06-15T03:00:00.000Z"),
    fixture("ned-swe", "Netherlands", "Sweden", "2026-06-15T18:00:00.000Z"),
    fixture("tun-jpn-b", "Tunisia", "Japan", "2026-06-16T03:00:00.000Z"),
    fixture("swe-tun", "Sweden", "Tunisia", "2026-06-20T18:00:00.000Z"),
    fixture("jpn-ned", "Japan", "Netherlands", "2026-06-20T20:00:00.000Z")
  ]);

  assert.equal(context.get("tun-jpn-a").bothOpeningGroupGame, true);
  assert.equal(context.get("tun-jpn-b").duplicateFixture, true);
  assert.equal(context.get("tun-jpn-b").homeGroupGameNumber, 1);
  assert.equal(context.get("swe-tun").homeGroupGameNumber, 2);
  assert.equal(context.get("swe-tun").awayGroupGameNumber, 2);
  assert.equal(context.get("swe-tun").phase, "middle_group_game");
});

test("fixture model exposes passing and tactical intelligence in the style edge", () => {
  const fixtureRecord = fixture("esp-cro", "Spain", "Croatia", "2026-06-20T20:00:00.000Z");
  const model = fixtureModel({
    fixture: fixtureRecord,
    homeStats: {
      ...stats("Spain", 1840, 2.2, 1.8, 0.8, 63),
      manager: "Luis de la Fuente",
      passesAttempted: 610,
      completedPasses: 540,
      passCompletion: 0.885,
      tacticalProfile: {
        likelyFormation: "4-3-3",
        styleOfPlay: "possession-led build-up with high territory",
        styleTags: ["possession", "patient build-up"]
      },
      topScorers: [{ playerName: "Spain Forward", goals: 6 }]
    },
    awayStats: {
      ...stats("Croatia", 1715, 1.4, 1.1, 1.2, 50),
      manager: "Croatia Coach",
      passesAttempted: 420,
      completedPasses: 334,
      passCompletion: 0.795,
      tacticalProfile: {
        likelyFormation: "4-2-3-1",
        styleOfPlay: "balanced mid-block with mixed build-up",
        styleTags: ["balanced"]
      },
      topScorers: [{ playerName: "Croatia Forward", goals: 4 }]
    },
    newsByTeam: new Map()
  });

  assert.equal(model.components.homeManager, "Luis de la Fuente");
  assert.equal(model.components.homeLikelyFormation, "4-3-3");
  assert.ok(model.components.homeTopScorers.includes("Spain Forward"));
  assert.ok(model.components.buildUpEdge > 0);
  assert.ok(model.components.homePassCompletion > model.components.awayPassCompletion);
});

test("fixture model reins in weaker-team goal share when quality gap and Miami heat point the same way", () => {
  const fixtureRecord = {
    ...fixture("sco-bra", "Scotland", "Brazil", "2026-06-24T22:00:00.000Z"),
    venue: "Hard Rock Stadium, Miami"
  };
  const model = fixtureModel({
    fixture: fixtureRecord,
    homeStats: {
      ...stats("Scotland", 1741.9, 1.702, 1.891, 1.271, 51),
      sourceMatchCount: 20,
      longForm: {
        matchCount: 20,
        scoringGameRate: 0.7,
        concedeGameRate: 0.65,
        cleanSheetRate: 0.35,
        failedToScoreRate: 0.3,
        bttsRate: 0.4,
        over25Rate: 0.6
      },
      marketAngles: {
        scoringGameRate: 0.7,
        concedeGameRate: 0.65,
        cleanSheetRate: 0.35,
        failedToScoreRate: 0.3,
        bttsRate: 0.4,
        over25Rate: 0.6
      }
    },
    awayStats: {
      ...stats("Brazil", 1806.4, 2.366, 2.652, 1.482, 53),
      sourceMatchCount: 20,
      longForm: {
        matchCount: 20,
        scoringGameRate: 0.95,
        concedeGameRate: 0.75,
        cleanSheetRate: 0.25,
        failedToScoreRate: 0.05,
        bttsRate: 0.7,
        over25Rate: 0.7
      },
      marketAngles: {
        scoringGameRate: 0.95,
        concedeGameRate: 0.75,
        cleanSheetRate: 0.25,
        failedToScoreRate: 0.05,
        bttsRate: 0.7,
        over25Rate: 0.7
      }
    },
    newsByTeam: new Map(),
    homeSquadDepth: { team: "Scotland", depthScore: 0.54, confidence: 0.44 },
    awaySquadDepth: { team: "Brazil", depthScore: 0.9, confidence: 0.7 }
  });

  assert.ok(model.components.heatStress > 0);
  assert.equal(model.components.heatClimateBand, "hotHumid");
  assert.ok(model.components.combinedHeatDifferential < 0);
  assert.ok(model.components.qualityGapEdge < 0);
  assert.ok(model.components.homeQualityGoalAdjustment < -0.25);
  assert.ok(model.components.awayQualityGoalAdjustment > 0);
  assert.ok(model.components.homeExpectedGoals < 1.35);
  assert.ok(model.components.awayExpectedGoals > model.components.homeExpectedGoals);
  assert.ok(model.rawMarketProbabilities.over_2_5_goals.Over < 0.67);
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

function mockSingleLeg({
  id,
  homeTeam,
  awayTeam,
  market = "both_teams_to_score",
  outcome = "Yes",
  decimalOdds,
  modelProbability,
  edge,
  independentEdge,
  confidence,
  riskTag,
  score
}) {
  const impliedProbability = 1 / decimalOdds;

  return {
    id,
    fixtureId: `fixture-${id}`,
    fixtureDate: "2026-06-20T20:00:00.000Z",
    homeTeam,
    awayTeam,
    market,
    outcome,
    selectionLabel: `${homeTeam} vs ${awayTeam}: ${outcome}`,
    bookmaker: "Public Test Book",
    decimalOdds,
    modelProbability,
    rawModelProbability: modelProbability,
    impliedProbability,
    marketImpliedProbability: impliedProbability,
    edge,
    independentEdge,
    confidence,
    riskTag,
    score,
    hardBlocks: [],
    components: {
      intelligenceConfidence: confidence,
      nonMarketSignalCount: 4,
      oddsFreshness: 1,
      nonMarketSignals: ["test signal one", "test signal two", "test signal three", "test signal four"]
    }
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
      odds(item, "double_chance", `${item.homeTeam} or Draw`, 1.32, now),
      odds(item, "over_1_5_goals", "Over", 1.42, now),
      odds(item, "over_2_5_goals", "Over", 2.05, now),
      odds(item, "under_2_5_goals", "Under", 1.9, now),
      odds(item, "under_3_5_goals", "Under", 1.5, now),
      odds(item, "under_4_5_goals", "Under", 1.2, now),
      odds(item, "both_teams_to_score", "Yes", 2.12, now),
      odds(item, "both_teams_to_score", "No", 1.82, now),
      odds(item, "anytime_scorer", `${item.homeTeam} striker`, 4.5, now)
    );
  }

  return records;
}

function odds(fixture, market, outcome, decimalOdds, now, extra = {}) {
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
    decimalOdds,
    ...extra
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
    sourceMatchCount: 3,
    passesAttempted: 450,
    completedPasses: 365,
    passCompletion: 0.811
  };
}
