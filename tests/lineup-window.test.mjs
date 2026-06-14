import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LINEUP_MAX_MINUTES_BEFORE,
  DEFAULT_LINEUP_MIN_MINUTES_BEFORE,
  isInsideLineupWindow,
  lineupWindowFromEnv,
  minutesUntilKickoff
} from "../src/lineup-window.mjs";

test("lineup window includes delayed scheduled checks close to kickoff", () => {
  const fixture = {
    date: "2026-06-12T19:00:00.000Z",
    homeTeam: "Canada",
    awayTeam: "Bosnia and Herzegovina"
  };
  const fortyFiveMinuteRun = new Date("2026-06-12T18:15:00.000Z");
  const thirtyMinuteRun = new Date("2026-06-12T18:30:00.000Z");
  const delayedRun = new Date("2026-06-12T18:32:00.000Z");

  assert.equal(Math.round(minutesUntilKickoff(fixture, fortyFiveMinuteRun)), 45);
  assert.equal(isInsideLineupWindow(fixture, fortyFiveMinuteRun), true);
  assert.equal(Math.round(minutesUntilKickoff(fixture, thirtyMinuteRun)), 30);
  assert.equal(isInsideLineupWindow(fixture, thirtyMinuteRun), true);
  assert.equal(Math.round(minutesUntilKickoff(fixture, delayedRun)), 28);
  assert.equal(isInsideLineupWindow(fixture, delayedRun), true);
});

test("lineup window defaults cover pre-match and just-after-kickoff checks", () => {
  const window = lineupWindowFromEnv({});

  assert.equal(window.minMinutesBefore, DEFAULT_LINEUP_MIN_MINUTES_BEFORE);
  assert.equal(window.maxMinutesBefore, DEFAULT_LINEUP_MAX_MINUTES_BEFORE);
  assert.equal(isInsideLineupWindow({ date: "2026-06-12T19:00:00.000Z" }, new Date("2026-06-12T16:40:00.000Z"), window), false);
  assert.equal(isInsideLineupWindow({ date: "2026-06-12T19:00:00.000Z" }, new Date("2026-06-12T19:09:00.000Z"), window), true);
});
