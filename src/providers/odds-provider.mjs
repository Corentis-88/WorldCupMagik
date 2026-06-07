import { buildMockOdds } from "./mock-data.mjs";
import { makeId, normalizeName } from "../utils.mjs";

export async function fetchOddsSnapshot({ fixtures, providerConfig, now = new Date() }) {
  const mode = providerConfig?.mode || "mock";

  if (mode === "mock") {
    return buildMockOdds(fixtures, now);
  }

  if (mode === "the-odds-api") {
    return fetchTheOddsApiSnapshot({ fixtures, providerConfig, now });
  }

  throw new Error(`Unsupported odds provider mode: ${mode}`);
}

async function fetchTheOddsApiSnapshot({ fixtures, providerConfig, now }) {
  const apiKey = process.env[providerConfig.apiKeyEnv || "ODDS_API_KEY"];

  if (!apiKey) {
    throw new Error(`Missing ${providerConfig.apiKeyEnv || "ODDS_API_KEY"} for odds provider.`);
  }

  const url = new URL(`${providerConfig.baseUrl || "https://api.the-odds-api.com/v4"}/sports/${providerConfig.sportKey}/odds`);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("regions", (providerConfig.regions || ["uk"]).join(","));
  url.searchParams.set("markets", (providerConfig.markets || ["h2h"]).join(","));
  url.searchParams.set("oddsFormat", providerConfig.oddsFormat || "decimal");

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Odds provider failed: ${response.status} ${response.statusText}`);
  }

  const events = await response.json();
  const fixtureIndex = new Map(fixtures.map((fixture) => [fixtureKey(fixture.homeTeam, fixture.awayTeam), fixture]));
  const records = [];
  const capturedAt = now.toISOString();

  for (const event of Array.isArray(events) ? events : []) {
    const fixture = fixtureIndex.get(fixtureKey(event.home_team, event.away_team)) || matchFixtureByTeams(fixtures, event.home_team, event.away_team);

    if (!fixture) {
      continue;
    }

    for (const bookmaker of event.bookmakers || []) {
      for (const market of bookmaker.markets || []) {
        if (!isSupportedOddsApiMarket(market.key)) {
          continue;
        }

        for (const outcome of market.outcomes || []) {
          const mapped = mapOutcome(outcome.name, market.key, fixture);

          if (!mapped) {
            continue;
          }

          records.push({
            id: makeId("odds", [capturedAt, bookmaker.key || bookmaker.title, fixture.id, mapped.market, mapped.outcome]),
            capturedAt,
            provider: "the-odds-api",
            bookmaker: bookmaker.title || bookmaker.key,
            fixtureId: fixture.id,
            fixtureDate: fixture.date || event.commence_time,
            homeTeam: fixture.homeTeam,
            awayTeam: fixture.awayTeam,
            market: mapped.market,
            outcome: mapped.outcome,
            decimalOdds: Number(outcome.price)
          });
        }
      }
    }
  }

  return records;
}

function isSupportedOddsApiMarket(value) {
  return ["h2h", "totals", "btts"].includes(value);
}

function mapOutcome(name, providerMarket, fixture) {
  if (providerMarket === "totals") {
    if (/^over/i.test(name)) {
      return { market: "over_2_5_goals", outcome: "Over" };
    }

    if (/^under/i.test(name)) {
      return { market: "under_2_5_goals", outcome: "Under" };
    }

    return null;
  }

  if (providerMarket === "btts") {
    if (/^yes/i.test(name)) {
      return { market: "both_teams_to_score", outcome: "Yes" };
    }

    if (/^no/i.test(name)) {
      return { market: "both_teams_to_score", outcome: "No" };
    }

    return null;
  }

  if (providerMarket === "h2h") {
    if (/^draw$/i.test(name)) {
      return { market: "match_winner", outcome: "Draw" };
    }

    if (normalizeName(name) === normalizeName(fixture.homeTeam)) {
      return { market: "match_winner", outcome: fixture.homeTeam };
    }

    if (normalizeName(name) === normalizeName(fixture.awayTeam)) {
      return { market: "match_winner", outcome: fixture.awayTeam };
    }
  }

  return null;
}

function fixtureKey(homeTeam, awayTeam) {
  return `${normalizeName(homeTeam)}|${normalizeName(awayTeam)}`;
}

function matchFixtureByTeams(fixtures, homeTeam, awayTeam) {
  const home = normalizeName(homeTeam);
  const away = normalizeName(awayTeam);

  return fixtures.find((fixture) => {
    const fixtureTeams = new Set([normalizeName(fixture.homeTeam), normalizeName(fixture.awayTeam)]);
    return fixtureTeams.has(home) && fixtureTeams.has(away);
  });
}
