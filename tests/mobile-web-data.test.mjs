import assert from "node:assert/strict";
import test from "node:test";

import { buildMobilePayload } from "../src/mobile-web-data.mjs";

test("mobile payload includes daily likely assist groups", () => {
  const payload = buildMobilePayload({
    generatedAt: "2026-06-15T08:00:00.000Z",
    profiles: {},
    pickOfTheDay: {},
    riskBuckets: [],
    dayBuckets: [],
    dateRange: {},
    fixtures: [{
      id: "fixture_assists",
      date: "2026-06-15T17:00:00.000Z",
      dateKey: "2026-06-15",
      homeTeam: "Alpha",
      awayTeam: "Beta"
    }],
    legCandidatesByRisk: {},
    mostLikelyLegCandidates: [],
    markets: {},
    intelligence: {},
    playerStats: {
      teams: {
        Alpha: [{
          playerName: "Casey Creator",
          assists: 4,
          assistsPerTwentyTeamMatches: 4,
          goalInvolvementsPerTwentyTeamMatches: 6,
          matchesSampled: 20,
          assistConfidence: 0.7,
          creativeRoleScore: 0.62,
          playerDataCoverage: 0.8
        }],
        Beta: [{
          playerName: "Bailey Wide",
          goals: 3,
          goalsPerTwentyTeamMatches: 3,
          goalInvolvementsPerTwentyTeamMatches: 3,
          matchesSampled: 20,
          assistConfidence: 0.55,
          creativeRoleScore: 0.42,
          playerDataCoverage: 0.55
        }]
      }
    },
    teamProfiles: {
      teams: {
        Alpha: { longForm: { xgFor: 1.7, xgAgainst: 1.0 } },
        Beta: { longForm: { xgFor: 1.1, xgAgainst: 1.6 } }
      }
    }
  });

  const groups = payload.likelyAssistsByDate["2026-06-15"];

  assert.equal(groups.length, 1);
  assert.equal(groups[0].fixtureLabel, "Alpha vs Beta");
  assert.equal(groups[0].players[0].playerName, "Casey Creator");
  assert.equal(groups[0].players[0].market, "anytime_assist");
  assert.match(groups[0].players[0].reason, /assists in last 20 team games/);
});

test("mobile payload includes compact likely event market groups", () => {
  const payload = buildMobilePayload({
    generatedAt: "2026-06-15T08:00:00.000Z",
    profiles: {},
    pickOfTheDay: {},
    riskBuckets: [],
    dayBuckets: [],
    dateRange: {},
    fixtures: [],
    legCandidatesByRisk: {},
    mostLikelyLegCandidates: [],
    markets: {},
    intelligence: {},
    playerStats: { teams: {} },
    teamProfiles: { teams: {} },
    likelyEventsByDate: {
      "2026-06-15": {
        playerShotsOnTarget: [{
          fixture: {
            id: "fixture_events",
            date: "2026-06-15T17:00:00.000Z",
            dateKey: "2026-06-15",
            homeTeam: "Alpha",
            awayTeam: "Beta"
          },
          fixtureLabel: "Alpha vs Beta",
          players: [{
            playerName: "Alex Shooter",
            team: "Alpha",
            probability: 0.54,
            confidence: 0.7,
            reason: "1+ shot on target odds",
            market: "player_shot_on_target",
            decimalOdds: 1.83
          }]
        }],
        playerCards: [],
        penalties: [{
          fixture: {
            id: "fixture_events",
            date: "2026-06-15T17:00:00.000Z",
            dateKey: "2026-06-15",
            homeTeam: "Alpha",
            awayTeam: "Beta"
          },
          fixtureLabel: "Alpha vs Beta",
          events: [{
            event: "Penalty awarded",
            outcome: "Yes",
            probability: 0.28,
            confidence: 0.62,
            reason: "market yes/no prices",
            market: "penalty_awarded"
          }]
        }],
        redCards: []
      }
    }
  });

  assert.equal(payload.likelyEventsByDate["2026-06-15"].playerShotsOnTarget[0].players[0].playerName, "Alex Shooter");
  assert.equal(payload.likelyEventsByDate["2026-06-15"].penalties[0].events[0].outcome, "Yes");
});

test("mobile profile keeps selection-brain metadata", () => {
  const payload = buildMobilePayload({
    generatedAt: "2026-06-15T08:00:00.000Z",
    profiles: {
      "14_85": {
        daysAhead: 14,
        risk: 85,
        betslip: [{
          rank: 1,
          category: "accumulator_4",
          label: "4-leg accumulator",
          type: "accumulator",
          score: 82,
          legCount: 4,
          combinedDecimalOdds: 24,
          combinedProbability: 0.08,
          stake: 10,
          potentialReturn: 240,
          selectionIntent: "free_bet_value",
          recommendedUse: "free_bet",
          selectionQuality: "sound",
          selectionBrainScore: 71.4,
          cashScore: 58.1,
          freeBetScore: 73.6,
          longshotScore: 69.2,
          freeBetConversion: 1.84,
          probabilityRange: { low: 0.04, mid: 0.08, high: 0.12, width: 0.08, label: "tight" },
          portfolioWarnings: ["same_date_cluster"],
          legs: [{
            id: "leg-price-gone",
            fixtureId: "fixture-price",
            market: "over_2_5_goals",
            selectionLabel: "Alpha vs Beta: Over 2.5 goals",
            decimalOdds: 1.72,
            components: {
              bettingPerformanceMarketAction: "downgrade",
              bettingPerformanceMarketRoi: -0.12,
              bettingPerformanceMarketClv: -0.018,
              bettingPerformanceReasons: ["over_2_5_goals is being downgraded"],
              priceGone: true,
              livePriceDiscipline: {
                priceGone: true,
                reason: "price shortened 9.5% from recent average"
              }
            }
          }]
        }]
      }
    },
    pickOfTheDay: {},
    riskBuckets: [],
    dayBuckets: [],
    dateRange: {},
    fixtures: [],
    legCandidatesByRisk: {},
    mostLikelyLegCandidates: [],
    markets: {},
    intelligence: {
      bettingPerformance: {
        outcomeCount: 12,
        market: {
          over_2_5_goals: { action: "downgrade", cashRoi: -0.12 }
        }
      }
    },
    playerStats: { teams: {} },
    teamProfiles: { teams: {} }
  });

  const bet = payload.profiles["14_85"].betslip[0];
  const leg = bet.legs[0];

  assert.equal(bet.selectionIntent, "free_bet_value");
  assert.equal(bet.recommendedUse, "free_bet");
  assert.equal(bet.probabilityRange.label, "tight");
  assert.deepEqual(bet.portfolioWarnings, ["same_date_cluster"]);
  assert.equal(payload.intelligence.bettingPerformance.outcomeCount, 12);
  assert.equal(leg.components.priceGone, true);
  assert.equal(leg.components.bettingPerformanceMarketAction, "downgrade");
});
