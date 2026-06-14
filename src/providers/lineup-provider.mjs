import { readJson } from "../db.mjs";
import { makeId, normalizeName } from "../utils.mjs";
import {
  absolutizeUrl,
  decodeEntities,
  escapeRegExp,
  fetchPublicText,
  htmlToLines,
  isHttpUrl,
  sourceDiagnostic,
  teamNameMatches,
  uniqueBy
} from "./public-source.mjs";

export async function fetchLineupSnapshotWithDiagnostics({ fixtures, providerConfig = {}, now = new Date() }) {
  const mode = providerConfig?.mode || "self-gather";

  if (mode !== "self-gather") {
    throw new Error(`Unsupported lineup provider mode: ${mode}. WorldCupMagik lineups use public web pages only.`);
  }

  const sources = await loadSources(providerConfig);
  const lineups = [];
  const diagnostics = [];

  for (const source of sources.filter((item) => item.enabled !== false)) {
    for (const fixture of fixtures) {
      if (source.type === "search") {
        const searchResult = await fetchSearchLineups({ source, fixture, providerConfig, now });
        lineups.push(...searchResult.lineups);
        diagnostics.push(...searchResult.diagnostics);
        continue;
      }

      const urls = buildFixtureUrls(source, fixture);

      if (fixture.sourceUrl) {
        urls.push(fixture.sourceUrl);
      }

      const uniqueUrls = [...new Set(urls.filter(Boolean))];

      if (!uniqueUrls.length) {
        diagnostics.push(sourceDiagnostic({
          kind: "lineups",
          source,
          status: "empty",
          reason: `No public lineup URL available for ${fixture.homeTeam} v ${fixture.awayTeam}.`,
          now
        }));
        continue;
      }

      for (const url of uniqueUrls) {
        const fixtureSource = { ...source, url, name: `${source.name}: ${fixture.homeTeam} v ${fixture.awayTeam}` };

        try {
          const html = await fetchPublicText(url, providerConfig);
          const extracted = extractLineupsFromPage({
            html,
            fixture,
            source: fixtureSource,
            now
          });

          lineups.push(...extracted);
          diagnostics.push(sourceDiagnostic({
            kind: "lineups",
            source: fixtureSource,
            status: extracted.length ? "ok" : "empty",
            records: extracted.length,
            reason: extracted.length ? "" : "Fetched public match page but found no confirmed or predicted lineup block.",
            now
          }));

          if (extracted.length) {
            break;
          }
        } catch (error) {
          diagnostics.push(sourceDiagnostic({
            kind: "lineups",
            source: fixtureSource,
            status: "error",
            reason: error instanceof Error ? error.message : String(error),
            now
          }));
        }
      }
    }
  }

  return {
    lineups: uniqueBy(lineups, (record) => `${record.fixtureId}|${record.sourceUrl}|${record.status}`),
    diagnostics
  };
}

async function fetchSearchLineups({ source, fixture, providerConfig, now }) {
  const lineups = [];
  const diagnostics = [];
  const searchUrls = buildSearchUrls(source, fixture).slice(0, Number(source.maxQueries || 3));
  const maxResultPages = Number(source.maxResultPages || 4);
  const seenResultUrls = new Set();

  if (!searchUrls.length) {
    diagnostics.push(sourceDiagnostic({
      kind: "lineups",
      source,
      status: "empty",
      reason: `No public team-sheet search URL available for ${fixture.homeTeam} v ${fixture.awayTeam}.`,
      now
    }));
    return { lineups, diagnostics };
  }

  for (const searchUrl of searchUrls) {
    const searchSource = { ...source, url: searchUrl, name: `${source.name}: ${fixture.homeTeam} v ${fixture.awayTeam}` };

    try {
      const searchHtml = await fetchPublicText(searchUrl, providerConfig);
      const resultUrls = extractSearchResultUrls(searchHtml, searchUrl)
        .filter((url) => shouldUseSearchResult(url, source))
        .filter((url) => {
          if (seenResultUrls.has(url)) {
            return false;
          }

          seenResultUrls.add(url);
          return true;
        })
        .slice(0, maxResultPages);

      diagnostics.push(sourceDiagnostic({
        kind: "lineups",
        source: searchSource,
        status: resultUrls.length ? "ok" : "empty",
        records: resultUrls.length,
        reason: resultUrls.length ? "" : "Public search returned no usable team-sheet pages.",
        now
      }));

      for (const resultUrl of resultUrls) {
        const resultSource = {
          ...source,
          url: resultUrl,
          name: `${source.name} result: ${fixture.homeTeam} v ${fixture.awayTeam}`
        };

        try {
          const html = await fetchPublicText(resultUrl, providerConfig);
          const extracted = extractLineupsFromPage({
            html,
            fixture,
            source: resultSource,
            now
          });

          lineups.push(...extracted);
          diagnostics.push(sourceDiagnostic({
            kind: "lineups",
            source: resultSource,
            status: extracted.length ? "ok" : "empty",
            records: extracted.length,
            reason: extracted.length ? "" : "Fetched public search result but found no usable team-sheet block.",
            now
          }));

          if (extracted.some((record) => record.status === "confirmed")) {
            return { lineups, diagnostics };
          }
        } catch (error) {
          diagnostics.push(sourceDiagnostic({
            kind: "lineups",
            source: resultSource,
            status: "error",
            reason: error instanceof Error ? error.message : String(error),
            now
          }));
        }
      }
    } catch (error) {
      diagnostics.push(sourceDiagnostic({
        kind: "lineups",
        source: searchSource,
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
        now
      }));
    }
  }

  return { lineups, diagnostics };
}

export function extractLineupsFromPage({ html, fixture, source, now = new Date() }) {
  const lines = htmlToLines(html);
  const teams = {};

  for (const team of [fixture.homeTeam, fixture.awayTeam]) {
    const parsed = parseTeamLineup(lines, team, fixture);

    if (parsed) {
      teams[team] = parsed;
    }
  }

  const foundTeams = Object.keys(teams);

  if (!foundTeams.length) {
    return [];
  }

  const capturedAt = now.toISOString();
  const statuses = foundTeams.map((team) => teams[team].status);
  const status = statuses.every((item) => item === "confirmed")
    ? "confirmed"
    : statuses.some((item) => item === "confirmed")
      ? "partial_confirmed"
      : "predicted";

  return [{
    id: makeId("lineup", [fixture.id, source.url, status, capturedAt]),
    fixtureId: fixture.id,
    fixtureDate: fixture.date,
    fixtureDateKey: String(fixture.date || "").slice(0, 10),
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    capturedAt,
    provider: "public-web",
    source: source.name,
    sourceUrl: source.url,
    status,
    teams
  }];
}

async function loadSources(providerConfig) {
  if (Array.isArray(providerConfig?.sources)) {
    return providerConfig.sources;
  }

  return readJson((providerConfig?.sourcesFile || "config/lineup-sources.json").split(/[\\/]/), []);
}

function buildFixtureUrls(source, fixture) {
  if (!source.urlTemplate) {
    return [];
  }

  const homeSlug = normalizeName(fixture.homeTeam).replace(/\s+/g, "-");
  const awaySlug = normalizeName(fixture.awayTeam).replace(/\s+/g, "-");
  const offsets = Array.isArray(source.dateOffsets) && source.dateOffsets.length
    ? source.dateOffsets
    : [0, 1, -1];

  return offsets.map((offset) => {
    const dateKey = fixtureDateKey(fixture, offset);

    return source.urlTemplate
      .replace(/\{homeSlug\}/g, homeSlug)
      .replace(/\{awaySlug\}/g, awaySlug)
      .replace(/\{dateKey\}/g, dateKey)
      .replace(/\{home\}/g, encodeURIComponent(fixture.homeTeam))
      .replace(/\{away\}/g, encodeURIComponent(fixture.awayTeam));
  });
}

function buildSearchUrls(source, fixture) {
  if (!source.urlTemplate) {
    return [];
  }

  const queryTemplates = Array.isArray(source.queries) && source.queries.length
    ? source.queries
    : [
      "{homeTeam} vs {awayTeam} confirmed lineups",
      "{homeTeam} {awayTeam} starting XI",
      "{homeTeam} v {awayTeam} team sheets",
      "{homeTeam} vs {awayTeam} official lineup {dateKey}"
    ];

  return queryTemplates.map((queryTemplate) => {
    const query = fillFixtureTemplate(queryTemplate, fixture);

    return fillFixtureTemplate(source.urlTemplate, fixture)
      .replace(/\{query\}/g, encodeURIComponent(query));
  });
}

function fillFixtureTemplate(template, fixture) {
  const homeSlug = normalizeName(fixture.homeTeam).replace(/\s+/g, "-");
  const awaySlug = normalizeName(fixture.awayTeam).replace(/\s+/g, "-");
  const dateKey = fixtureDateKey(fixture);

  return String(template || "")
    .replace(/\{homeSlug\}/g, homeSlug)
    .replace(/\{awaySlug\}/g, awaySlug)
    .replace(/\{dateKey\}/g, dateKey)
    .replace(/\{homeTeam\}/g, fixture.homeTeam)
    .replace(/\{awayTeam\}/g, fixture.awayTeam)
    .replace(/\{home\}/g, fixture.homeTeam)
    .replace(/\{away\}/g, fixture.awayTeam);
}

function extractSearchResultUrls(html, baseUrl) {
  const urls = [];
  const links = [...String(html || "").matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)];

  for (const link of links) {
    const url = unwrapSearchUrl(link[1], baseUrl);

    if (isHttpUrl(url) && !/duckduckgo\.com/i.test(new URL(url).hostname)) {
      urls.push(url);
    }
  }

  return uniqueBy(urls, (url) => url);
}

function unwrapSearchUrl(rawUrl, baseUrl) {
  const decoded = decodeEntities(rawUrl);
  const absolute = absolutizeUrl(decoded, baseUrl);

  try {
    const parsed = new URL(absolute);
    const wrapped = parsed.searchParams.get("uddg") || parsed.searchParams.get("u");

    if (wrapped) {
      return decodeEntities(decodeURIComponent(wrapped));
    }

    return parsed.toString();
  } catch {
    return absolute;
  }
}

function shouldUseSearchResult(url, source) {
  let hostname = "";

  try {
    hostname = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return false;
  }

  const excludedDomains = source.excludedDomains || [
    "facebook.com",
    "instagram.com",
    "linkedin.com",
    "pinterest.com",
    "tiktok.com",
    "twitter.com",
    "x.com",
    "youtube.com"
  ];

  if (excludedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    return false;
  }

  const includedDomains = source.includedDomains || [];

  if (!includedDomains.length) {
    return true;
  }

  return includedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function fixtureDateKey(fixture, offsetDays = 0) {
  const date = new Date(fixture.date || Date.now());
  date.setUTCDate(date.getUTCDate() + Number(offsetDays || 0));
  return date.toISOString().slice(0, 10);
}

function parseTeamLineup(lines, team, fixture) {
  const teamPattern = escapeRegExp(team);
  const statusWords = "(?:confirmed|official|announced|predicted|expected|probable|possible|projected|likely)";
  const lineupLabel = "(?:lineups?|starting\\s+lineups?|starting\\s+xi|starting\\s+eleven|team\\s+sheets?|teamsheets?|xi|eleven)";
  const directPatterns = [
    new RegExp(`\\b${teamPattern}\\s+(?:${statusWords}\\s+)?${lineupLabel}\\s*(?:\\((?<formation>[^)]+)\\))?\\s*[:\\-–]\\s*(?<players>.+)$`, "i"),
    new RegExp(`\\b(?:${statusWords}\\s+)?${teamPattern}\\s+(?:${lineupLabel})\\s*(?:\\((?<formation>[^)]+)\\))?\\s*[:\\-–]\\s*(?<players>.+)$`, "i"),
    new RegExp(`\\b(?:${statusWords}\\s+)?${lineupLabel}\\s*[:\\-–]\\s*${teamPattern}\\s*[:\\-–]\\s*(?<players>.+)$`, "i")
  ];
  const teamColonPattern = new RegExp(`^${teamPattern}\\s*[:\\-–]\\s*(?<players>.+)$`, "i");

  for (const line of lines) {
    const match = directPatterns.map((pattern) => line.match(pattern)).find(Boolean);

    if (match) {
      const starters = parsePlayerList(match.groups?.players);

      if (isPlausibleLineupStarters(starters, fixture)) {
        return {
          status: lineupStatusFromText(line),
          formation: cleanFormation(match.groups?.formation),
          starters: starters.slice(0, 11),
          normalizedStarters: starters.slice(0, 11).map(normalizeName),
          sourceText: line
        };
      }
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(teamColonPattern);

    if (!match || !hasNearbyLineupContext(lines, index)) {
      continue;
    }

    const starters = parsePlayerList(match.groups?.players);

    if (isPlausibleLineupStarters(starters, fixture)) {
      const context = lines.slice(Math.max(0, index - 4), index + 1).join(" ");

      return {
        status: lineupStatusFromText(context),
        formation: "",
        starters: starters.slice(0, 11),
        normalizedStarters: starters.slice(0, 11).map(normalizeName),
        sourceText: context
      };
    }
  }

  return parseCompactTeamLineup(lines, team, fixture);
}

function parseCompactTeamLineup(lines, team, fixture) {
  const teamPattern = escapeRegExp(team);
  const statusWords = "(?:confirmed|official|announced|predicted|expected|probable|possible|projected|likely)";
  const lineupLabel = "(?:lineups?|starting\\s+lineups?|starting\\s+xi|starting\\s+eleven|team\\s+sheets?|teamsheets?|xi|eleven)";
  const headingPattern = new RegExp(`\\b${teamPattern}\\s+(?:${statusWords}\\s+)?${lineupLabel}\\b\\s*(?<tail>[^\\n]*)`, "i");

  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(headingPattern);

    if (!heading) {
      continue;
    }

    const inlineStarters = parsePlayerList(heading.groups?.tail);
    const windowText = lines.slice(index + 1, index + 18).join(", ");
    const starters = inlineStarters.length >= 7 ? inlineStarters : parsePlayerList(windowText);

    if (isPlausibleLineupStarters(starters, fixture)) {
      return {
        status: lineupStatusFromText(lines[index]),
        formation: cleanFormation(lines[index]),
        starters: starters.slice(0, 11),
        normalizedStarters: starters.slice(0, 11).map(normalizeName),
        sourceText: [lines[index], ...lines.slice(index + 1, index + 18)].join(" ")
      };
    }
  }

  return null;
}

function hasNearbyLineupContext(lines, index) {
  const context = lines.slice(Math.max(0, index - 4), index + 1).join(" ");
  return /\b(?:confirmed|official|announced|predicted|expected|probable|possible|projected|likely|lineups?|starting\s+lineups?|starting\s+xi|team\s+sheets?|teamsheets?)\b/i.test(context);
}

function lineupStatusFromText(value) {
  const text = String(value || "");

  if (/\b(?:predicted|expected|probable|possible|projected|likely)\b/i.test(text)) {
    return "predicted";
  }

  if (/\b(?:confirmed|official|announced|team\s+sheets?|teamsheets?|starting\s+lineups?|starting\s+xi|xi|eleven)\b/i.test(text)) {
    return "confirmed";
  }

  return "predicted";
}

function parsePlayerList(value) {
  return String(value || "")
    .split(/[,;]\s*/)
    .map(cleanPlayerName)
    .filter(Boolean)
    .filter((item, index, items) => items.findIndex((other) => normalizeName(other) === normalizeName(item)) === index)
    .slice(0, 18);
}

function isPlausibleLineupStarters(starters, fixture) {
  const clean = (starters || []).slice(0, 11);

  if (clean.length < 7) {
    return false;
  }

  const plausible = clean.filter((name) => isPlausiblePlayerName(name, fixture)).length;
  return plausible >= Math.min(7, clean.length);
}

function isPlausiblePlayerName(value, fixture) {
  const text = String(value || "").trim();
  const key = normalizeName(text);
  const fixtureTeams = [fixture?.homeTeam, fixture?.awayTeam].map(normalizeName).filter(Boolean);

  if (!key || fixtureTeams.includes(key)) {
    return false;
  }

  if (/\/|\b(?:report|soccer|football|featured|video|world cup|previous|next|home|scores?|teams?|transfer|rumours?|rumors?|news|article|images?|getty|copyright|coach|manager|preview|prediction|odds)\b/i.test(text)) {
    return false;
  }

  if (/^(?:and|or|the|a|an)\b/i.test(text) || /\b(?:and|or)\s+[A-Z]/.test(text)) {
    return false;
  }

  if (/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(text)) {
    return false;
  }

  const words = key.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 4 && words.every((word) => word.length >= 2);
}

function cleanPlayerName(value) {
  const cleaned = String(value || "")
    .replace(/\([^)]*\b(?:GK|G|Goalkeeper|Sub|Captain|C)\b[^)]*\)/gi, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:confirmed|predicted|lineup|formation|substitutes?|bench|manager|coach)\b/gi, " ")
    .replace(/\d+-\d+(?:-\d+)*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[^A-Za-z\u00C0-\u017F]+|[^A-Za-z\u00C0-\u017F]+$/g, "")
    .trim();

  if (!cleaned || cleaned.length < 3 || cleaned.length > 48) {
    return "";
  }

  if (/^(?:GK|DF|MF|FW|CM|CB|LB|RB|LW|RW|ST)$/i.test(cleaned)) {
    return "";
  }

  return cleaned;
}

function cleanFormation(value) {
  const match = String(value || "").match(/\b\d-\d(?:-\d){0,3}\b/);
  return match?.[0] || "";
}

export function lineupPlayerMatches(left, right) {
  const a = normalizeName(left);
  const b = normalizeName(right);

  if (!a || !b) {
    return false;
  }

  if (a === b || a.endsWith(` ${b}`) || b.endsWith(` ${a}`)) {
    return true;
  }

  const aTokens = a.split(/\s+/).filter(Boolean);
  const bTokens = b.split(/\s+/).filter(Boolean);
  const aSurname = aTokens.at(-1);
  const bSurname = bTokens.at(-1);

  return Boolean(aSurname && bSurname && aSurname.length > 3 && aSurname === bSurname);
}

export function lineupTeamMatches(left, right) {
  return teamNameMatches(left, right);
}
