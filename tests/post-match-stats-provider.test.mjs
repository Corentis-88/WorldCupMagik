import assert from "node:assert/strict";
import test from "node:test";
import { extractFoxBoxscoreUrls, parseFoxBoxscorePage } from "../src/providers/post-match-stats-provider.mjs";

test("extractFoxBoxscoreUrls backfills recent FOX game ids around schedule links", () => {
  const urls = extractFoxBoxscoreUrls(
    '<a href="/soccer/fifa-world-cup-men-france-vs-morocco-jul-09-2026-game-boxscore-607927">France</a>',
    "https://www.foxsports.com/soccer/fifa-world-cup-men/schedule",
    { backfillGameIdLookback: 2, backfillGameIdLookahead: 1 }
  );

  assert.ok(urls.some((url) => url.endsWith("game-boxscore-607925")));
  assert.ok(urls.some((url) => url.endsWith("game-boxscore-607928")));
});

test("parseFoxBoxscorePage extracts event stats, scorers, and assists", () => {
  const html = `
    <html>
      <head><title>United States vs. Belgium - Final Score - July 06, 2026 | FOX Sports</title></head>
      <body>
        <script>
          "MATCH STATS",
          "POSSESSION (%)","57","43",
          "TOTAL SHOTS","6","15",
          "SHOTS ON GOAL","2","7",
          "EXPECTED GOALS (xG)","0.54","1.97",
          "PASSING ACCURACY (%)","89","83",
          "CORNERS","3","5",
          "FOULS","10","9"
        </script>
        <div class="keyplay-title fs-18">BEL GOAL</div>
        <div><span>USA 1</span><span>BEL 2</span></div>
        <span class="keystats-desc fs-13">33&#39; C. De Ketelaere scored a goal, assisted by L. Trossard.</span>
        <div class="keyplay-title fs-18">USA GOAL</div>
        <div><span>USA 1</span><span>BEL 1</span></div>
        <span class="keystats-desc fs-13">31&#39; M. Tillman scored a goal.</span>
        <div class="keyplay-title fs-18">USA YELLOW CARD</div>
        <div><span>USA 1</span><span>BEL 2</span></div>
        <span class="keystats-desc fs-13">44&#39; T. Adams is shown a yellow card.</span>
        <div class="keyplay-title fs-18">BEL RED CARD</div>
        <div><span>USA 1</span><span>BEL 2</span></div>
        <span class="keystats-desc fs-13">75&#39; A. Onana is shown a red card.</span>
        <div class="keyplay-title fs-18">BEL PENALTY</div>
        <div><span>USA 1</span><span>BEL 2</span></div>
        <span class="keystats-desc fs-13">81&#39; R. Lukaku scored a penalty.</span>
      </body>
    </html>
  `;
  const record = parseFoxBoxscorePage(html, {
    url: "https://www.foxsports.com/soccer/fifa-world-cup-men-placeholder-game-boxscore-607924",
    fixtures: [{
      id: "fixture_usa_belgium",
      date: "2026-07-06T20:00:00.000Z",
      homeTeam: "USA",
      awayTeam: "Belgium"
    }],
    now: new Date("2026-07-07T02:00:00.000Z")
  });

  assert.equal(record.fixtureId, "fixture_usa_belgium");
  assert.equal(record.homeTeam, "USA");
  assert.equal(record.awayTeam, "Belgium");
  assert.equal(record.homeXg, 0.54);
  assert.equal(record.awayShotsOnTarget, 7);
  assert.equal(record.homePassCompletion, 0.89);
  assert.equal(record.homeGoals, 1);
  assert.equal(record.awayGoals, 1);
  assert.deepEqual(record.awayScorers[0].assists, ["L. Trossard"]);
  assert.equal(record.homeYellowCards, 1);
  assert.equal(record.awayRedCards, 1);
  assert.deepEqual(record.homeCardedPlayers[0], { name: "T. Adams", minute: 44, card: "yellow" });
  assert.equal(record.penaltyAwarded, true);
  assert.equal(record.penaltyCount, 1);
  assert.equal(record.awayPenaltyCount, 1);
  assert.ok(record.capturedMetricFields.includes("xg"));
  assert.ok(record.capturedMetricFields.includes("assists"));
  assert.ok(record.capturedMetricFields.includes("cards"));
  assert.ok(record.capturedMetricFields.includes("penalties"));
});
