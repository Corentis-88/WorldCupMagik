import { readJson } from "../db.mjs";
import { makeId, normalizeName } from "../utils.mjs";
import {
  escapeRegExp,
  extractJsonLd,
  fetchPublicText,
  htmlToText,
  sourceDiagnostic,
  teamNameMatches,
  toDecimalOdds,
  uniqueBy
} from "./public-source.mjs";

export async function fetchOddsSnapshot({ fixtures, providerConfig, now = new Date() }) {
  const result = await fetchOddsSnapshotWithDiagnostics({ fixtures, providerConfig, now });
  return result.records;
}

export async function fetchOddsSnapshotWithDiagnostics({ fixtures, providerConfig, now = new Date() }) {
  const mode = providerConfig?.mode || "self-gather";

  if (mode !== "self-gather") {
    throw new Error(`Unsupported odds provider mode: ${mode}. WorldCupMagik odds use public bookmaker/comparison pages only.`);
  }

  const sources = await loadSources(providerConfig);
  const records = [];
  const diagnostics = [];

  for (const source of sources.filter((item) => item.enabled !== false)) {
    if (source.fixtureUrlFromFixtures) {
      for (const fixture of fixtures) {
        const url = buildFixtureUrl(source, fixture) || fixture.sourceUrl;

        if (!url) {
          diagnostics.push(sourceDiagnostic({
            kind: "odds",
            source,
            status: "empty",
            reason: `No public match URL available for ${fixture.homeTeam} v ${fixture.awayTeam}.`,
            now
          }));
          continue;
        }

        const fixtureSource = { ...source, url, name: `${source.name}: ${fixture.homeTeam} v ${fixture.awayTeam}` };

        try {
          const html = await fetchPublicText(url, providerConfig);
          const extracted = extractOddsFromPage({
            html,
            fixtures: [fixture],
            source: fixtureSource,
            now,
            providerConfig
          });

          records.push(...extracted);
          diagnostics.push(sourceDiagnostic({
            kind: "odds",
            source: fixtureSource,
            status: extracted.length ? "ok" : "empty",
            records: extracted.length,
            reason: extracted.length ? "" : "Fetched public match page but found no supported odds offers.",
            now
          }));
        } catch (error) {
          diagnostics.push(sourceDiagnostic({
            kind: "odds",
            source: fixtureSource,
            status: "error",
            reason: error instanceof Error ? error.message : String(error),
            now
          }));
        }
      }
      continue;
    }

    try {
      const url = source.url;
      const html = await fetchPublicText(url, providerConfig);
      const extracted = extractOddsFromPage({
        html,
        fixtures,
        source,
        now,
        providerConfig
      });

      records.push(...extracted);
      diagnostics.push(sourceDiagnostic({
        kind: "odds",
        source,
        status: extracted.length ? "ok" : "empty",
        records: extracted.length,
        reason: extracted.length ? "" : "Fetched public page but found no fixture-market odds near the selected teams.",
        now
      }));
    } catch (error) {
      diagnostics.push(sourceDiagnostic({
        kind: "odds",
        source,
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
        now
      }));
    }
  }

  return {
    records: uniqueBy(records, (record) => `${record.capturedAt}|${record.bookmaker}|${record.fixtureId}|${record.market}|${record.outcome}`),
    diagnostics
  };
}

async function loadSources(providerConfig) {
  if (Array.isArray(providerConfig?.sources)) {
    return providerConfig.sources;
  }

  return readJson((providerConfig?.sourcesFile || "config/odds-sources.json").split(/[\\/]/), []);
}

function buildFixtureUrl(source, fixture) {
  if (!source.urlTemplate) {
    return "";
  }

  const homeSlug = normalizeName(fixture.homeTeam).replace(/\s+/g, "-");
  const awaySlug = normalizeName(fixture.awayTeam).replace(/\s+/g, "-");

  return source.urlTemplate
    .replace(/\{homeSlug\}/g, homeSlug)
    .replace(/\{awaySlug\}/g, awaySlug)
    .replace(/\{home\}/g, encodeURIComponent(fixture.homeTeam))
    .replace(/\{away\}/g, encodeURIComponent(fixture.awayTeam));
}

function extractOddsFromPage({ html, fixtures, source, now }) {
  const jsonLdRecords = extractJsonLdOdds({ html, fixtures, source, now });

  if (jsonLdRecords.length) {
    return jsonLdRecords;
  }

  const text = htmlToText(html);
  const records = [];

  for (const fixture of fixtures) {
    const blocks = fixtureBlocks(text, fixture);

    for (const block of blocks) {
      records.push(...extractFixtureOdds({ block, fixture, source, now }));
    }
  }

  return records;
}

function extractJsonLdOdds({ html, fixtures, source, now }) {
  const records = [];
  const capturedAt = now.toISOString();

  for (const item of extractJsonLd(html)) {
    const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];

    if (!types.some((type) => /SportsEvent/i.test(String(type || "")))) {
      continue;
    }

    const fixture = matchFixtureFromJsonLd(fixtures, item);

    if (!fixture || !Array.isArray(item.offers)) {
      continue;
    }

    for (const offer of item.offers) {
      const mapped = mapJsonLdOffer(offer, fixture, item);
      const price = Number(offer.price);

      if (!mapped || !Number.isFinite(price) || price <= 1) {
        continue;
      }

      records.push(toOddsRecord({
        fixture,
        source,
        bookmaker: offer.offeredBy?.name || source.bookmaker || source.name,
        capturedAt,
        market: mapped.market,
        outcome: mapped.outcome,
        decimalOdds: price
      }));
    }
  }

  return uniqueBy(records, (record) => `${record.fixtureId}|${record.market}|${record.outcome}|${record.bookmaker}`);
}

function matchFixtureFromJsonLd(fixtures, item) {
  const homeTeam = teamValue(item.homeTeam);
  const awayTeam = teamValue(item.awayTeam);

  return fixtures.find((fixture) => {
    if (homeTeam && awayTeam) {
      return teamNameMatches(fixture.homeTeam, homeTeam) && teamNameMatches(fixture.awayTeam, awayTeam);
    }

    return teamNameMatches(item.name, fixture.homeTeam) && teamNameMatches(item.name, fixture.awayTeam);
  }) || null;
}

function mapJsonLdOffer(offer, fixture, event) {
  const name = String(offer.name || "");
  const prefix = normalizeName(name.split(/[—-]/)[0]);
  const homeNames = [fixture.homeTeam, event.homeTeam?.alternateName, event.homeTeam?.name].filter(Boolean).map(normalizeName);
  const awayNames = [fixture.awayTeam, event.awayTeam?.alternateName, event.awayTeam?.name].filter(Boolean).map(normalizeName);

  if (prefix === "draw") {
    return { market: "match_winner", outcome: "Draw" };
  }

  if (homeNames.some((team) => team && (prefix === team || team.includes(prefix) || prefix.includes(team)))) {
    return { market: "match_winner", outcome: fixture.homeTeam };
  }

  if (awayNames.some((team) => team && (prefix === team || team.includes(prefix) || prefix.includes(team)))) {
    return { market: "match_winner", outcome: fixture.awayTeam };
  }

  if (/over\s*2\.?5/i.test(name)) {
    return { market: "over_2_5_goals", outcome: "Over" };
  }

  if (/under\s*2\.?5/i.test(name)) {
    return { market: "under_2_5_goals", outcome: "Under" };
  }

  if (/^yes\b/i.test(name)) {
    return { market: "both_teams_to_score", outcome: "Yes" };
  }

  if (/^no\b/i.test(name)) {
    return { market: "both_teams_to_score", outcome: "No" };
  }

  return null;
}

function teamValue(value) {
  if (!value) {
    return "";
  }

  return typeof value === "string" ? value : value.name || value.alternateName || "";
}

function fixtureBlocks(text, fixture) {
  const normalized = normalizeName(text);
  const home = normalizeName(fixture.homeTeam);
  const away = normalizeName(fixture.awayTeam);
  const blocks = [];
  const raw = String(text || "");
  const patterns = [
    new RegExp(`${escapeRegExp(fixture.homeTeam)}[\\s\\S]{0,1200}${escapeRegExp(fixture.awayTeam)}`, "gi"),
    new RegExp(`${escapeRegExp(fixture.awayTeam)}[\\s\\S]{0,1200}${escapeRegExp(fixture.homeTeam)}`, "gi")
  ];

  for (const pattern of patterns) {
    for (const match of raw.matchAll(pattern)) {
      const start = Math.max(0, match.index - 500);
      const end = Math.min(raw.length, match.index + match[0].length + 700);
      blocks.push(raw.slice(start, end));
    }
  }

  if (!blocks.length && normalized.includes(home) && normalized.includes(away)) {
    const homeIndex = normalized.indexOf(home);
    const awayIndex = normalized.indexOf(away);
    const midpoint = Math.max(0, Math.min(homeIndex, awayIndex));
    blocks.push(raw.slice(Math.max(0, midpoint - 800), midpoint + 1600));
  }

  return blocks;
}

function extractFixtureOdds({ block, fixture, source, now }) {
  const records = [];
  const capturedAt = now.toISOString();
  const bookmaker = source.bookmaker || source.name;

  records.push(...extractNamedOutcomeOdds({
    block,
    fixture,
    source,
    bookmaker,
    capturedAt,
    now
  }));
  records.push(...extractMarketPairOdds({
    block,
    fixture,
    source,
    bookmaker,
    capturedAt,
    market: "over_2_5_goals",
    outcome: "Over",
    labelPattern: /(?:over|o)\s*2\.?5/i
  }));
  records.push(...extractMarketPairOdds({
    block,
    fixture,
    source,
    bookmaker,
    capturedAt,
    market: "under_2_5_goals",
    outcome: "Under",
    labelPattern: /(?:under|u)\s*2\.?5/i
  }));
  records.push(...extractMarketPairOdds({
    block,
    fixture,
    source,
    bookmaker,
    capturedAt,
    market: "both_teams_to_score",
    outcome: "Yes",
    labelPattern: /(?:btts|both teams to score)[\s\S]{0,80}\byes\b/i
  }));
  records.push(...extractMarketPairOdds({
    block,
    fixture,
    source,
    bookmaker,
    capturedAt,
    market: "both_teams_to_score",
    outcome: "No",
    labelPattern: /(?:btts|both teams to score)[\s\S]{0,80}\bno\b/i
  }));

  return uniqueBy(records, (record) => `${record.fixtureId}|${record.market}|${record.outcome}|${record.bookmaker}`);
}

function extractNamedOutcomeOdds({ block, fixture, source, bookmaker, capturedAt, now }) {
  const outcomes = [
    { market: "match_winner", outcome: fixture.homeTeam, aliases: [fixture.homeTeam] },
    { market: "match_winner", outcome: "Draw", aliases: ["Draw", "Tie"] },
    { market: "match_winner", outcome: fixture.awayTeam, aliases: [fixture.awayTeam] },
    { market: "draw_no_bet", outcome: fixture.homeTeam, aliases: [`${fixture.homeTeam} draw no bet`, `${fixture.homeTeam} DNB`] },
    { market: "draw_no_bet", outcome: fixture.awayTeam, aliases: [`${fixture.awayTeam} draw no bet`, `${fixture.awayTeam} DNB`] }
  ];
  const records = [];

  for (const outcome of outcomes) {
    const price = firstPriceNearAliases(block, outcome.aliases);

    if (!price) {
      continue;
    }

    records.push(toOddsRecord({
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: outcome.market,
      outcome: outcome.outcome,
      decimalOdds: price
    }));
  }

  if (!records.length) {
    records.push(...extractCompactThreeWayMarket({ block, fixture, source, bookmaker, capturedAt, now }));
  }

  return records;
}

function extractCompactThreeWayMarket({ block, fixture, source, bookmaker, capturedAt }) {
  const prices = priceTokens(block).slice(0, 8);

  if (prices.length < 3 || !containsBothTeams(block, fixture)) {
    return [];
  }

  const [home, draw, away] = prices;
  return [
    toOddsRecord({ fixture, source, bookmaker, capturedAt, market: "match_winner", outcome: fixture.homeTeam, decimalOdds: home.value }),
    toOddsRecord({ fixture, source, bookmaker, capturedAt, market: "match_winner", outcome: "Draw", decimalOdds: draw.value }),
    toOddsRecord({ fixture, source, bookmaker, capturedAt, market: "match_winner", outcome: fixture.awayTeam, decimalOdds: away.value })
  ];
}

function extractMarketPairOdds({ block, fixture, source, bookmaker, capturedAt, market, outcome, labelPattern }) {
  const match = block.match(labelPattern);

  if (!match) {
    return [];
  }

  const window = block.slice(match.index, match.index + 180);
  const token = priceTokens(window)[0];

  if (!token) {
    return [];
  }

  return [toOddsRecord({
    fixture,
    source,
    bookmaker,
    capturedAt,
    market,
    outcome,
    decimalOdds: token.value
  })];
}

function firstPriceNearAliases(block, aliases) {
  for (const alias of aliases) {
    const pattern = new RegExp(`${escapeRegExp(alias)}[\\s\\S]{0,90}?((?:\\d{1,2}\\.\\d{2})|(?:\\d{1,3}\\s*\\/\\s*\\d{1,3}))`, "i");
    const match = block.match(pattern);
    const price = toDecimalOdds(match?.[1]);

    if (price) {
      return price;
    }
  }

  return null;
}

function priceTokens(block) {
  const tokens = [];
  const pattern = /\b(\d{1,2}\.\d{2}|\d{1,3}\s*\/\s*\d{1,3})\b/g;

  for (const match of String(block || "").matchAll(pattern)) {
    const value = toDecimalOdds(match[1]);

    if (value && value >= 1.01 && value <= 1001) {
      tokens.push({ value, index: match.index });
    }
  }

  return tokens;
}

function containsBothTeams(block, fixture) {
  return teamNameMatches(block, fixture.homeTeam) && teamNameMatches(block, fixture.awayTeam);
}

function toOddsRecord({ fixture, source, bookmaker, capturedAt, market, outcome, decimalOdds }) {
  return {
    id: makeId("odds", [capturedAt, bookmaker, fixture.id, market, outcome, decimalOdds]),
    capturedAt,
    provider: "public-web",
    source: source.name,
    sourceUrl: source.url,
    bookmaker,
    fixtureId: fixture.id,
    fixtureDate: fixture.date,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    market,
    outcome,
    decimalOdds: Number(decimalOdds)
  };
}
