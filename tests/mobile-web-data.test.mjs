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
