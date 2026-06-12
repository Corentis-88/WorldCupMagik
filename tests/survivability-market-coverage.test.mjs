import test from "node:test";
import assert from "node:assert/strict";
import { buildSurvivabilityMarketCoverage } from "../src/survivability-market-coverage.mjs";

test("survivability market gate is satisfied only when fresh public-web coverage is deep enough", () => {
  const now = new Date("2026-06-12T12:00:00.000Z");
  const fixtures = [
    fixture("one", "Mexico", "South Africa"),
    fixture("two", "Canada", "Bosnia and Herzegovina"),
    fixture("three", "USA", "Paraguay"),
    fixture("four", "Brazil", "Morocco")
  ];
  const oddsSnapshots = [
    odds(fixtures[0], "BetOne", "Mexico -0.5", "-0.5", 1.88, now),
    odds(fixtures[0], "BetTwo", "South Africa +0.5", "+0.5", 1.92, now),
    odds(fixtures[1], "BetOne", "Canada -0.25", "-0.25", 1.82, now),
    odds(fixtures[1], "BetTwo", "Bosnia and Herzegovina +0.25", "+0.25", 2.01, now),
    odds(fixtures[2], "BetOne", "USA -0.75", "-0.75", 1.97, now),
    odds(fixtures[2], "BetTwo", "Paraguay +0.75", "+0.75", 1.86, now),
    odds(fixtures[3], "BetOne", "Brazil -1", "-1", 1.76, new Date("2026-06-08T10:00:00.000Z"))
  ];
  const coverage = buildSurvivabilityMarketCoverage({
    fixtures,
    oddsSnapshots,
    now,
    policy: {
      survivabilityMarketGate: {
        maxRecordAgeHours: 72,
        minRecords: 6,
        minFixtures: 3,
        minFixtureCoverage: 0.7,
        minBookmakers: 2,
        minAverageBookmakersPerFixture: 2,
        minLineCount: 2,
        markets: [{ key: "asian_handicap", label: "Asian handicap" }]
      }
    }
  });

  assert.equal(coverage.status, "satisfied");
  assert.equal(coverage.predictionActivation.enabled, false);
  assert.equal(coverage.markets.asian_handicap.gateSatisfied, true);
  assert.equal(coverage.markets.asian_handicap.freshRecordCount, 6);
  assert.equal(coverage.markets.asian_handicap.recordCount, 7);
  assert.equal(coverage.markets.asian_handicap.bookmakerCount, 2);
});

test("survivability market gate keeps thin markets in collect-only mode", () => {
  const now = new Date("2026-06-12T12:00:00.000Z");
  const fixtures = [
    fixture("one", "Mexico", "South Africa"),
    fixture("two", "Canada", "Bosnia and Herzegovina"),
    fixture("three", "USA", "Paraguay")
  ];
  const coverage = buildSurvivabilityMarketCoverage({
    fixtures,
    oddsSnapshots: [
      odds(fixtures[0], "BetOne", "Mexico -0.5", "-0.5", 1.88, now),
      odds(fixtures[1], "BetOne", "Canada -0.25", "-0.25", 1.82, now)
    ],
    now,
    policy: {
      survivabilityMarketGate: {
        minRecords: 6,
        minFixtures: 3,
        minBookmakers: 2,
        markets: [{ key: "asian_handicap", label: "Asian handicap" }]
      }
    }
  });

  assert.equal(coverage.status, "collecting");
  assert.equal(coverage.markets.asian_handicap.gateSatisfied, false);
  assert.ok(coverage.markets.asian_handicap.missing.length > 0);
});

function fixture(id, homeTeam, awayTeam) {
  return {
    id,
    date: "2026-06-12T19:00:00.000Z",
    homeTeam,
    awayTeam,
    sourceType: "public-web"
  };
}

function odds(fixtureRecord, bookmaker, outcome, line, decimalOdds, capturedAt) {
  return {
    id: `${fixtureRecord.id}-${bookmaker}-${outcome}`,
    capturedAt: capturedAt.toISOString(),
    provider: "public-web",
    bookmaker,
    fixtureId: fixtureRecord.id,
    fixtureDate: fixtureRecord.date,
    homeTeam: fixtureRecord.homeTeam,
    awayTeam: fixtureRecord.awayTeam,
    market: "asian_handicap",
    outcome,
    line,
    team: outcome.startsWith(fixtureRecord.homeTeam) ? fixtureRecord.homeTeam : fixtureRecord.awayTeam,
    decimalOdds,
    dataOnly: true
  };
}
