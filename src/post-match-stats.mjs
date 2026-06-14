import { readJson } from "./db.mjs";
import { makeId, normalizeName } from "./utils.mjs";

const TEAM_ALIASES = {
  turkiye: ["turkey", "türkiye"],
  turkey: ["turkiye", "türkiye"],
  "united states": ["usa", "usmnt"],
  usa: ["united states", "usmnt"],
  czechia: ["czech republic"],
  "czech republic": ["czechia"]
};

export async function loadPostMatchStats() {
  return readJson(["data", "post-match-stats.json"], []);
}

export function mergePostMatchStats(matchHistory = [], postMatchStats = []) {
  const overlays = (postMatchStats || [])
    .map(normalizePostMatchRecord)
    .filter(Boolean);

  if (!overlays.length) {
    return matchHistory || [];
  }

  const byFixtureId = new Map(overlays.filter((record) => record.fixtureId).map((record) => [record.fixtureId, record]));
  const usedOverlayIds = new Set();
  const merged = (matchHistory || []).map((match) => {
    const overlay = findOverlayForMatch(match, overlays, byFixtureId);

    if (!overlay) {
      return match;
    }

    usedOverlayIds.add(overlay.id);
    return {
      ...match,
      ...overlay,
      replacedMetricSource: match.metricSource && match.metricSource !== overlay.metricSource ? match.metricSource : undefined
    };
  });

  for (const overlay of overlays) {
    if (!usedOverlayIds.has(overlay.id)) {
      merged.push(overlay);
    }
  }

  return dedupeMergedHistory(merged);
}

function normalizePostMatchRecord(record = {}) {
  const date = validIso(record.date || record.fixtureDate || record.matchDate);

  if (!date || !record.homeTeam || !record.awayTeam) {
    return null;
  }

  const capturedMetricFields = uniqueStrings([
    ...(record.capturedMetricFields || []),
    "score",
    "xg",
    "shots",
    "shotsOnTarget"
  ]);

  return {
    ...record,
    id: record.id || makeId("match", [record.fixtureId || "", date, record.homeTeam, record.awayTeam, record.homeGoals, record.awayGoals]),
    date,
    fixtureDate: record.fixtureDate || date,
    createdAt: record.createdAt || record.capturedAt || new Date().toISOString(),
    updatedAt: record.updatedAt || record.createdAt || record.capturedAt || new Date().toISOString(),
    provider: record.provider || "post-match-stats",
    source: record.source || "FOX Sports boxscore",
    sourceType: record.sourceType || "public-web",
    metricSource: record.metricSource || "public-boxscore",
    capturedMetricFields,
    derivedMetricFields: record.derivedMetricFields || []
  };
}

function findOverlayForMatch(match, overlays, byFixtureId) {
  if (match?.fixtureId && byFixtureId.has(match.fixtureId)) {
    return byFixtureId.get(match.fixtureId);
  }

  const matchTime = new Date(match?.date || 0).getTime();

  return overlays.find((overlay) => {
    if (!teamsPairMatches(match, overlay)) {
      return false;
    }

    if (!Number.isFinite(matchTime)) {
      return true;
    }

    return Math.abs(new Date(overlay.date || 0).getTime() - matchTime) <= 36 * 60 * 60 * 1000;
  }) || null;
}

function teamsPairMatches(left = {}, right = {}) {
  return (teamMatches(left.homeTeam, right.homeTeam) && teamMatches(left.awayTeam, right.awayTeam))
    || (teamMatches(left.homeTeam, right.awayTeam) && teamMatches(left.awayTeam, right.homeTeam));
}

function teamMatches(left, right) {
  const leftKeys = teamIdentityKeys(left);
  const rightKeys = teamIdentityKeys(right);

  return leftKeys.some((leftKey) => rightKeys.includes(leftKey));
}

function teamIdentityKeys(team) {
  const key = normalizeName(team);
  const keys = new Set([key]);

  for (const alias of TEAM_ALIASES[key] || []) {
    keys.add(normalizeName(alias));
  }

  return [...keys].filter(Boolean);
}

function dedupeMergedHistory(records) {
  const byKey = new Map();

  for (const record of records) {
    const key = historyKey(record);
    const existing = byKey.get(key);

    if (!existing || postMatchQuality(record) >= postMatchQuality(existing)) {
      byKey.set(key, record);
    }
  }

  return [...byKey.values()].sort((left, right) => new Date(right.date || 0) - new Date(left.date || 0));
}

function historyKey(record = {}) {
  if (record.fixtureId) {
    return `fixture:${record.fixtureId}`;
  }

  const day = validIso(record.date)?.slice(0, 10) || "";
  return [
    day,
    normalizeName(record.homeTeam),
    normalizeName(record.awayTeam),
    `${record.homeGoals ?? ""}-${record.awayGoals ?? ""}`
  ].join("|");
}

function postMatchQuality(record = {}) {
  const captured = new Set(record.capturedMetricFields || []);
  let quality = 0;

  if (record.metricSource && record.metricSource !== "score-derived-estimates") {
    quality += 3;
  }

  if (captured.has("xg") || captured.has("homeXg")) {
    quality += 3;
  }

  if (captured.has("shots") || captured.has("homeShots")) {
    quality += 2;
  }

  if (captured.has("shotsOnTarget") || captured.has("homeShotsOnTarget")) {
    quality += 1;
  }

  return quality;
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function validIso(value) {
  if (!value) {
    return "";
  }

  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}
