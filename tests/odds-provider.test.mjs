import test from "node:test";
import assert from "node:assert/strict";
import { fetchOddsSnapshot, fetchOddsSnapshotWithDiagnostics } from "../src/providers/odds-provider.mjs";

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
          { "@type": "Offer", "name": "Luis Chavez 1+ shots - Mexico v South Africa at Coral", "price": "1.45", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "Luis Chavez 1+ shots on target - Mexico v South Africa at Coral", "price": "2.20", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "Guillermo Ochoa goalkeeper saves over 2.5 - Mexico v South Africa at Coral", "price": "1.90", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "Mexico team shots over 9.5 - Mexico v South Africa at Coral", "price": "1.80", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "South Africa team shots on target over 2.5 - Mexico v South Africa at Coral", "price": "2.00", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "Total corners over 8.5 - Mexico v South Africa at Coral", "price": "1.95", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "Mexico team corners over 4.5 - Mexico v South Africa at Coral", "price": "2.10", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "Total cards over 3.5 - Mexico v South Africa at Coral", "price": "1.85", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "South Africa team cards over 1.5 - Mexico v South Africa at Coral", "price": "1.66", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "Mexico clean sheet Yes - Mexico v South Africa at Coral", "price": "2.20", "offeredBy": { "name": "Coral" } },
          { "@type": "Offer", "name": "Mexico win to nil Yes - Mexico v South Africa at Coral", "price": "3.10", "offeredBy": { "name": "Coral" } },
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
      "clean_sheet:Mexico clean sheet: Yes",
      "double_chance:Mexico or Draw",
      "first_goalscorer:Raul Jimenez",
      "goalkeeper_saves:Guillermo Ochoa",
      "match_winner:Draw",
      "match_winner:Mexico",
      "match_winner:South Africa",
      "over_1_5_goals:Over",
      "over_2_5_goals:Over",
      "penalty_awarded:Yes",
      "player_card:Edson Alvarez",
      "player_shot:Luis Chavez",
      "player_shot_on_target:Luis Chavez",
      "red_card:No",
      "team_cards:South Africa Over 1.5",
      "team_corners:Mexico Over 4.5",
      "team_shots:Mexico Over 9.5",
      "team_shots_on_target:South Africa Over 2.5",
      "total_cards:Over 3.5",
      "total_corners:Over 8.5",
      "under_2_5_goals:Under",
      "under_3_5_goals:Under",
      "under_4_5_goals:Under",
      "win_to_nil:Mexico win to nil: Yes"
    ]);
    assert.equal(records.find((record) => record.market === "anytime_scorer")?.playerName, "Raul Jimenez");
    assert.equal(records.find((record) => record.market === "first_goalscorer")?.decimalOdds, 5);
    assert.equal(records.find((record) => record.market === "anytime_assist")?.decimalOdds, 3.4);
    assert.equal(records.find((record) => record.market === "player_shot")?.line, "0.5");
    assert.equal(records.find((record) => record.market === "player_shot_on_target")?.line, "0.5");
    assert.equal(records.find((record) => record.market === "goalkeeper_saves")?.line, "2.5");
    assert.equal(records.find((record) => record.market === "team_corners")?.team, "Mexico");
    assert.equal(records.find((record) => record.market === "clean_sheet")?.dataOnly, true);
    assert.equal(records.find((record) => record.market === "player_card")?.dataOnly, true);
    assert.equal(records[0].pricePublisher, "OnlyOdds test");
    assert.equal(records[0].publisherType, "publisher-or-comparison");
    assert.equal(records[0].bookmaker, "Coral");
    assert.equal(records[0].bookmakerKey, "coral");
    assert.equal(records[0].bookmakerVerified, false);
    assert.equal(records[0].priceProvenance, "publisher-attributed-bookmaker");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public-web odds parser respects reversed Under/Over table columns", async () => {
  const originalFetch = globalThis.fetch;
  const html = `
    <main>
      <h1>Mexico v South Africa odds</h1>
      <h2>Total Goals</h2>
      <table>
        <tr><th>Goals</th><th>Under</th><th>Over</th></tr>
        <tr><td>1.5</td><td>3.10</td><td>1.30</td></tr>
        <tr><td>2.5</td><td>2.00</td><td>1.90</td></tr>
        <tr><td>3.5</td><td>1.40</td><td>2.80</td></tr>
        <tr><td>4.5</td><td>1.15</td><td>5.00</td></tr>
      </table>
    </main>
  `;

  globalThis.fetch = async () => ({ ok: true, text: async () => html });

  try {
    const result = await fetchOddsSnapshotWithDiagnostics({
      fixtures: [{
        id: "mex-rsa",
        date: "2026-06-11T19:00:00.000Z",
        homeTeam: "Mexico",
        awayTeam: "South Africa"
      }],
      providerConfig: {
        mode: "self-gather",
        sources: [{
          name: "Comparison publisher",
          fixtureUrlFromFixtures: true,
          fullPageFixtureBlock: true,
          urlTemplate: "https://example.test/{homeSlug}-v-{awaySlug}"
        }]
      },
      now: new Date("2026-06-11T10:00:00.000Z")
    });
    const byMarket = new Map(result.records.map((record) => [record.market, record]));

    assert.equal(byMarket.get("over_1_5_goals")?.decimalOdds, 1.3);
    assert.equal(byMarket.get("over_2_5_goals")?.decimalOdds, 1.9);
    assert.equal(byMarket.get("under_2_5_goals")?.decimalOdds, 2);
    assert.equal(byMarket.get("under_3_5_goals")?.decimalOdds, 1.4);
    assert.equal(byMarket.get("under_4_5_goals")?.decimalOdds, 1.15);
    assert.equal(byMarket.get("over_1_5_goals")?.bookmaker, null);
    assert.equal(byMarket.get("over_1_5_goals")?.bookmakerKey, null);
    assert.equal(byMarket.get("over_1_5_goals")?.priceProvenance, "publisher-only");
    assert.equal(result.diagnostics.at(-1).quarantinedRecords, 0);
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
      <p>Guillermo Ochoa goalkeeper saves over 2.5 1.90</p>
      <section><h2>Team Shots</h2>Mexico Over 9.5 Shots 1.80 Under 9.5 Shots 1.95 South Africa Over 7.5 Shots 2.05 Under 7.5 Shots 1.72</section>
      <section><h2>Team Shots On Target</h2>Mexico Over 3.5 Shots On Target 1.88 Under 3.5 Shots On Target 1.90</section>
      <section><h2>Total Corners</h2>Over 8.5 Corners 1.92 Under 8.5 Corners 1.88</section>
      <section><h2>Team Corners</h2>Mexico Over 4.5 Corners 2.10 Under 4.5 Corners 1.67</section>
      <section><h2>Total Cards</h2>Over 3.5 Cards 1.85 Under 3.5 Cards 1.95</section>
      <section><h2>Team Cards</h2>South Africa Over 1.5 Cards 1.66 Under 1.5 Cards 2.10</section>
      <section><h2>Clean Sheet</h2>Mexico clean sheet Yes 2.20 No 1.62</section>
      <section><h2>Win To Nil</h2>Mexico win to nil Yes 3.10 No 1.30</section>
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
    assert.equal(byKey.get("player_shot:Santiago Gimenez")?.line, "2.5");
    assert.equal(byKey.get("player_shot_on_target:Santiago Gimenez")?.decimalOdds, 1.91);
    assert.equal(byKey.get("goalkeeper_saves:Guillermo Ochoa")?.line, "2.5");
    assert.equal(byKey.get("team_shots:Mexico Over 9.5")?.decimalOdds, 1.8);
    assert.equal(byKey.get("team_shots_on_target:Mexico Over 3.5")?.decimalOdds, 1.88);
    assert.equal(byKey.get("total_corners:Over 8.5")?.decimalOdds, 1.92);
    assert.equal(byKey.get("team_corners:Mexico Over 4.5")?.decimalOdds, 2.1);
    assert.equal(byKey.get("total_cards:Over 3.5")?.decimalOdds, 1.85);
    assert.equal(byKey.get("team_cards:South Africa Over 1.5")?.decimalOdds, 1.66);
    assert.equal(byKey.get("clean_sheet:Mexico clean sheet: Yes")?.decimalOdds, 2.2);
    assert.equal(byKey.get("win_to_nil:Mexico win to nil: Yes")?.decimalOdds, 3.1);
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
