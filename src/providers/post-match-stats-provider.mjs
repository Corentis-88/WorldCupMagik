import { makeId, normalizeName, round } from "../utils.mjs";
import {
  absolutizeUrl,
  decodeEntities,
  escapeRegExp,
  fetchPublicText,
  htmlToLines,
  sourceDiagnostic,
  teamNameMatches
} from "./public-source.mjs";

const DEFAULT_SOURCES = [{
  name: "FOX Sports World Cup boxscores",
  url: "https://www.foxsports.com/soccer/fifa-world-cup-men/schedule",
  reliability: 0.84
}];
const DEFAULT_PROVIDER_CONFIG = {
  enabled: true,
  requestTimeoutMs: 15000,
  maxBoxscorePages: 48,
  backfillGameIdLookback: 14,
  backfillGameIdLookahead: 3,
  userAgent: "WorldCupMagik/1.0 public-web post-match gatherer; no APIs"
};
const MONTHS = new Map([
  ["january", 0],
  ["february", 1],
  ["march", 2],
  ["april", 3],
  ["may", 4],
  ["june", 5],
  ["july", 6],
  ["august", 7],
  ["september", 8],
  ["october", 9],
  ["november", 10],
  ["december", 11]
]);
const TEAM_ALIASES = {
  usa: ["united states", "united states men s"],
  "united states": ["usa", "united states men s"],
  czechia: ["czech republic"],
  "czech republic": ["czechia"],
  turkiye: ["turkey"],
  turkey: ["turkiye"],
  "dr congo": ["congo dr", "democratic republic of the congo"],
  "congo dr": ["dr congo", "democratic republic of the congo"]
};

export async function fetchPostMatchStatsWithDiagnostics({ providerConfig = {}, fixtures = [], now = new Date() } = {}) {
  const config = { ...DEFAULT_PROVIDER_CONFIG, ...(providerConfig || {}) };

  if (config.enabled === false) {
    return { records: [], diagnostics: [] };
  }

  const diagnostics = [];
  const scheduleUrls = new Set();
  const sources = Array.isArray(config.sources) && config.sources.length ? config.sources : DEFAULT_SOURCES;

  for (const source of sources) {
    try {
      const html = await fetchPublicText(source.url, config);
      const urls = extractFoxBoxscoreUrls(html, source.url, config);

      for (const url of urls) {
        scheduleUrls.add(url);
      }

      diagnostics.push(sourceDiagnostic({
        kind: "post_match_stats_schedule",
        source,
        status: urls.length ? "ok" : "empty",
        records: urls.length,
        reason: urls.length ? "" : "No FOX boxscore links found",
        now
      }));
    } catch (error) {
      diagnostics.push(sourceDiagnostic({
        kind: "post_match_stats_schedule",
        source,
        status: "error",
        reason: error.message,
        now
      }));
    }
  }

  const urls = [...scheduleUrls].slice(0, Number(config.maxBoxscorePages || 48));
  const records = [];
  let emptyPages = 0;
  let errorPages = 0;

  for (const url of urls) {
    try {
      const html = await fetchPublicText(url, config);
      const record = parseFoxBoxscorePage(html, { url, fixtures, now });

      if (record) {
        records.push(record);
      } else {
        emptyPages += 1;
      }
    } catch {
      errorPages += 1;
    }
  }

  diagnostics.push(sourceDiagnostic({
    kind: "post_match_stats_boxscores",
    source: sources[0],
    status: records.length ? "ok" : errorPages ? "error" : "empty",
    records: records.length,
    reason: [
      `${urls.length} page(s) checked`,
      emptyPages ? `${emptyPages} without settled stats` : "",
      errorPages ? `${errorPages} fetch error(s)` : ""
    ].filter(Boolean).join("; "),
    now
  }));

  return {
    records: dedupePostMatchRecords(records),
    diagnostics
  };
}

export function extractFoxBoxscoreUrls(html, baseUrl, providerConfig = {}) {
  const byId = new Map();
  const linkMatches = [
    ...String(html || "").matchAll(/href=["']([^"']*game-boxscore-\d+[^"']*)["']/gi),
    ...String(html || "").matchAll(/linkOut["']?\s*:\s*["']([^"']*game-boxscore-\d+[^"']*)["']/gi)
  ];

  for (const match of linkMatches) {
    const rawUrl = absolutizeUrl(match[1], baseUrl).replace(/[?#].*$/, "");

    if (!rawUrl.includes("/fifa-world-cup-men")) {
      continue;
    }

    const id = foxGameId(rawUrl);

    if (id) {
      byId.set(id, rawUrl);
    }
  }

  const ids = [...byId.keys()].map(Number).filter(Number.isFinite);
  const lookback = Number(providerConfig.backfillGameIdLookback ?? DEFAULT_PROVIDER_CONFIG.backfillGameIdLookback);
  const lookahead = Number(providerConfig.backfillGameIdLookahead ?? DEFAULT_PROVIDER_CONFIG.backfillGameIdLookahead);

  if (ids.length && lookback >= 0) {
    const minId = Math.min(...ids);
    const maxId = Math.max(...ids);

    for (let id = Math.max(1, minId - lookback); id <= maxId + lookahead; id += 1) {
      if (!byId.has(id)) {
        byId.set(id, placeholderFoxBoxscoreUrl(id));
      }
    }
  }

  return [...byId.entries()]
    .sort((left, right) => Number(right[0]) - Number(left[0]))
    .map(([, url]) => url);
}

export function parseFoxBoxscorePage(html, { url = "", fixtures = [], now = new Date() } = {}) {
  if (!String(html || "").includes("MATCH STATS")) {
    return null;
  }

  const title = pageTitle(html);
  const meta = parseFoxTitle(title);

  if (!meta) {
    return null;
  }

  const stats = parseFoxStats(html);

  if (!stats.homeXg && !stats.awayXg && !stats.homeShots && !stats.awayShots) {
    return null;
  }

  const goals = parseFoxGoalEvents(html, meta);
  const disciplineEvents = parseFoxDisciplineEvents(html, meta);
  const penaltyEvents = parseFoxPenaltyEvents(html, meta, goals);
  const fixture = matchFixture(meta, fixtures);
  const homeTeam = fixture?.homeTeam || meta.homeTeam;
  const awayTeam = fixture?.awayTeam || meta.awayTeam;
  const fixtureDate = fixture?.date || meta.date.toISOString();
  const date = fixtureDate;
  const sourceGameId = foxGameId(url);
  const homeScorers = aggregateGoalEvents(goals.filter((goal) => teamMatchesWithAliases(goal.team, meta.homeTeam) || teamMatchesWithAliases(goal.team, homeTeam)));
  const awayScorers = aggregateGoalEvents(goals.filter((goal) => teamMatchesWithAliases(goal.team, meta.awayTeam) || teamMatchesWithAliases(goal.team, awayTeam)));
  const score = finalScoreFromGoals(goals, meta, {
    homeScorers,
    awayScorers
  });
  const homeDisciplineEvents = disciplineEvents.filter((event) => teamMatchesWithAliases(event.team, meta.homeTeam) || teamMatchesWithAliases(event.team, homeTeam));
  const awayDisciplineEvents = disciplineEvents.filter((event) => teamMatchesWithAliases(event.team, meta.awayTeam) || teamMatchesWithAliases(event.team, awayTeam));
  const homePenaltyEvents = penaltyEvents.filter((event) => teamMatchesWithAliases(event.team, meta.homeTeam) || teamMatchesWithAliases(event.team, homeTeam));
  const awayPenaltyEvents = penaltyEvents.filter((event) => teamMatchesWithAliases(event.team, meta.awayTeam) || teamMatchesWithAliases(event.team, awayTeam));
  const penaltyCount = homePenaltyEvents.length + awayPenaltyEvents.length;
  const capturedMetricFields = [
    "score",
    "xg",
    "shots",
    "shotsOnTarget",
    stats.homePossession != null || stats.awayPossession != null ? "possession" : "",
    stats.homePassCompletion != null || stats.awayPassCompletion != null ? "passCompletion" : "",
    stats.homeCorners != null || stats.awayCorners != null ? "corners" : "",
    stats.homeFouls != null || stats.awayFouls != null ? "fouls" : "",
    stats.homeKeeperSaves != null || stats.awayKeeperSaves != null ? "keeperSaves" : "",
    homeScorers.length || awayScorers.length ? "scorers" : "",
    hasAssists(homeScorers) || hasAssists(awayScorers) ? "assists" : "",
    disciplineEvents.length ? "cards" : "",
    penaltyCount ? "penalties" : ""
  ].filter(Boolean);

  return {
    id: fixture?.id ? `match_actual_${fixture.id}` : makeId("match_actual_fox", [sourceGameId, date, homeTeam, awayTeam]),
    fixtureId: fixture?.id || "",
    sourceGameId,
    date,
    fixtureDate,
    homeTeam,
    awayTeam,
    homeGoals: score.homeGoals,
    awayGoals: score.awayGoals,
    ...stats,
    homeYellowCards: homeDisciplineEvents.filter((event) => event.card === "yellow").length,
    awayYellowCards: awayDisciplineEvents.filter((event) => event.card === "yellow").length,
    homeRedCards: homeDisciplineEvents.filter((event) => event.card === "red").length,
    awayRedCards: awayDisciplineEvents.filter((event) => event.card === "red").length,
    homeCardedPlayers: cardedPlayers(homeDisciplineEvents),
    awayCardedPlayers: cardedPlayers(awayDisciplineEvents),
    penaltyAwarded: penaltyCount > 0,
    penaltyCount,
    homePenaltyCount: homePenaltyEvents.length,
    awayPenaltyCount: awayPenaltyEvents.length,
    penaltyEvents,
    homeScorers,
    awayScorers,
    provider: "post-match-stats",
    source: "FOX Sports boxscore",
    sourceType: "public-web",
    metricSource: "fox-sports-boxscore",
    capturedMetricFields,
    derivedMetricFields: [],
    sourceUrl: url,
    sourceReliability: 0.84,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
}

function parseFoxStats(html) {
  const stat = (label) => parsePairValue(html, label);
  const possession = stat("POSSESSION (%)");
  const shots = stat("TOTAL SHOTS");
  const shotsOnGoal = stat("SHOTS ON GOAL");
  const xg = stat("EXPECTED GOALS (xG)");
  const passAccuracy = stat("PASSING ACCURACY (%)");
  const corners = stat("CORNERS");
  const fouls = stat("FOULS");
  const saves = stat("SAVES") || stat("GOALKEEPER SAVES");
  const clearances = stat("CLEARANCES");

  return cleanUndefined({
    homeXg: roundOptional(numberValue(xg?.home), 2),
    awayXg: roundOptional(numberValue(xg?.away), 2),
    homeShots: numberValue(shots?.home),
    awayShots: numberValue(shots?.away),
    homeShotsOnTarget: numberValue(shotsOnGoal?.home),
    awayShotsOnTarget: numberValue(shotsOnGoal?.away),
    homePossession: numberValue(possession?.home),
    awayPossession: numberValue(possession?.away),
    homePassCompletion: percentValue(passAccuracy?.home),
    awayPassCompletion: percentValue(passAccuracy?.away),
    homeCorners: numberValue(corners?.home),
    awayCorners: numberValue(corners?.away),
    homeFouls: numberValue(fouls?.home),
    awayFouls: numberValue(fouls?.away),
    homeKeeperSaves: numberValue(saves?.home),
    awayKeeperSaves: numberValue(saves?.away),
    homeClearances: numberValue(clearances?.home),
    awayClearances: numberValue(clearances?.away)
  });
}

function parsePairValue(html, label) {
  const regex = new RegExp(`"${escapeRegExp(label)}","([^"]*)","([^"]*)"`, "i");
  const match = String(html || "").match(regex);

  if (!match) {
    return null;
  }

  return {
    home: decodeEntities(match[1]),
    away: decodeEntities(match[2])
  };
}

function parseFoxGoalEvents(html, meta) {
  const events = [];
  const teamByAbbreviation = new Map();
  const blockRegex = /<div class="keyplay-title[^>]*">([^<]*\bGOAL)<\/div>([\s\S]*?)<span class="keystats-desc[^>]*">([^<]+)<\/span>/gi;
  let order = 0;

  for (const match of String(html || "").matchAll(blockRegex)) {
    const title = decodeEntities(match[1]).replace(/\s+/g, " ").trim();
    const body = match[2] || "";
    const description = decodeEntities(match[3]).replace(/\s+/g, " ").trim();
    const abbr = title.match(/^([A-Z]{2,5})\s+GOAL$/)?.[1] || "";
    const scoreLabels = [...body.matchAll(/>([A-Z]{2,5})\s+(\d{1,2})</g)];

    if (scoreLabels.length >= 2 && !teamByAbbreviation.size) {
      teamByAbbreviation.set(scoreLabels[0][1], meta.homeTeam);
      teamByAbbreviation.set(scoreLabels[1][1], meta.awayTeam);
    }

    const scorer = description.match(/(?:^|\s)([A-Z][A-Za-zÀ-ÿ'. -]+?)\s+scored\s+(?:a|an)\s+goal/i);

    if (!abbr || !scorer) {
      continue;
    }

    order += 1;
    const assist = description.match(/assisted by\s+([A-Z][A-Za-zÀ-ÿ'. -]+?)(?:\.|$)/i);
    events.push({
      team: teamByAbbreviation.get(abbr) || abbr,
      name: scorer[1].trim(),
      minute: parseMinute(description),
      goals: 1,
      order,
      assists: assist ? [assist[1].trim()] : [],
      penalty: /\bpen(?:alty)?\b/i.test(description),
      ownGoal: /\bown goal\b/i.test(description)
    });
  }

  return events;
}

function parseFoxDisciplineEvents(html, meta) {
  const events = [];
  const blockRegex = /<div class="keyplay-title[^>]*">([^<]*(?:YELLOW|RED)[^<]*CARD[^<]*)<\/div>([\s\S]*?)<span class="keystats-desc[^>]*">([^<]+)<\/span>/gi;

  for (const match of String(html || "").matchAll(blockRegex)) {
    const title = decodeEntities(match[1]).replace(/\s+/g, " ").trim();
    const body = match[2] || "";
    const description = decodeEntities(match[3]).replace(/\s+/g, " ").trim();
    const card = /\bred\b/i.test(title) || /\bred card\b/i.test(description) ? "red" : "yellow";
    const name = extractCardedPlayerName(description);

    if (!name) {
      continue;
    }

    events.push({
      team: keyplayTeam(title, body, meta),
      name,
      minute: parseMinute(description),
      card,
      description
    });
  }

  return uniqueEvents(events, (event) => `${event.card}|${normalizeName(event.team)}|${normalizeName(event.name)}|${event.minute || ""}`);
}

function parseFoxPenaltyEvents(html, meta, goalEvents = []) {
  const events = [];

  for (const goal of goalEvents.filter((event) => event.penalty)) {
    events.push({
      team: goal.team,
      name: goal.name,
      minute: goal.minute,
      scored: true,
      source: "goal-event"
    });
  }

  const blockRegex = /<div class="keyplay-title[^>]*">([^<]*PENALTY[^<]*)<\/div>([\s\S]*?)<span class="keystats-desc[^>]*">([^<]+)<\/span>/gi;

  for (const match of String(html || "").matchAll(blockRegex)) {
    const title = decodeEntities(match[1]).replace(/\s+/g, " ").trim();
    const body = match[2] || "";
    const description = decodeEntities(match[3]).replace(/\s+/g, " ").trim();
    const name = extractPenaltyPlayerName(description);

    events.push({
      team: keyplayTeam(title, body, meta),
      name,
      minute: parseMinute(description),
      scored: /\bscored\b/i.test(description) && !/\bmiss|saved\b/i.test(description),
      source: "keyplay",
      description
    });
  }

  return uniqueEvents(events, (event) => `${normalizeName(event.team)}|${normalizeName(event.name)}|${event.minute || ""}|${event.scored ? "scored" : "awarded"}`);
}

function extractCardedPlayerName(description) {
  const patterns = [
    /([A-Z][A-Za-zÀ-ÿ'. -]+?)\s+(?:is\s+)?(?:shown|receives|gets)\s+(?:a\s+)?(?:yellow|red)\s+card/i,
    /(?:yellow|red)\s+card\s+(?:shown\s+to|to|for)\s+([A-Z][A-Za-zÀ-ÿ'. -]+?)(?:\.|$|\s+\()/i,
    /([A-Z][A-Za-zÀ-ÿ'. -]+?)\s+\([^)]+\)\s+(?:is\s+)?(?:shown|receives|gets)/i
  ];

  for (const pattern of patterns) {
    const match = String(description || "").match(pattern);

    if (match?.[1]) {
      return cleanEventPlayerName(match[1]);
    }
  }

  return "";
}

function extractPenaltyPlayerName(description) {
  const patterns = [
    /([A-Z][A-Za-zÀ-ÿ'. -]+?)\s+(?:scored|missed|had|takes|took)\s+(?:a\s+)?penalty/i,
    /penalty\s+(?:by|taken by|missed by|saved from)\s+([A-Z][A-Za-zÀ-ÿ'. -]+?)(?:\.|$)/i,
    /([A-Z][A-Za-zÀ-ÿ'. -]+?)\s+penalty/i
  ];

  for (const pattern of patterns) {
    const match = String(description || "").match(pattern);

    if (match?.[1]) {
      return cleanEventPlayerName(match[1]);
    }
  }

  return "";
}

function keyplayTeam(title, body, meta) {
  const abbr = String(title || "").match(/^([A-Z]{2,5})\s+/)?.[1] || "";
  const scoreLabels = [...String(body || "").matchAll(/>([A-Z]{2,5})\s+\d{1,2}</g)];

  if (abbr && scoreLabels.length >= 2) {
    if (abbr === scoreLabels[0][1]) {
      return meta.homeTeam;
    }

    if (abbr === scoreLabels[1][1]) {
      return meta.awayTeam;
    }
  }

  return abbr;
}

function aggregateGoalEvents(events = []) {
  const byPlayer = new Map();

  for (const event of events) {
    if (!event.name || event.ownGoal) {
      continue;
    }

    const key = normalizeName(event.name);
    const existing = byPlayer.get(key) || {
      name: event.name,
      goals: 0,
      minutes: [],
      assists: [],
      order: event.order
    };
    existing.goals += Number(event.goals || 1);
    existing.minutes.push(event.minute);
    existing.order = Math.min(existing.order, event.order);
    existing.assists.push(...(event.assists || []));
    existing.penalty = existing.penalty || event.penalty;
    byPlayer.set(key, existing);
  }

  return [...byPlayer.values()]
    .sort((left, right) => Number(left.order || 99) - Number(right.order || 99))
    .map((event) => ({
      name: event.name,
      minute: event.minutes.find((minute) => Number.isFinite(minute)) || null,
      minutes: event.minutes.filter((minute) => Number.isFinite(minute)),
      goals: event.goals,
      order: event.order,
      assists: [...new Set(event.assists.filter(Boolean))],
      penalty: Boolean(event.penalty) || undefined
    }));
}

function cardedPlayers(events = []) {
  return events
    .filter((event) => event.name)
    .map((event) => ({
      name: event.name,
      minute: event.minute,
      card: event.card
    }));
}

function uniqueEvents(events, keyFn) {
  const byKey = new Map();

  for (const event of events) {
    const key = keyFn(event);

    if (!byKey.has(key)) {
      byKey.set(key, event);
    }
  }

  return [...byKey.values()];
}

function cleanEventPlayerName(value) {
  return String(value || "")
    .replace(/\b(?:penalty|yellow|red|card|shown|receives|gets|scored|missed|saved|from|for|by)\b/gi, " ")
    .replace(/^[^A-Za-zÀ-ÿ]+|[^A-Za-zÀ-ÿ]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function finalScoreFromGoals(events, meta, { homeScorers, awayScorers }) {
  const homeGoals = homeScorers.reduce((total, scorer) => total + Number(scorer.goals || 0), 0);
  const awayGoals = awayScorers.reduce((total, scorer) => total + Number(scorer.goals || 0), 0);

  if (events.length) {
    return { homeGoals, awayGoals };
  }

  return {
    homeGoals: Number(meta.homeGoals || 0),
    awayGoals: Number(meta.awayGoals || 0)
  };
}

function matchFixture(meta, fixtures = []) {
  const metaTime = new Date(meta.date || 0).getTime();

  return fixtures.find((fixture) => {
    const fixtureTime = new Date(fixture.date || 0).getTime();
    const samePair = (teamMatchesWithAliases(fixture.homeTeam, meta.homeTeam) && teamMatchesWithAliases(fixture.awayTeam, meta.awayTeam))
      || (teamMatchesWithAliases(fixture.homeTeam, meta.awayTeam) && teamMatchesWithAliases(fixture.awayTeam, meta.homeTeam));

    if (!samePair) {
      return false;
    }

    return !Number.isFinite(metaTime) || !Number.isFinite(fixtureTime) || Math.abs(fixtureTime - metaTime) <= 72 * 3600000;
  }) || null;
}

function teamMatchesWithAliases(left, right) {
  if (teamNameMatches(left, right)) {
    return true;
  }

  const leftKeys = teamKeys(left);
  const rightKeys = teamKeys(right);
  return leftKeys.some((leftKey) => rightKeys.includes(leftKey));
}

function teamKeys(team) {
  const key = normalizeName(team);
  return [...new Set([key, ...(TEAM_ALIASES[key] || []).map(normalizeName)])].filter(Boolean);
}

function parseFoxTitle(title) {
  const text = decodeEntities(title).replace(/\s+/g, " ").trim();
  const dateMatch = text.match(/\s+-\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})(?:\s+\||$)/);

  if (!dateMatch) {
    return null;
  }

  const month = MONTHS.get(dateMatch[1].toLowerCase());
  const day = Number(dateMatch[2]);
  const year = Number(dateMatch[3]);

  if (month == null || !day || !year) {
    return null;
  }

  const beforeDate = text.slice(0, dateMatch.index)
    .replace(/\s+-\s+(?:Final Score|Live Score|Box Score and Stats|Boxscore)$/i, "")
    .replace(/\s+Box Score and Stats$/i, "")
    .trim();
  const teams = beforeDate.match(/^(.*?)\s+vs\.\s+(.*?)$/i);

  if (!teams) {
    return null;
  }

  return {
    homeTeam: teams[1].trim(),
    awayTeam: teams[2].trim(),
    date: new Date(Date.UTC(year, month, day, 12, 0, 0)),
    status: /Final Score/i.test(text) ? "final" : /Live Score/i.test(text) ? "live" : "boxscore"
  };
}

function pageTitle(html) {
  const title = String(html || "").match(/<title[^>]*>([^<]+)/i)?.[1];

  if (title) {
    return decodeEntities(title);
  }

  return htmlToLines(html)[0] || "";
}

function parseMinute(text) {
  const match = String(text || "").match(/\b(\d{1,3})(?:\+(\d{1,2}))?&#39;|\b(\d{1,3})(?:\+(\d{1,2}))?'/);

  if (!match) {
    return null;
  }

  return Number(match[1] || match[3]) + Number(match[2] || match[4] || 0);
}

function numberValue(value) {
  const text = String(value ?? "").replace(/[^\d.-]+/g, "");
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
}

function percentValue(value) {
  const number = numberValue(value);
  return Number.isFinite(number) ? round(number / 100, 3) : undefined;
}

function roundOptional(value, digits) {
  return Number.isFinite(value) ? round(value, digits) : undefined;
}

function cleanUndefined(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== null));
}

function hasAssists(scorers = []) {
  return scorers.some((scorer) => (scorer.assists || []).length);
}

function foxGameId(url) {
  const match = String(url || "").match(/game-boxscore-(\d+)/);
  return match ? Number(match[1]) : null;
}

function placeholderFoxBoxscoreUrl(id) {
  return `https://www.foxsports.com/soccer/fifa-world-cup-men-placeholder-game-boxscore-${id}`;
}

function dedupePostMatchRecords(records = []) {
  const byKey = new Map();

  for (const record of records) {
    const key = record.sourceGameId ? `fox:${record.sourceGameId}` : record.fixtureId ? `fixture:${record.fixtureId}` : record.id;

    if (!byKey.has(key)) {
      byKey.set(key, record);
    }
  }

  return [...byKey.values()].sort((left, right) => new Date(right.date || 0) - new Date(left.date || 0));
}
