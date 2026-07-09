import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngineState, readJson } from "../src/db.mjs";
import { isInsideFinalLineupPass, isInsideLineupWindow, lineupFinalPassFromEnv, lineupWindowFromEnv, minutesUntilKickoff } from "../src/lineup-window.mjs";
import { fetchLineupSnapshotWithDiagnostics } from "../src/providers/lineup-provider.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outputPath = join(rootDir, "web", "data", "lineups-latest.json");
const now = new Date(process.env.LINEUP_NOW || Date.now());
const lineupWindow = lineupWindowFromEnv();
const finalPass = lineupFinalPassFromEnv();
const forceAllUpcoming = process.argv.includes("--all-upcoming");
const finalPrekickoffMode = process.argv.includes("--final-prekickoff");

const engineState = await loadEngineState();
const latestWebData = await readJson(["web", "data", "latest.json"], null).catch(() => null);
const fixtures = (latestWebData?.fixtures?.length ? latestWebData.fixtures : engineState.fixtures)
  .filter(isPublicFixture);
const targetFixtures = fixtures
  .filter((fixture) => {
    const minutes = minutesUntilKickoff(fixture, now);

    if (forceAllUpcoming) {
      return minutes >= -15 && minutes <= 24 * 60;
    }

    if (finalPrekickoffMode) {
      return isInsideFinalLineupPass(fixture, now, finalPass);
    }

    return isInsideLineupWindow(fixture, now, lineupWindow) || isInsideFinalLineupPass(fixture, now, finalPass);
  })
  .sort((left, right) => new Date(left.date) - new Date(right.date));
const existing = await readExistingLineups();
const providerConfig = engineState.providers.lineups || {
  mode: "self-gather",
  sourcesFile: "config/lineup-sources.json",
  requestTimeoutMs: 12000,
  userAgent: "WorldCupMagik/1.0 public-web lineup gatherer; no APIs"
};
const result = targetFixtures.length
  ? await fetchLineupSnapshotWithDiagnostics({ fixtures: targetFixtures, providerConfig, now })
  : { lineups: [], diagnostics: [] };
const lineups = mergeLineups(existing.lineups || [], result.lineups, now);
const payload = {
  generatedAt: now.toISOString(),
  edition: "github-pages-lineup-quick-check",
  source: "GitHub Actions lightweight public-web lineup scanner",
  targetWindow: {
    minMinutesBeforeKickoff: lineupWindow.minMinutesBefore,
    maxMinutesBeforeKickoff: lineupWindow.maxMinutesBefore,
    finalPassMinutesBeforeKickoff: finalPass.targetMinutesBefore,
    finalPassToleranceMinutes: finalPass.toleranceMinutes
  },
  finalPrekickoffMode,
  targetFixtureCount: targetFixtures.length,
  targetFixtures: targetFixtures.map((fixture) => ({
    id: fixture.id,
    date: fixture.date,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    minutesUntilKickoff: Math.round(minutesUntilKickoff(fixture, now))
  })),
  lineups,
  diagnostics: result.diagnostics
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`Wrote ${outputPath}`);
console.log(`Lineup targets: ${targetFixtures.length}; lineup records: ${result.lineups.length}; retained records: ${lineups.length}`);

async function readExistingLineups() {
  try {
    return JSON.parse(await readFile(outputPath, "utf8"));
  } catch {
    return { lineups: [] };
  }
}

function isPublicFixture(fixture) {
  return fixture?.sourceType === "public-web" || fixture?.source || fixture?.id;
}

function mergeLineups(existingLineups, freshLineups, currentTime) {
  const byFixture = new Map();

  for (const record of [...existingLineups, ...freshLineups]) {
    if (!record?.fixtureId || isExpired(record, currentTime)) {
      continue;
    }

    const previous = byFixture.get(record.fixtureId);

    const rank = recordRank(record);
    const previousRank = previous ? recordRank(previous) : 0;
    const newerSameRank = rank === previousRank && new Date(record.capturedAt || 0) > new Date(previous.capturedAt || 0);

    if (!previous || rank > previousRank || newerSameRank) {
      byFixture.set(record.fixtureId, record);
    }
  }

  return [...byFixture.values()]
    .sort((left, right) => new Date(left.fixtureDate) - new Date(right.fixtureDate));
}

function isExpired(record, currentTime) {
  const fixtureTime = new Date(record.fixtureDate || 0).getTime();

  if (!Number.isFinite(fixtureTime)) {
    return true;
  }

  return fixtureTime < currentTime.getTime() - (8 * 60 * 60000)
    || fixtureTime > currentTime.getTime() + (48 * 60 * 60000);
}

function recordRank(record) {
  if (record.status === "confirmed") {
    return 3;
  }

  if (record.status === "partial_confirmed") {
    return 2;
  }

  return 1;
}
