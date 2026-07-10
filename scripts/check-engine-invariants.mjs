import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { filterOddsIntegrity } from "../src/providers/odds-integrity.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = async (...parts) => JSON.parse(await readFile(join(rootDir, ...parts), "utf8"));
const [payload, odds] = await Promise.all([
  readJson("web", "data", "latest.json"),
  readJson("data", "odds-snapshots.json")
]);
const failures = [];
const integrity = filterOddsIntegrity(odds);

for (const item of integrity.quarantined) {
  if (!String(item.reason || "").includes("duplicate_selection")) {
    failures.push(`stored odds failed integrity: ${item.reason} (${item.record?.fixtureId || "unknown fixture"})`);
  }
}

for (const [profileKey, profile] of Object.entries(payload.profiles || {})) {
  if (Number(profile.risk || 0) > 0 && Number(profile.eligibleLegCount || 0) > 0 && !(profile.betslip || []).length) {
    failures.push(`${profileKey} has eligible legs but no best-available risk result`);
  }

  for (const bet of profile.betslip || []) {
    validateBet(bet, profileKey);
  }
}

for (const [profileKey, profile] of Object.entries(payload.pickOfTheDay || {})) {
  for (const bet of profile.betslip || []) {
    validateBet(bet, profileKey);
  }
}

if (failures.length) {
  console.error(`Engine invariant guard failed with ${failures.length} issue(s):`);
  for (const failure of failures.slice(0, 40)) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Engine invariant guard passed: ${odds.length} stored odds and ${Object.keys(payload.profiles || {}).length} profiles checked.`);

function validateBet(bet, profileKey) {
  const legs = bet.legs || [];
  const signalKeys = legs.map(legSignalKey);
  if (new Set(signalKeys).size !== signalKeys.length) {
    failures.push(`${profileKey}/${bet.category || bet.type} repeats an exact leg`);
  }

  const product = legs.reduce((value, leg) => value * Number(leg.decimalOdds || 1), 1);
  if (legs.length && Math.abs(Number(bet.combinedDecimalOdds || 0) - round(product, 2)) > 0.011) {
    failures.push(`${profileKey}/${bet.category || bet.type} combined odds do not equal the actual leg product`);
  }

  const byFixture = new Map();
  for (const leg of legs) {
    const bucket = byFixture.get(leg.fixtureId) || [];
    bucket.push(leg);
    byFixture.set(leg.fixtureId, bucket);
  }
  for (const sameFixture of byFixture.values()) {
    if (sameFixture.length <= 1) {
      continue;
    }
    const groups = new Set(sameFixture.map((leg) => leg.betBuilderGroup || leg.components?.betBuilderGroup).filter(Boolean));
    if (sameFixture.some((leg) => !(leg.betBuilderCompatible || leg.components?.betBuilderCompatible)) || groups.size !== 1) {
      failures.push(`${profileKey}/${bet.category || bet.type} combines incompatible same-fixture legs`);
    }
  }

  if (bet.placeable === true || bet.placeability === "verified" || bet.directlyPlaceable === true || bet.placeabilityStatus === "verified_single_bookmaker") {
    const verifiedBooks = new Set(legs
      .filter((leg) => leg.bookmakerVerified || leg.components?.bookmakerVerified)
      .map((leg) => leg.bookmakerKey || leg.components?.bookmakerKey || leg.bookmaker)
      .filter(Boolean));
    if (verifiedBooks.size !== 1 || legs.some((leg) => !(leg.bookmakerVerified || leg.components?.bookmakerVerified))) {
      failures.push(`${profileKey}/${bet.category || bet.type} claims placeability without one verified bookmaker`);
    }
  }
}

function legSignalKey(leg = {}) {
  return [leg.fixtureId, leg.market, leg.outcome, leg.playerName, leg.line, leg.side].join("|").toLowerCase();
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}
