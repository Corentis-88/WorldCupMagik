import test from "node:test";
import assert from "node:assert/strict";
import { fetchHeatSnapshotsWithDiagnostics, parseWeatherForecastSummaries } from "../src/providers/weather-provider.mjs";

test("parses public weather forecast summary windows", () => {
  const html = `
    <h2>Mexico City Weather Today (1&ndash;3 days)</h2>
    <p>Heavy rain (total 12mm). Warm (max 31&deg;C on Tue afternoon, min 21&deg;C on Sun morning). Wind will be light.</p>
    <h2>Mexico City Weather (4&ndash;7 days)</h2>
    <p>Mostly dry. Warm (max 29&deg;C on Thu afternoon, min 20&deg;C on Fri night). Wind will be light.</p>
  `;
  const summaries = parseWeatherForecastSummaries(html);

  assert.equal(summaries.length, 2);
  assert.deepEqual(summaries[0], {
    fromDay: 1,
    toDay: 3,
    summary: "Heavy rain (total 12mm). Warm (max 31degC on Tue afternoon, min 21degC on Sun morning). Wind will be light.",
    maxTempC: 31,
    minTempC: 21,
    rainfallMm: 12,
    humidityPct: 78,
    condition: "heavy_rain"
  });
});

test("builds heat snapshots from configured public weather source pages", async () => {
  const now = new Date("2026-06-07T12:00:00.000Z");
  const fixtures = [{
    id: "fixture_test_heat",
    date: "2026-06-11T19:00:00.000Z",
    homeTeam: "Mexico",
    awayTeam: "South Africa",
    venue: "Estadio Azteca, Mexico City",
    sourceType: "public-web"
  }];
  const providerConfig = {
    mode: "self-gather",
    sources: [{
      key: "mexico_city",
      name: "Mexico City test forecast",
      location: "Mexico City",
      url: "https://example.test/mexico-city",
      aliases: ["estadio azteca", "mexico city"],
      utcOffsetHours: -6,
      roofFactor: 1,
      reliability: 0.66
    }]
  };
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => ({
    ok: true,
    text: async () => `
      <h2>Mexico City Weather (4&ndash;7 days)</h2>
      <p>Heavy rain (total 7mm). Warm (max 33&deg;C on Thu afternoon, min 22&deg;C on Thu night). Wind will be light.</p>
    `
  });

  try {
    const result = await fetchHeatSnapshotsWithDiagnostics({ fixtures, providerConfig, now });

    assert.equal(result.records.length, 1);
    assert.equal(result.diagnostics[0].status, "ok");
    assert.equal(result.records[0].location, "Mexico City");
    assert.ok(result.records[0].heatStress > 0);
    assert.ok(Math.abs(result.records[0].resultEdgeAdjustment) < 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
