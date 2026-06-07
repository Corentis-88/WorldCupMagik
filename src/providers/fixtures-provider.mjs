import { readJson } from "../db.mjs";
import { makeId, normalizeName } from "../utils.mjs";
import {
  cleanTeamName,
  decodeEntities,
  escapeRegExp,
  extractJsonLd,
  fetchPublicText,
  htmlToLines,
  parseClock,
  parseDate,
  sourceDiagnostic,
  stripTags,
  teamNameMatches,
  uniqueBy
} from "./public-source.mjs";

export async function fetchFixtures({ providerConfig, now = new Date() }) {
  const result = await fetchFixturesWithDiagnostics({ providerConfig, now });
  return result.records;
}

export async function fetchFixturesWithDiagnostics({ providerConfig, now = new Date() }) {
  const mode = providerConfig?.mode || "self-gather";

  if (mode !== "self-gather") {
    throw new Error(`Unsupported fixtures provider mode: ${mode}. WorldCupMagik fixtures use public web pages only.`);
  }

  const sources = await loadSources(providerConfig);
  const records = [];
  const diagnostics = [];

  for (const source of sources.filter((item) => item.enabled !== false)) {
    try {
      const html = await fetchPublicText(source.url, providerConfig);
      const rowFixtures = extractMatchRowFixtures({ html, source, now });
      const jsonLdFixtures = rowFixtures.length ? [] : extractJsonLdFixtures({ html, source, now });
      const extracted = rowFixtures.length ? rowFixtures : jsonLdFixtures.length ? jsonLdFixtures : extractTextFixtures({ html, source, now });

      records.push(...extracted);
      diagnostics.push(sourceDiagnostic({
        kind: "fixtures",
        source,
        status: extracted.length ? "ok" : "empty",
        records: extracted.length,
        reason: extracted.length ? "" : "Fetched public page but found no fixture rows matching team-v-team patterns.",
        now
      }));
    } catch (error) {
      diagnostics.push(sourceDiagnostic({
        kind: "fixtures",
        source,
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
        now
      }));
    }
  }

  return {
    records: uniqueBy(records, (fixture) => `${fixture.date}|${normalizeName(fixture.homeTeam)}|${normalizeName(fixture.awayTeam)}`)
      .sort((left, right) => new Date(left.date) - new Date(right.date)),
    diagnostics
  };
}

async function loadSources(providerConfig) {
  if (Array.isArray(providerConfig?.sources)) {
    return providerConfig.sources;
  }

  return readJson((providerConfig?.sourcesFile || "config/fixture-sources.json").split(/[\\/]/), []);
}

function extractJsonLdFixtures({ html, source, now }) {
  const records = [];

  for (const item of extractJsonLd(html)) {
    const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
    const isEvent = types.some((type) => /SportsEvent|Event/i.test(String(type || "")));

    if (!isEvent) {
      continue;
    }

    const teams = extractJsonLdTeams(item);
    const date = item.startDate || item.startTime || item.datePublished;

    if (teams.length < 2 || !date) {
      continue;
    }

    const parsedDate = new Date(date);

    if (Number.isNaN(parsedDate.getTime())) {
      continue;
    }

    records.push(toFixture({
      homeTeam: teams[0],
      awayTeam: teams[1],
      date: parsedDate,
      source,
      now,
      stage: inferStage(item.name || item.description || ""),
      venue: locationName(item.location)
    }));
  }

  return records.filter(Boolean);
}

function extractJsonLdTeams(item) {
  const teamValues = [
    item.homeTeam,
    item.awayTeam,
    item.competitor,
    item.performer,
    item.participant,
    item.about
  ].flat().filter(Boolean);
  const teams = [];

  for (const value of teamValues) {
    const name = cleanTeamName(typeof value === "string" ? value : value.name || value.alternateName || "");

    if (name && !teams.some((team) => teamNameMatches(team, name))) {
      teams.push(name);
    }
  }

  if (teams.length >= 2) {
    return teams.slice(0, 2);
  }

  const nameTeams = String(item.name || item.description || "").match(teamVersusRegex());
  return nameTeams ? [cleanTeamName(nameTeams[1]), cleanTeamName(nameTeams[2])].filter(Boolean) : teams;
}

function extractTextFixtures({ html, source, now }) {
  const lines = htmlToLines(html);
  const records = [];
  let currentDate = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const parsedDate = parseDate(line, now.getFullYear());

    if (parsedDate && /2026|june|july|jun|jul/i.test(line)) {
      currentDate = parsedDate;
    }

    const match = line.match(teamVersusRegex());

    if (!match) {
      continue;
    }

    const homeTeam = cleanTeamName(match[1]);
    const awayTeam = cleanTeamName(match[2]);

    if (!isUsableTeam(homeTeam) || !isUsableTeam(awayTeam) || teamNameMatches(homeTeam, awayTeam)) {
      continue;
    }

    const context = lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 3)).join(" ");
    const date = parseDate(context, now.getFullYear()) || currentDate;

    if (!date) {
      continue;
    }

    const clock = parseClock(context);

    if (clock) {
      date.setUTCHours(clock.hour, clock.minute, 0, 0);
    }

    records.push(toFixture({
      homeTeam,
      awayTeam,
      date,
      source,
      now,
      stage: inferStage(context),
      venue: inferVenue(context)
    }));
  }

  return records.filter(Boolean);
}

function extractMatchRowFixtures({ html, source, now }) {
  const rows = [...String(html || "").matchAll(/<a\b[^>]*class=["'][^"']*\bmatch-row\b[^"']*["'][\s\S]*?<\/a>/gi)];
  const records = [];

  for (const row of rows) {
    const block = row[0];
    const date = extractMatchRowDate(block);
    const teams = extractMatchRowTeams(block);
    const homeTeam = teams[0];
    const awayTeam = teams[1];
    const stage = cleanStage(extractClassText(block, "cell-stage")) || inferStage(block);
    const venue = cleanVenue(extractClassText(block, "venue-cell"));

    if (!date || !homeTeam || !awayTeam) {
      continue;
    }

    records.push(toFixture({
      homeTeam,
      awayTeam,
      date,
      source,
      now,
      stage,
      venue
    }));
  }

  return records.filter(Boolean);
}

function extractMatchRowTeams(block) {
  const teamNames = [...String(block || "").matchAll(/<span\b[^>]*class=["'][^"']*\bteam-name\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)]
    .map((match) => cleanTeamName(decodeEntities(stripTags(match[1]))))
    .filter(Boolean);

  if (teamNames.length >= 2) {
    return teamNames.slice(0, 2);
  }

  const team1 = String(block || "").match(/\bdata-team1=["']([^"']+)["']/i);
  const team2 = String(block || "").match(/\bdata-team2=["']([^"']+)["']/i);

  return [
    titleCaseTeam(team1 ? decodeEntities(team1[1]) : ""),
    titleCaseTeam(team2 ? decodeEntities(team2[1]) : "")
  ].filter(Boolean);
}

function titleCaseTeam(value) {
  return cleanTeamName(String(value || "")
    .split(/\s+/)
    .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : "")
    .join(" "));
}

function extractMatchRowDate(block) {
  const time = String(block || "").match(/<time\b[^>]*datetime=["']([^"']+)["']/i);
  const value = time ? decodeEntities(time[1]) : "";
  const date = value ? new Date(value) : null;

  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function extractClassText(block, className) {
  const pattern = new RegExp(`<span\\b[^>]*class=["'][^"']*\\b${escapeRegExp(className)}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/span>`, "i");
  const match = String(block || "").match(pattern);

  if (!match) {
    return "";
  }

  return decodeEntities(stripTags(match[1])).replace(/\s+/g, " ").trim();
}

function cleanVenue(value) {
  return decodeEntities(String(value || ""))
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",")
    .trim();
}

function cleanStage(value) {
  const text = decodeEntities(String(value || "")).replace(/\s+/g, " ").trim();
  return text || "";
}

function teamVersusRegex() {
  return new RegExp(`\\b([A-Z][A-Za-zÀ-ÖØ-öø-ÿ.' -]{2,42}?)\\s+(?:v|vs\\.?|versus)\\s+([A-Z][A-Za-zÀ-ÖØ-öø-ÿ.' -]{2,42}?)\\b`);
}

function toFixture({ homeTeam, awayTeam, date, source, now, stage = "group", venue = "" }) {
  const home = canonicalTeamName(cleanTeamName(homeTeam));
  const away = canonicalTeamName(cleanTeamName(awayTeam));

  if (!isUsableTeam(home) || !isUsableTeam(away)) {
    return null;
  }

  return {
    id: makeId("fixture", [date.toISOString(), home, away]),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    date: date.toISOString(),
    stage,
    group: inferGroup(`${home} ${away}`),
    homeTeam: home,
    awayTeam: away,
    venue,
    neutralVenue: true,
    source: source.name,
    sourceUrl: source.url,
    sourceType: "public-web",
    sourceReliability: Number(source.reliability || 0.65)
  };
}

function canonicalTeamName(value) {
  const text = cleanTeamName(value);
  const aliases = new Map(Object.entries({
    "bosnia herzegovina": "Bosnia and Herzegovina",
    "bosnia and herzegovina": "Bosnia and Herzegovina",
    "czech republic": "Czechia",
    "korea republic": "South Korea",
    "united states": "USA",
    "turkey": "Turkiye",
    "turkiye": "Turkiye"
  }));

  return aliases.get(normalizeName(text)) || text;
}

function isUsableTeam(value) {
  const text = cleanTeamName(value);
  const normalized = normalizeName(text);

  if (text.length < 3 || text.length > 42) {
    return false;
  }

  return !/(world cup|fixtures|schedule|stadium|group|match|odds|betting|winner|draw|round|final|semi final|quarter final)/i.test(normalized);
}

function inferStage(text) {
  const normalized = normalizeName(text);

  if (/round of 32/.test(normalized)) {
    return "round_of_32";
  }

  if (/round of 16/.test(normalized)) {
    return "round_of_16";
  }

  if (/quarter/.test(normalized)) {
    return "quarter_final";
  }

  if (/semi/.test(normalized)) {
    return "semi_final";
  }

  if (/\bfinal\b/.test(normalized)) {
    return "final";
  }

  return "group";
}

function inferGroup(text) {
  const match = String(text || "").match(/\bGroup\s+([A-L])\b/i);
  return match ? `Group ${match[1].toUpperCase()}` : "";
}

function inferVenue(text) {
  const venueMatch = String(text || "").match(/\b(?:at|venue:)\s+([A-Z][A-Za-z0-9 .'-]{4,60})(?:,|\.|\s+\d|\s+Group|$)/);
  return venueMatch ? venueMatch[1].trim() : "";
}

function locationName(location) {
  if (!location) {
    return "";
  }

  if (typeof location === "string") {
    return location;
  }

  return location.name || location.address?.name || location.address?.addressLocality || "";
}
