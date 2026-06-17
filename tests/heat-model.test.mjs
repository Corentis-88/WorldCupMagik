import test from "node:test";
import assert from "node:assert/strict";
import { buildHeatImpact, climateBandForWeather } from "../src/heat-model.mjs";
import fixtures from "../data/fixtures.json" with { type: "json" };
import climateHistory from "../config/world-cup-climate-history.json" with { type: "json" };
import { normalizeName } from "../src/utils.mjs";

test("heat model includes climate history and squad depth while staying capped", () => {
  const fixture = {
    id: "ksa-nor-heat",
    date: "2026-06-18T20:00:00.000Z",
    homeTeam: "Saudi Arabia",
    awayTeam: "Norway",
    venue: "Hard Rock Stadium, Miami"
  };
  const impact = buildHeatImpact({
    fixture,
    heatRecord: {
      fixtureId: fixture.id,
      capturedAt: "2026-06-07T09:00:00.000Z",
      source: "Test heat source",
      location: "Houston",
      temperatureC: 35,
      humidityPct: 76,
      heatIndexC: 49,
      heatStress: 1,
      confidence: 0.72
    },
    homeSquadDepth: {
      team: "Saudi Arabia",
      depthScore: 0.52,
      confidence: 0.5
    },
    awaySquadDepth: {
      team: "Norway",
      depthScore: 0.6,
      confidence: 0.5
    }
  });

  assert.equal(impact.climateBand, "hotHumid");
  assert.ok(impact.resultEdgeAdjustment > 0);
  assert.ok(Math.abs(impact.resultEdgeAdjustment) <= 28);
  assert.ok(impact.expectedGoalsAdjustment >= -0.15);
  assert.ok(Number.isFinite(impact.homeHistoricalHeatMemory));
  assert.ok(Number.isFinite(impact.homeSquadDepth));
  assert.ok(impact.combinedHeatDifferential > 0);
});

test("squad depth cushions but never reverses heat goal drag", () => {
  const fixture = {
    id: "bra-fra-heat",
    date: "2026-06-20T20:00:00.000Z",
    homeTeam: "Brazil",
    awayTeam: "France",
    venue: "Hard Rock Stadium, Miami"
  };
  const heatRecord = {
    fixtureId: fixture.id,
    capturedAt: "2026-06-07T09:00:00.000Z",
    source: "Test heat source",
    location: "Miami",
    temperatureC: 33,
    humidityPct: 78,
    heatIndexC: 44,
    heatStress: 0.92,
    confidence: 0.7
  };
  const shallow = buildHeatImpact({
    fixture,
    heatRecord,
    homeSquadDepth: { team: "Brazil", depthScore: 0.38, confidence: 0.62 },
    awaySquadDepth: { team: "France", depthScore: 0.38, confidence: 0.62 }
  });
  const deep = buildHeatImpact({
    fixture,
    heatRecord,
    homeSquadDepth: { team: "Brazil", depthScore: 0.9, confidence: 0.7 },
    awaySquadDepth: { team: "France", depthScore: 0.88, confidence: 0.7 }
  });

  assert.ok(deep.expectedGoalsAdjustment > shallow.expectedGoalsAdjustment);
  assert.ok(deep.expectedGoalsAdjustment <= 0);
  assert.ok(deep.bttsAdjustment <= 0);
});

test("Mexico City heat is treated as altitude heat", () => {
  assert.equal(climateBandForWeather({
    location: "Mexico City",
    venue: "Estadio Azteca",
    temperatureC: 27,
    heatIndexC: 27,
    humidityPct: 52
  }), "altitude");
});

test("host-climate fallback activates Miami heat before a live forecast exists", () => {
  const fixture = {
    id: "sco-bra-miami",
    date: "2026-06-24T22:00:00.000Z",
    homeTeam: "Scotland",
    awayTeam: "Brazil",
    venue: "Hard Rock Stadium, Miami"
  };
  const impact = buildHeatImpact({
    fixture,
    homeSquadDepth: { team: "Scotland", depthScore: 0.54, confidence: 0.44 },
    awaySquadDepth: { team: "Brazil", depthScore: 0.9, confidence: 0.7 }
  });

  assert.equal(impact.climateBand, "hotHumid");
  assert.ok(impact.heatStress > 0);
  assert.ok(impact.confidence > 0);
  assert.ok(impact.awayClimateAdaptation > impact.homeClimateAdaptation);
  assert.ok(impact.combinedHeatDifferential < 0);
  assert.ok(impact.resultEdgeAdjustment < 0);
  assert.match(impact.notes, /host-climate baseline/);
});

test("climate-controlled stadiums neutralize outdoor heat drag", () => {
  const fixture = {
    id: "eng-cro-dallas",
    date: "2026-06-17T20:00:00.000Z",
    homeTeam: "England",
    awayTeam: "Croatia",
    venue: "AT&T Stadium, Dallas"
  };
  const impact = buildHeatImpact({
    fixture,
    heatRecord: {
      fixtureId: fixture.id,
      source: "Dallas weather forecast",
      location: "Dallas",
      venue: fixture.venue,
      temperatureC: 35,
      humidityPct: 64,
      heatIndexC: 43,
      heatStress: 0.9,
      confidence: 0.7,
      climateControlled: true
    }
  });

  assert.equal(impact.climateBand, "climateControlled");
  assert.equal(impact.heatStress, 0);
  assert.equal(impact.expectedGoalsAdjustment, 0);
  assert.equal(impact.resultEdgeAdjustment, 0);
  assert.match(impact.notes, /outdoor heat is not applied/);
});

test("host-climate fallback does not create Dallas heat for AT&T Stadium", () => {
  const fixture = {
    id: "eng-cro-dallas-fallback",
    date: "2026-06-17T20:00:00.000Z",
    homeTeam: "England",
    awayTeam: "Croatia",
    venue: "AT&T Stadium, Dallas"
  };
  const impact = buildHeatImpact({ fixture });

  assert.equal(impact.climateBand, "climateControlled");
  assert.equal(impact.heatStress, 0);
  assert.equal(impact.expectedGoalsAdjustment, 0);
});

test("historical climate memory covers every fixture team", () => {
  const fixtureTeams = [...new Set(fixtures.flatMap((item) => [item.homeTeam, item.awayTeam]).filter(Boolean))];
  const memoryTeams = new Set(Object.keys(climateHistory.teamMemory || {}).map(normalizeName));
  const missing = fixtureTeams.filter((team) => !memoryTeams.has(normalizeName(team)));

  assert.deepEqual(missing, []);
});
