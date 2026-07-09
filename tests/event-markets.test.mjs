import assert from "node:assert/strict";
import test from "node:test";
import { buildLikelyEventsByDate, buildTournamentEventProfile } from "../src/event-markets.mjs";

test("event market builder creates player and yes/no sections from odds plus tournament evidence", () => {
  const fixtures = [{
    id: "alpha-beta",
    date: "2026-06-18T20:00:00.000Z",
    dateKey: "2026-06-18",
    homeTeam: "Alpha",
    awayTeam: "Beta",
    stage: "Group"
  }];
  const oddsSnapshots = [
    {
      fixtureId: "alpha-beta",
      fixtureDate: fixtures[0].date,
      homeTeam: "Alpha",
      awayTeam: "Beta",
      market: "player_shot_on_target",
      outcome: "Alex Shooter",
      playerName: "Alex Shooter",
      playerTeam: "Alpha",
      bookmaker: "ExampleBook",
      decimalOdds: 1.8,
      capturedAt: "2026-06-18T12:00:00.000Z",
      provider: "public-web"
    },
    {
      fixtureId: "alpha-beta",
      fixtureDate: fixtures[0].date,
      homeTeam: "Alpha",
      awayTeam: "Beta",
      market: "player_card",
      outcome: "Blake Marker",
      playerName: "Blake Marker",
      playerTeam: "Beta",
      bookmaker: "ExampleBook",
      decimalOdds: 3.2,
      capturedAt: "2026-06-18T12:00:00.000Z",
      provider: "public-web"
    },
    {
      fixtureId: "alpha-beta",
      market: "penalty_awarded",
      outcome: "Yes",
      bookmaker: "ExampleBook",
      decimalOdds: 3.4,
      capturedAt: "2026-06-18T12:00:00.000Z"
    },
    {
      fixtureId: "alpha-beta",
      market: "penalty_awarded",
      outcome: "No",
      bookmaker: "ExampleBook",
      decimalOdds: 1.28,
      capturedAt: "2026-06-18T12:00:00.000Z"
    }
  ];
  const playerStats = [
    {
      team: "Alpha",
      playerName: "Alex Shooter",
      matchesSampled: 20,
      shotsOnTarget: 14,
      goalsPerTwentyTeamMatches: 6,
      scoringRoleScore: 0.68,
      playerDataCoverage: 0.74
    },
    {
      team: "Beta",
      playerName: "Blake Marker",
      matchesSampled: 20,
      position: "Defender",
      playerDataCoverage: 0.62
    }
  ];
  const postMatchStats = [
    { homeTeam: "One", awayTeam: "Two", penaltyAwarded: true, homeYellowCards: 3, awayYellowCards: 2, homeRedCards: 0, awayRedCards: 1, homeFouls: 15, awayFouls: 16 },
    { homeTeam: "Three", awayTeam: "Four", penaltyAwarded: false, homeYellowCards: 1, awayYellowCards: 2, homeRedCards: 0, awayRedCards: 0, homeFouls: 10, awayFouls: 11 }
  ];
  const events = buildLikelyEventsByDate({
    fixtures,
    oddsSnapshots,
    teamStats: [
      { team: "Alpha", xgFor: 1.8, shotsFor: 14, shotsOnTargetFor: 5, longForm: { foulsFor: 13 } },
      { team: "Beta", xgFor: 1.1, shotsFor: 9, shotsOnTargetAgainst: 4, longForm: { foulsFor: 15 } }
    ],
    playerStats,
    postMatchStats,
    now: new Date("2026-06-18T12:10:00.000Z")
  });

  const day = events["2026-06-18"];

  assert.equal(day.playerShotsOnTarget[0].players[0].playerName, "Alex Shooter");
  assert.equal(day.playerShotsOnTarget[0].players[0].decimalOdds, 1.8);
  assert.equal(day.playerCards[0].players[0].playerName, "Blake Marker");
  assert.equal(day.penalties[0].events.find((event) => event.outcome === "Yes").decimalOdds, 3.4);
  assert.equal(day.redCards[0].events.length, 2);
});

test("tournament event profile learns penalty and red-card rates from post-match records", () => {
  const profile = buildTournamentEventProfile([
    { homeTeam: "One", awayTeam: "Two", penaltyAwarded: true, homeYellowCards: 2, awayYellowCards: 3, homeRedCards: 0, awayRedCards: 1, homeFouls: 11, awayFouls: 12 },
    { homeTeam: "Three", awayTeam: "Four", penaltyAwarded: false, homeYellowCards: 1, awayYellowCards: 1, homeRedCards: 0, awayRedCards: 0, homeFouls: 9, awayFouls: 10 }
  ]);

  assert.equal(profile.matchCount, 2);
  assert.equal(profile.penaltyRate, 0.5);
  assert.equal(profile.redCardRate, 0.5);
  assert.equal(profile.yellowCardsPerMatch, 3.5);
});
