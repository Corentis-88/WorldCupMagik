import test from "node:test";
import assert from "node:assert/strict";
import { fetchOddsSnapshot } from "../src/providers/odds-provider.mjs";

test("public-web odds parser maps match winner, totals, and BTTS offers", async () => {
  const originalFetch = globalThis.fetch;
  const html = `
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "SportsEvent",
        "name": "Mexico v South Africa",
        "startDate": "2026-06-11T19:00:00.000Z",
        "homeTeam": { "@type": "SportsTeam", "name": "Mexico", "alternateName": "MEX" },
        "awayTeam": { "@type": "SportsTeam", "name": "South Africa", "alternateName": "RSA" },
        "offers": [
          { "@type": "Offer", "name": "Mexico or Draw double chance - Mexico v South Africa at Coral", "price": "1.14", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "Over 1.5 - Mexico v South Africa at Coral", "price": "1.32", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "Under 3.5 - Mexico v South Africa at Coral", "price": "1.28", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "Under 4.5 - Mexico v South Africa at Coral", "price": "1.10", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "RSA — Mexico v South Africa at Coral", "price": "6.00", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "Draw — Mexico v South Africa at Coral", "price": "4.20", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "MEX — Mexico v South Africa at Coral", "price": "1.53", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "Over 2.5 — Mexico v South Africa at Coral", "price": "1.91", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "Under 2.5 — Mexico v South Africa at Coral", "price": "1.80", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "Yes — Mexico v South Africa at Coral", "price": "2.10", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "No — Mexico v South Africa at Coral", "price": "1.67", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "Raul Jimenez anytime scorer - Mexico v South Africa at Coral", "price": "2.75", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "Raul Jimenez first goalscorer - Mexico v South Africa at Coral", "price": "5.00", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "Luis Chavez anytime assist - Mexico v South Africa at Coral", "price": "3.40", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "Luis Chavez 1+ shots on target - Mexico v South Africa at Coral", "price": "2.20", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "Edson Alvarez to be carded - Mexico v South Africa at Coral", "price": "3.10", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "Penalty awarded Yes - Mexico v South Africa at Coral", "price": "3.50", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "Red card in match No - Mexico v South Africa at Coral", "price": "1.18", "offeredBy": { "name": "Coral" } }
        ]
      }
    </script>
  `;

  globalThis.fetch = async () => ({
    ok: true,
    text: async () => html
  });

  try {
    const records = await fetchOddsSnapshot({
      fixtures: [
        {
          id: "mex-rsa",
          date: "2026-06-11T19:00:00.000Z",
          homeTeam: "Mexico",
          awayTeam: "South Africa",
          sourceUrl: "https://worldcup.onlyodds.co.uk/match/mexico-v-south-africa"
        }
      ],
      providerConfig: {
        mode: "self-gather",
        sources: [{ name: "OnlyOdds test", fixtureUrlFromFixtures: true }]
      },
      now: new Date("2026-06-07T10:00:00.000Z")
    });

    assert.deepEqual(records.map((record) => `${record.market}:${record.outcome}`).sort(), [
      "anytime_assist:Luis Chavez",
      "anytime_scorer:Raul Jimenez",
      "both_teams_to_score:No",
      "both_teams_to_score:Yes",
      "double_chance:Mexico or Draw",
      "first_goalscorer:Raul Jimenez",
      "match_winner:Draw",
      "match_winner:Mexico",
      "match_winner:South Africa",
      "over_1_5_goals:Over",
      "over_2_5_goals:Over",
      "penalty_awarded:Yes",
      "player_card:Edson Alvarez",
      "player_shot_on_target:Luis Chavez",
      "red_card:No",
      "under_2_5_goals:Under",
      "under_3_5_goals:Under",
      "under_4_5_goals:Under"
    ]);
    assert.equal(records.find((record) => record.market === "anytime_scorer")?.playerName, "Raul Jimenez");
    assert.equal(records.find((record) => record.market === "first_goalscorer")?.decimalOdds, 5);
    assert.equal(records.find((record) => record.market === "anytime_assist")?.decimalOdds, 3.4);
    assert.equal(records.find((record) => record.market === "player_shot_on_target")?.line, "0.5");
    assert.equal(records.find((record) => record.market === "player_card")?.dataOnly, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public-web odds parser extracts scorer prop tables and American prices", async () => {
  const originalFetch = globalThis.fetch;
  const html = `
    <main>
      <h1>Mexico vs South Africa prediction, lineups and odds</h1>
      <p>Player Prop Picks</p>
      <p>Latest Santiago Gimenez Player Prop Odds Goalscorer Anytime +150 First 4.50 Shots Over 2.5 1.83</p>
      <p>Latest Santiago Gimenez Player Prop Odds Shots On Target 1.91</p>
      <p>Latest Luis Chavez Player Prop Odds Anytime Assist +180 Crosses Over 2.5 1.83</p>
      <p>Edson Alvarez to be carded 3.30</p>
      <p>Penalty awarded Yes 3.60 No 1.25</p>
      <p>Red card in match Yes 5.50 No 1.12</p>
      <p>Player Goals Raul Jimenez (Mexico) First 4.20 Anytime 2.30 Lyle Foster (South Africa) First 9.00 Anytime 4.50</p>
      <p>Luis Chavez (Mexico) anytime assist 2.80</p>
    </main>
  `;

  globalThis.fetch = async () => ({
    ok: true,
    text: async () => html
  });

  try {
    const records = await fetchOddsSnapshot({
      fixtures: [
        {
          id: "mex-rsa",
          date: "2026-06-11T19:00:00.000Z",
          homeTeam: "Mexico",
          awayTeam: "South Africa"
        }
      ],
      providerConfig: {
        mode: "self-gather",
        sources: [{
          name: "Prop article test",
          fixtureUrlFromFixtures: true,
          fullPageFixtureBlock: true,
          urlTemplate: "https://example.test/{homeSlug}-vs-{awaySlug}-prediction-lineups-odds-{dateKey}/"
        }]
      },
      now: new Date("2026-06-11T10:00:00.000Z")
    });
    const byKey = new Map(records.map((record) => [`${record.market}:${record.outcome}`, record]));

    assert.equal(byKey.get("anytime_scorer:Santiago Gimenez")?.decimalOdds, 2.5);
    assert.equal(byKey.get("first_goalscorer:Santiago Gimenez")?.decimalOdds, 4.5);
    assert.equal(byKey.get("first_goalscorer:Raul Jimenez")?.playerTeam, "Mexico");
    assert.equal(byKey.get("anytime_scorer:Lyle Foster")?.playerTeam, "South Africa");
    assert.equal(byKey.get("anytime_assist:Luis Chavez")?.decimalOdds, 2.8);
    assert.equal(byKey.get("player_shot_on_target:Santiago Gimenez")?.decimalOdds, 1.91);
    assert.equal(byKey.get("player_card:Edson Alvarez")?.decimalOdds, 3.3);
    assert.equal(byKey.get("penalty_awarded:Yes")?.decimalOdds, 3.6);
    assert.equal(byKey.get("red_card:No")?.decimalOdds, 1.12);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public-web odds parser stores survivability markets as collect-only line records", async () => {
  const originalFetch = globalThis.fetch;
  const html = `
    <main>
      <h1>Mexico v South Africa betting odds</h1>
      <section>
        <h2>Asian Handicap</h2>
        Mexico -0.75 1.92 South Africa +0.75 1.88
      </section>
      <section>
        <h2>Asian Total Goals</h2>
        Over 2.25 1.94 Under 2.25 1.86
      </section>
      <section>
        <h2>3-Way Handicap</h2>
        Mexico -1 Mexico 2.23 Draw 3.05 South Africa 2.88
      </section>
      <section>
        <h2>Team Total Goals</h2>
        Mexico Over 1.5 1.72 Under 1.5 2.05
        South Africa Over 0.5 1.61 Under 0.5 2.20
      </section>
      <section>
        <h2>Team to Score</h2>
        Mexico Yes 1.18 No 4.80
        South Africa to score Yes 1.95 No 1.82
      </section>
      <section>
        <h2>To Qualify</h2>
        Mexico to qualify 1.33 South Africa to qualify 3.25
      </section>
    </main>
  `;

  globalThis.fetch = async () => ({
    ok: true,
    text: async () => html
  });

  try {
    const records = await fetchOddsSnapshot({
      fixtures: [
        {
          id: "mex-rsa",
          date: "2026-06-11T19:00:00.000Z",
          homeTeam: "Mexico",
          awayTeam: "South Africa"
        }
      ],
      providerConfig: {
        mode: "self-gather",
        sources: [{
          name: "Survival markets test",
          bookmaker: "ExampleBook",
          fixtureUrlFromFixtures: true,
          fullPageFixtureBlock: true,
          urlTemplate: "https://example.test/{homeSlug}-v-{awaySlug}"
        }]
      },
      now: new Date("2026-06-11T10:00:00.000Z")
    });
    const byKey = new Map(records.map((record) => [`${record.market}:${record.outcome}`, record]));

    assert.equal(byKey.get("asian_handicap:Mexico -0.75")?.line, "-0.75");
    assert.equal(byKey.get("asian_handicap:South Africa +0.75")?.team, "South Africa");
    assert.equal(byKey.get("asian_total_goals:Over 2.25")?.decimalOdds, 1.94);
    assert.equal(byKey.get("asian_total_goals:Under 2.25")?.settlementType, "asian_total_goals");
    assert.equal(byKey.get("three_way_handicap:Draw (Mexico -1)")?.decimalOdds, 3.05);
    assert.equal(byKey.get("team_total_goals:Mexico Over 1.5")?.team, "Mexico");
    assert.equal(byKey.get("team_to_score:South Africa to score: No")?.decimalOdds, 1.82);
    assert.equal(byKey.get("to_qualify:Mexico to qualify")?.dataOnly, true);
    assert.ok(records.filter((record) => record.dataOnly).length >= 10);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
