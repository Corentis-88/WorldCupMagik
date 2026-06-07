import test from "node:test";
import assert from "node:assert/strict";
import { fetchSquadDepthWithDiagnostics } from "../src/providers/squad-provider.mjs";

test("squad provider blends public squad signals with conservative priors", async () => {
  const now = new Date("2026-06-07T12:00:00.000Z");
  const fixtures = [{
    id: "mex-hai",
    date: "2026-06-13T19:00:00.000Z",
    homeTeam: "Mexico",
    awayTeam: "Haiti",
    sourceType: "public-web"
  }];
  const providerConfig = {
    mode: "self-gather",
    requestTimeoutMs: 1000,
    teamPageConcurrency: 2,
    sources: [{
      key: "test_team_pages",
      name: "Test national team pages",
      type: "team-template",
      urlTemplate: "https://example.test/{teamSlug}",
      reliability: 0.62,
      teamSlugs: {
        Mexico: "mexico",
        Haiti: "haiti"
      }
    }]
  };
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url) => ({
    ok: true,
    text: async () => String(url).includes("mexico")
      ? `
        <h2>Current squad</h2>
        <table>
          <tr><th>Pos</th><th>Player</th><th>Club</th></tr>
          <tr><td>GK</td><td>One Keeper</td><td>Club America</td></tr>
          <tr><td>DF</td><td>Two Defender</td><td>Ajax</td></tr>
          <tr><td>MF</td><td>Three Midfielder</td><td>Arsenal</td></tr>
          <tr><td>FW</td><td>Four Forward</td><td>Manchester City</td></tr>
        </table>
      `
      : `<h2>History</h2><p>No usable squad table here.</p>`
  });

  try {
    const result = await fetchSquadDepthWithDiagnostics({ fixtures, providerConfig, now });
    const mexico = result.records.find((record) => record.team === "Mexico");
    const haiti = result.records.find((record) => record.team === "Haiti");

    assert.equal(result.records.length, 2);
    assert.equal(mexico.sourceType, "curated-plus-public");
    assert.equal(haiti.sourceType, "curated-profile");
    assert.ok(mexico.playerCount >= 4);
    assert.ok(mexico.publicDepth);
    assert.ok(mexico.depthScore > 0);
    assert.ok(result.diagnostics.some((item) => item.kind === "squad_depth" && item.status === "ok"));
    assert.ok(result.diagnostics.some((item) => item.kind === "squad_depth" && item.status === "empty"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
