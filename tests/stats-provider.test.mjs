import test from "node:test";
import assert from "node:assert/strict";
import { fetchTeamStatsWithDiagnostics } from "../src/providers/stats-provider.mjs";

test("stats provider parses indexed public result tables with scorer cells", async () => {
  const rows = Array.from({ length: 20 }, (_item, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${String(index + 1).padStart(2, "0")} May 2026</td>
      <td>Test Stadium (N)</td>
      <td>Opponent ${index}</td>
      <td>${index % 3 === 0 ? "3-1" : "2-0"}</td>
      <td>Friendly</td>
      <td>Alpha Striker${index % 3 === 0 ? " (2), Beta Runner" : ", Beta Runner"}</td>
      <td>1,000</td>
      <td>Ref</td>
    </tr>
  `).join("");
  const html = `<table>
    <tr><th>No.</th><th>Date</th><th>Venue</th><th>Opponents</th><th>Score</th><th>Competition</th><th>Sampleland scorers</th><th>Att.</th><th>Ref.</th></tr>
    ${rows}
  </table>`;
  const result = await fetchTeamStatsWithDiagnostics({
    providerConfig: {
      mode: "self-gather",
      sourceTemplates: [dataUrl(html)],
      profileSourceTemplates: [],
      targetRecentMatches: 20,
      maxRecentMatches: 20
    },
    fixtures: [{ homeTeam: "Sampleland", awayTeam: "Otherland" }],
    now: new Date("2026-06-09T10:00:00.000Z")
  });
  const sampleland = result.records.find((team) => team.team === "Sampleland");

  assert.equal(sampleland.sourceMatchCount, 20);
  assert.equal(sampleland.topScorers[0].playerName, "Alpha Striker");
  assert.ok(sampleland.topScorers[0].goals > sampleland.topScorers[1].goals);
});

test("stats provider can use National Football Teams style public tables as a fallback", async () => {
  const matches = Array.from({ length: 20 }, (_item, index) => `
    <tr>
      <td>2026-05-${String(index + 1).padStart(2, "0")}</td>
      <td>Fallback FC</td>
      <td>Opponent ${index}</td>
      <td>${index % 2 ? "1:1 c Fallback FC vs. Opponent" : "2:0 c Fallback FC vs. Opponent"}</td>
      <td>Friendly</td>
      <td>Fallback Stadium</td>
      <td></td>
    </tr>
  `).join("");
  const html = `
    <table>
      <tr><th>FIFA</th><th>Non FIFA</th></tr>
      <tr><th>Name</th><th>Day of Birth</th><th>Position</th><th>Current Club</th><th>M</th><th>S</th><th>G</th><th>M</th><th>S</th><th>G</th></tr>
      <tr><td>Nazon, Duckens</td><td>1994-04-07</td><td>Forward</td><td>Club</td><td>12</td><td>0</td><td>7</td><td>0</td><td>0</td><td>0</td></tr>
      <tr><td>Pierrot, Frantzdy</td><td>1995-03-29</td><td>Forward</td><td>Club</td><td>10</td><td>0</td><td>5</td><td>0</td><td>0</td><td>0</td></tr>
    </table>
    <table>
      <tr><th>Date</th><th>Home Team</th><th>Away Team</th><th>Result</th><th>Event</th><th>Stadium</th><th>FIFA</th></tr>
      ${matches}
    </table>
  `;
  const result = await fetchTeamStatsWithDiagnostics({
    providerConfig: {
      mode: "self-gather",
      sourceTemplates: [],
      profileSourceTemplates: [],
      nationalFootballTeams: {
        "Fallback FC": {
          urls: [dataUrl(html)]
        }
      },
      targetRecentMatches: 20,
      maxRecentMatches: 20
    },
    fixtures: [{ homeTeam: "Fallback FC", awayTeam: "Otherland" }],
    now: new Date("2026-06-09T10:00:00.000Z")
  });
  const fallback = result.records.find((team) => team.team === "Fallback FC");
  const scorer = result.playerStats.find((player) => player.team === "Fallback FC" && player.playerName === "Duckens Nazon");

  assert.equal(fallback.sourceMatchCount, 20);
  assert.equal(fallback.topScorers[0].playerName, "Duckens Nazon");
  assert.equal(scorer.goalsPerTwentyTeamMatches, 7);
});

test("stats provider rejects impossible score rows before aggregation", async () => {
  const corruptRow = `
    <tr>
      <td>1</td>
      <td>01 Jun 2026</td>
      <td>Test Stadium (N)</td>
      <td>Opponent corrupt</td>
      <td>100000000000000-0</td>
      <td>Friendly</td>
      <td>Alpha Striker</td>
      <td>1,000</td>
      <td>Ref</td>
    </tr>
  `;
  const rows = Array.from({ length: 20 }, (_item, index) => `
    <tr>
      <td>${index + 2}</td>
      <td>${String(index + 1).padStart(2, "0")} May 2026</td>
      <td>Test Stadium (N)</td>
      <td>Opponent ${index}</td>
      <td>1-0</td>
      <td>Friendly</td>
      <td>Alpha Striker</td>
      <td>1,000</td>
      <td>Ref</td>
    </tr>
  `).join("");
  const html = `<table>
    <tr><th>No.</th><th>Date</th><th>Venue</th><th>Opponents</th><th>Score</th><th>Competition</th><th>Sampleland scorers</th><th>Att.</th><th>Ref.</th></tr>
    ${corruptRow}
    ${rows}
  </table>`;
  const result = await fetchTeamStatsWithDiagnostics({
    providerConfig: {
      mode: "self-gather",
      sourceTemplates: [dataUrl(html)],
      profileSourceTemplates: [],
      targetRecentMatches: 20,
      maxRecentMatches: 20
    },
    fixtures: [{ homeTeam: "Sampleland", awayTeam: "Otherland" }],
    now: new Date("2026-06-09T10:00:00.000Z")
  });
  const sampleland = result.records.find((team) => team.team === "Sampleland");

  assert.equal(sampleland.sourceMatchCount, 20);
  assert.equal(sampleland.longForm.goalsFor, 1);
  assert.ok(result.matchHistory.every((matchRow) => matchRow.homeGoals <= 15 && matchRow.awayGoals <= 15));
});

function dataUrl(html) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
