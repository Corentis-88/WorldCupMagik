import test from "node:test";
import assert from "node:assert/strict";
import { gradeLegAgainstMatch, settleBetOutcomes } from "../src/outcome-settler.mjs";

test("settles recommended result and goals legs against completed match history", () => {
  const now = new Date("2026-06-12T12:00:00.000Z");
  const legCandidates = [
    leg("leg-mex-win", "match_winner", "Mexico", 1.86),
    leg("leg-btts", "both_teams_to_score", "Yes", 2.1),
    leg("leg-over", "over_2_5_goals", "Over", 1.9),
    leg("leg-dnb", "draw_no_bet", "South Africa", 2.8),
    leg("leg-dc", "double_chance", "Mexico or Draw", 1.28),
    leg("leg-over15", "over_1_5_goals", "Over", 1.45),
    leg("leg-under35", "under_3_5_goals", "Under", 1.52),
    leg("leg-under45", "under_4_5_goals", "Under", 1.2)
  ];
  const recommendations = {
    singles: [{ legs: [legCandidates[0]] }],
    doubles: [{ legs: [legCandidates[1], legCandidates[2]] }],
    trixies: [{ legs: [legCandidates[3], legCandidates[4], legCandidates[5]] }],
    accumulators: [],
    accumulatorsByLegCount: {
      4: [{ legs: [legCandidates[4], legCandidates[5], legCandidates[6], legCandidates[7]] }]
    }
  };
  const settlement = settleBetOutcomes({
    legCandidates,
    recommendations,
    matchHistory: [match("Mexico", "South Africa", 2, 1)],
    existingOutcomes: [],
    now
  });

  assert.equal(settlement.insertedCount, 8);
  assert.equal(statusFor(settlement, "match_winner"), "won");
  assert.equal(statusFor(settlement, "both_teams_to_score"), "won");
  assert.equal(statusFor(settlement, "over_2_5_goals"), "won");
  assert.equal(statusFor(settlement, "draw_no_bet"), "lost");
  assert.equal(statusFor(settlement, "double_chance"), "won");
  assert.equal(statusFor(settlement, "over_1_5_goals"), "won");
  assert.equal(statusFor(settlement, "under_3_5_goals"), "won");
  assert.equal(statusFor(settlement, "under_4_5_goals"), "won");
  assert.ok(settlement.newRecords.every((record) => record.source === "auto-settled-public-match-history"));
});

test("settles draw-no-bet pushes as void and leaves them out of learning", () => {
  const result = gradeLegAgainstMatch(leg("leg-dnb", "draw_no_bet", "Mexico", 1.7), match("Mexico", "South Africa", 1, 1));

  assert.equal(result.status, "void");
  assert.equal(result.reason, "draw_no_bet_push");
});

test("settles historical app scan legs and team aliases", () => {
  const now = new Date("2026-06-13T16:00:00.000Z");
  const appLeg = {
    ...leg("leg-usa-over", "over_2_5_goals", "Over", 2.05),
    fixtureId: "usa-par",
    fixtureDate: "2026-06-13T01:00:00.000Z",
    homeTeam: "USA",
    awayTeam: "Paraguay",
    selectionLabel: "USA vs Paraguay: Over 2.5 goals"
  };
  const settlement = settleBetOutcomes({
    legCandidates: [],
    recommendations: null,
    appScans: [{ betslip: [{ legs: [appLeg] }] }],
    matchHistory: [{
      ...match("United States", "Paraguay", 4, 1),
      fixtureId: "usa-par",
      date: "2026-06-12T12:00:00.000Z"
    }],
    existingOutcomes: [],
    now
  });

  assert.equal(settlement.insertedCount, 1);
  assert.equal(settlement.newRecords[0].status, "won");
  assert.equal(settlement.skipped.noRecommendations, 0);
});

test("does not settle scorer bets when public scorer rows are missing for a goal game", () => {
  const result = gradeLegAgainstMatch(
    { ...leg("leg-scorer", "anytime_scorer", "Raul Jimenez", 3.4), playerName: "Raul Jimenez", playerTeam: "Mexico" },
    match("Mexico", "South Africa", 2, 1)
  );

  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "scorer_list_missing");
});

test("matches scorer surnames and corrects stale settled scorer status", () => {
  const now = new Date("2026-06-12T12:00:00.000Z");
  const scorerLeg = { ...leg("leg-scorer", "anytime_scorer", "Raul Jimenez", 3.4), playerName: "Raul Jimenez", playerTeam: "Mexico" };
  const playedMatch = {
    ...match("Mexico", "South Africa", 2, 0),
    homeScorers: [{ name: "Jimenez", goals: 1 }, { name: "Quinones", goals: 1 }]
  };
  const result = gradeLegAgainstMatch(scorerLeg, playedMatch);
  const settlement = settleBetOutcomes({
    legCandidates: [scorerLeg],
    recommendations: { singles: [{ legs: [scorerLeg] }] },
    matchHistory: [playedMatch],
    existingOutcomes: [{
      ...scorerLeg,
      legId: scorerLeg.id,
      matchDate: playedMatch.date,
      status: "lost",
      resultReason: "anytime_scorer"
    }],
    now
  });

  assert.equal(result.status, "won");
  assert.equal(settlement.insertedCount, 1);
  assert.equal(settlement.newRecords[0].status, "won");

  assert.equal(gradeLegAgainstMatch(
    { ...leg("leg-usa-scorer", "anytime_scorer", "Folarin Balogun", 5.3), homeTeam: "USA", awayTeam: "Paraguay", playerName: "Folarin Balogun", playerTeam: "USA" },
    { ...match("United States", "Paraguay", 4, 1), homeScorers: [{ name: "Balogun", goals: 1 }] }
  ).status, "won");
});

test("settles first-goalscorer only when scorer order is available", () => {
  const selected = { ...leg("leg-first", "first_goalscorer", "Raul Jimenez", 4.2), playerName: "Raul Jimenez", playerTeam: "Mexico" };
  const orderedMatch = {
    ...match("Mexico", "South Africa", 2, 1),
    homeScorers: [{ name: "Raul Jimenez", minute: 12 }, { name: "Santiago Gimenez", minute: 68 }],
    awayScorers: [{ name: "Lyle Foster", minute: 54 }]
  };
  const unorderedMatch = {
    ...match("Mexico", "South Africa", 2, 1),
    homeScorers: [{ name: "Raul Jimenez" }],
    awayScorers: [{ name: "Lyle Foster" }]
  };

  assert.equal(gradeLegAgainstMatch(selected, orderedMatch).status, "won");
  assert.equal(gradeLegAgainstMatch(selected, unorderedMatch).reason, "first_scorer_order_missing");
});

test("settles anytime assist when public scorer rows include assists", () => {
  const selected = { ...leg("leg-assist", "anytime_assist", "Joshua Kimmich", 3.1), playerName: "Joshua Kimmich", playerTeam: "Germany" };
  const assistedMatch = {
    ...match("Germany", "Curacao", 3, 0),
    homeScorers: [{ name: "Kai Havertz", goals: 1, assists: ["Kimmich"] }]
  };
  const unassistedMatch = {
    ...match("Germany", "Curacao", 3, 0),
    homeScorers: [{ name: "Kai Havertz", goals: 1, assists: [] }],
    capturedMetricFields: ["score", "assists"]
  };
  const missingAssistMatch = {
    ...match("Germany", "Curacao", 3, 0),
    homeScorers: [{ name: "Kai Havertz", goals: 1 }]
  };

  assert.equal(gradeLegAgainstMatch(selected, assistedMatch).status, "won");
  assert.equal(gradeLegAgainstMatch(selected, unassistedMatch).status, "lost");
  assert.equal(gradeLegAgainstMatch(selected, missingAssistMatch).reason, "assist_list_missing");
});

test("settles prediction-ledger assist legs even when they were not in the displayed slip", () => {
  const now = new Date("2026-06-12T12:00:00.000Z");
  const assistLeg = {
    ...leg("leg-ledger-assist", "anytime_assist", "Luis Chavez", 3.2),
    playerName: "Luis Chavez",
    playerTeam: "Mexico",
    selectionLabel: "Mexico vs South Africa: Luis Chavez anytime assist",
    components: {
      nonMarketSignalCount: 6,
      dataCompleteness: 0.82,
      assistMarketType: "anytime_assist",
      assistConfidence: 0.74,
      assistsPerTwentyTeamMatches: 4,
      creativeRoleScore: 0.68
    }
  };
  const playedMatch = {
    ...match("Mexico", "South Africa", 2, 1),
    homeScorers: [{ name: "Raul Jimenez", goals: 1, assists: ["L. Chavez"] }],
    awayScorers: [{ name: "Lyle Foster", goals: 1, assists: ["Teboho Mokoena"] }],
    capturedMetricFields: ["score", "assists"]
  };
  const settlement = settleBetOutcomes({
    predictionLedger: [assistLeg],
    matchHistory: [playedMatch],
    existingOutcomes: [],
    now
  });

  assert.equal(settlement.insertedCount, 1);
  assert.equal(settlement.newRecords[0].market, "anytime_assist");
  assert.equal(settlement.newRecords[0].status, "won");
  assert.equal(settlement.newRecords[0].predictionShape.assistMarketType, "anytime_assist");
  assert.equal(settlement.skipped.noRecommendations, 0);
});

test("does not settle ledger predictions captured after kickoff", () => {
  const now = new Date("2026-06-12T12:00:00.000Z");
  const lateLeg = {
    ...leg("leg-late", "over_2_5_goals", "Over", 1.9),
    createdAt: "2026-06-11T19:20:00.000Z"
  };
  const settlement = settleBetOutcomes({
    predictionLedger: [lateLeg],
    matchHistory: [match("Mexico", "South Africa", 2, 1)],
    existingOutcomes: [],
    now
  });

  assert.equal(settlement.insertedCount, 0);
  assert.equal(settlement.skipped.latePrediction, 1);
  assert.equal(settlement.skipped.noMatch, 0);
});

test("settlement stores closing line value when pre-kickoff odds history exists", () => {
  const now = new Date("2026-06-12T12:00:00.000Z");
  const selected = leg("leg-clv", "match_winner", "Mexico", 2.1);
  const settlement = settleBetOutcomes({
    predictionLedger: [selected],
    matchHistory: [match("Mexico", "South Africa", 2, 1)],
    oddsSnapshots: [{
      fixtureId: "mex-rsa",
      fixtureDate: "2026-06-11T19:00:00.000Z",
      market: "match_winner",
      outcome: "Mexico",
      bookmaker: "Closing Test Book",
      decimalOdds: 1.9,
      capturedAt: "2026-06-11T18:52:00.000Z"
    }],
    existingOutcomes: [],
    now
  });

  assert.equal(settlement.insertedCount, 1);
  assert.equal(settlement.newRecords[0].closingLine.decimalOdds, 1.9);
  assert.ok(settlement.newRecords[0].closingLineValue.decimal > 0);
});

function statusFor(settlement, market) {
  return settlement.newRecords.find((record) => record.market === market)?.status;
}

function leg(id, market, outcome, decimalOdds) {
  return {
    id,
    createdAt: "2026-06-10T10:00:00.000Z",
    fixtureId: "mex-rsa",
    fixtureDate: "2026-06-11T19:00:00.000Z",
    homeTeam: "Mexico",
    awayTeam: "South Africa",
    market,
    outcome,
    selectionLabel: `Mexico vs South Africa: ${outcome}`,
    bookmaker: "Public Test Book",
    decimalOdds,
    modelProbability: 0.62,
    rawModelProbability: 0.64,
    impliedProbability: 1 / decimalOdds,
    marketImpliedProbability: 1 / decimalOdds,
    confidence: 0.77,
    edge: 0.08,
    independentEdge: 0.09,
    riskTag: "steady_edge",
    components: {
      nonMarketSignalCount: 5,
      dataCompleteness: 0.8
    }
  };
}

function match(homeTeam, awayTeam, homeGoals, awayGoals) {
  return {
    date: "2026-06-11T19:00:00.000Z",
    homeTeam,
    awayTeam,
    homeGoals,
    awayGoals,
    homeScorers: [],
    awayScorers: [],
    sourceType: "public-web"
  };
}
