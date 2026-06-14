import test from "node:test";
import assert from "node:assert/strict";
import { fetchFixturesWithDiagnostics } from "../src/providers/fixtures-provider.mjs";

test("fixture provider prefers nearby venue-specific public rows over generic World Cup rows", async () => {
  const generic = matchRow({
    date: "2026-06-20T01:00:00.000Z",
    homeTeam: "Brazil",
    awayTeam: "Haiti",
    stage: "group",
    venue: "FIFA World Cup 2026"
  });
  const venueSpecific = matchRow({
    date: "2026-06-20T00:30:00.000Z",
    homeTeam: "Brazil",
    awayTeam: "Haiti",
    stage: "Group C",
    venue: "Lincoln Financial Field, Philadelphia"
  });
  const result = await fetchFixturesWithDiagnostics({
    providerConfig: {
      mode: "self-gather",
      sources: [
        {
          name: "Generic fixture feed",
          url: dataUrl(generic),
          reliability: 0.86
        },
        {
          name: "Venue fixture feed",
          url: dataUrl(venueSpecific),
          reliability: 0.9
        }
      ]
    },
    now: new Date("2026-06-14T09:00:00.000Z")
  });
  const brazilHaiti = result.records.filter((fixture) => fixture.homeTeam === "Brazil" && fixture.awayTeam === "Haiti");

  assert.equal(brazilHaiti.length, 1);
  assert.equal(brazilHaiti[0].venue, "Lincoln Financial Field, Philadelphia");
  assert.equal(brazilHaiti[0].source, "Venue fixture feed");
});

function matchRow({ date, homeTeam, awayTeam, stage, venue }) {
  return `
    <a class="match-row">
      <time datetime="${date}"></time>
      <span class="team-name">${homeTeam}</span>
      <span class="team-name">${awayTeam}</span>
      <span class="cell-stage">${stage}</span>
      <span class="venue-cell">${venue}</span>
    </a>
  `;
}

function dataUrl(html) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
