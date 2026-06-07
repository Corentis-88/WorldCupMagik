# Data Providers

The project starts with mock providers. That keeps the scoring engine testable before API contracts are chosen.

## Odds

`src/providers/odds-provider.mjs` supports:

- `mock`: generated demo odds.
- `the-odds-api`: generic adapter for The Odds API style responses.

Required config:

```json
{
  "odds": {
    "mode": "the-odds-api",
    "apiKeyEnv": "ODDS_API_KEY",
    "sportKey": "soccer_fifa_world_cup",
    "regions": ["uk"],
    "markets": ["h2h", "totals", "btts"],
    "oddsFormat": "decimal"
  }
}
```

Check the provider's current sports key before going live, because sports keys and tournament coverage can change.

## News

`src/providers/news-provider.mjs` supports:

- `mock`: generated demo article signals.
- `self-gather`: direct fetching from configured public RSS, Atom, and HTML source pages.

WorldCupMagic does not use news APIs. The self-gatherer reads `config/news-sources.json`, downloads public source pages, extracts links/titles/snippets, optionally follows a limited number of article links, and classifies the text locally.

Rules:

- no paywall bypass;
- no logged-in scraping;
- no private or restricted sources;
- source URLs stay user-configurable;
- failed sources are skipped and reported by the run output.

## Stats

`src/providers/stats-provider.mjs` currently supports:

- `mock`: local team stats in `data/team-stats.json`.
- `file`: local JSON stats supplied by the user or another collector.

For live tournament use, add a provider for Opta, StatsBomb, API-Football, Sportradar, or another licensed football data source. The important fields are:

- recent form;
- expected goals for and against;
- shots for and against;
- set-piece strength;
- transition threat;
- pressing intensity;
- goalkeeper form;
- injuries and suspensions;
- likely rotation;
- player availability.

## Bookmaker Offers

The offer ranking reads `data/bookmaker-offers.json`. Use live verified offer data before opening an account. The engine scores offer quality, but account creation still needs manual checks:

- regional legality;
- age eligibility;
- affordability;
- wagering requirements;
- minimum odds;
- expiry;
- withdrawal restrictions;
- responsible gambling tools.
