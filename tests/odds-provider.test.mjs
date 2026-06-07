import test from "node:test";
import assert from "node:assert/strict";
import { fetchOddsSnapshot } from "../src/providers/odds-provider.mjs";

test("The Odds API totals market keeps over and under outcomes separate", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ODDS_API_KEY;

  process.env.ODDS_API_KEY = "test-key";
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => [
      {
        home_team: "England",
        away_team: "Brazil",
        commence_time: "2026-06-06T19:00:00.000Z",
        bookmakers: [
          {
            key: "demo",
            title: "Demo Book",
            markets: [
              {
                key: "totals",
                outcomes: [
                  { name: "Over 2.5", price: 1.91 },
                  { name: "Under 2.5", price: 1.97 }
                ]
              }
            ]
          }
        ]
      }
    ]
  });

  try {
    const records = await fetchOddsSnapshot({
      fixtures: [
        {
          id: "eng-bra",
          date: "2026-06-06T19:00:00.000Z",
          homeTeam: "England",
          awayTeam: "Brazil"
        }
      ],
      providerConfig: {
        mode: "the-odds-api",
        sportKey: "soccer_fifa_world_cup",
        markets: ["totals"],
        regions: ["uk"]
      },
      now: new Date("2026-06-06T10:00:00.000Z")
    });

    assert.deepEqual(records.map((record) => `${record.market}:${record.outcome}`).sort(), [
      "over_2_5_goals:Over",
      "under_2_5_goals:Under"
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) {
      delete process.env.ODDS_API_KEY;
    } else {
      process.env.ODDS_API_KEY = originalKey;
    }
  }
});
