# Data Providers

WorldCupMagik uses public web gathering only. It does not use odds APIs, news APIs, stats APIs, private feeds, paywall bypassing, or logged-in scraping.

## Fixtures

`src/providers/fixtures-provider.mjs` reads `config/fixture-sources.json`.

It fetches configured public fixture pages, extracts JSON-LD sports events when available, then falls back to team-v-team text patterns. Records are written with `sourceType: "public-web"`.

## Odds

`src/providers/odds-provider.mjs` reads `config/odds-sources.json`.

The primary shape is public match pages with JSON-LD `SportsEvent.offers`, such as:

- match winner;
- draw;
- draw no bet;
- over/under 2.5 goals;
- both teams to score.
- anytime scorer, when public player-scorer prices are exposed.

When a fixture provides a public match URL, the scanner fetches that match page directly and stores every supported bookmaker price it can parse. No missing odds are invented.

The current OnlyOdds World Cup match pages expose match result, over/under 2.5, and both-teams-to-score prices. They do not yet expose anytime-scorer prices for the opening fixture, so scorer legs will stay absent until a configured public source provides real player odds.

## News

`src/providers/news-provider.mjs` reads `config/news-sources.json`.

It downloads public RSS, Atom, and HTML pages, extracts article links/snippets, follows a bounded number of public article URLs, and classifies local text for:

- injuries and suspensions;
- lineup clarity;
- tactical fit;
- morale;
- rotation risk.

## Stats, Form, And Scorers

`src/providers/stats-provider.mjs` gathers recent national-team result rows from public pages, especially national-team results pages with completed match tables. It derives team form from completed matches only.

The target window is now 20 completed matches per team. The provider stores:

- long-form 20-match points, goals, estimated xG, shots, shots on target, possession, BTTS rate, over-2.5 rate, clean-sheet rate, and failed-to-score rate;
- short-form six-match momentum separately, so the engine sees current form without letting three unusual results dominate;
- public scorer rows when a source exposes them, written into `data/player-stats.json`.

When raw advanced stats are not available on a public row, the provider uses conservative score-derived estimates for xG, shots, shots on target, and possession, marks those fields as derived, and lowers/limits `statsCompleteness`. It does not label derived fields as captured event data.

The betting model uses odds as market intelligence, not as an enemy signal. Match-winner, BTTS, and totals probabilities are blended with bookmaker consensus at a capped weight, while news, squad depth, heat, long-form team history, and odds movement can still move the model away from a plain favourite pick.

## Venue Weather And Heat

`src/providers/weather-provider.mjs` reads `config/weather-sources.json`.

It gathers public host-city forecast pages and extracts forecast summary windows for the selected fixture dates. The scoring engine uses venue, local kickoff hour, humidity estimate, heat index, roof factor, and conservative team heat-adaptation priors.

When a future fixture has no fresh forecast row yet, the heat model falls back to a low-confidence host-climate baseline from `config/weather-sources.json` and the built-in host climate table. That keeps Miami/Houston/Monterrey-style heat from being treated as neutral while still allowing live public weather to replace the fallback as soon as it is collected.

Heat is deliberately capped as a small model edge: it can nudge result probability and expected goals, but it cannot dominate odds, team quality, form, news, or market movement.

The heat layer also reads:

- `config/team-climate-profiles.json` for dry-heat, humid-heat, temperate, and altitude familiarity by team;
- `config/world-cup-climate-history.json` for stable historical World Cup climate memory by team and confederation;
- `data/squad-depth.json` for the latest squad-depth records.

Those signals are combined when either a fresh venue weather record or a low-confidence host-climate fallback exists. Squad depth can slightly cushion the expected-goals drag in heat, but it cannot turn heat into a goal boost.

Every scan reports 20-match team-sample coverage and historical heat-memory coverage in `dataQuality`. A scan is not marked ready unless every selected team has a full 20-match sample.

## Squad Depth

`src/providers/squad-provider.mjs` reads `config/squad-sources.json` and `config/squad-depth-profiles.json`.

It fetches public squad/team pages, especially national-team pages, and looks for public player, club, top-league, and elite-club signals. It blends those public signals with conservative depth priors and writes one record per team to `data/squad-depth.json`.

If a public squad page is missing, empty, or too thin, the scanner records that in source health and uses the conservative prior. It does not invent players, clubs, or squad lists.

## Source Health

Every scan writes:

- `data/source-health-latest.json`
- `data/source-health.json`

Each source records `ok`, `empty`, or `error`, plus record count and reason. This is the guardrail that stops the engine from silently skipping data or filling gaps with fake records.

## Adding Sources

Add new public URLs in the config files first. The providers are deliberately generic, so most improvements should be source-list and alias changes rather than code changes.
