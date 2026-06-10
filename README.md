# WorldCupMagik

WorldCupMagik is a hosted World Cup betting research engine for browsers and Chromebooks. It gathers public web data, builds a shared database several times per day, then publishes a static web app that rebuilds the betslip instantly from that database.

It is decision support only. It does not place bets, does not guarantee returns, and should be used with normal legal, age, affordability, and responsible-gambling checks.

## What It Does

- Gathers public World Cup fixtures from configurable HTML pages.
- Gathers public odds from bookmaker/comparison pages without odds APIs.
- Gathers public football news from RSS/Atom/HTML pages without news APIs.
- Gathers up to 20 recent national-team results per team, stores long-form/short-form trends, and records public scorer rows when available.
- Stores source health for every scan so blocked or empty sources are visible.
- Auto-settles previously recommended legs from completed public match-history rows and feeds those results into outcome learning.
- Tracks calibration by market, risk tag, and confidence band so future scans can gently cool or lift patterns that are over/under-performing.
- Scores Single, Double, Trixie, 3-leg accumulator, 4-leg accumulator, 5-leg accumulator, 6-leg accumulator, and 8-leg accumulator categories.
- Uses risk-slider policy to trade confidence, edge, price, bookmaker coverage, calculated-risk appetite, and accumulator correlation.
- Applies long-slip correlation control so eight-leg style slips are not overloaded with the same market family, repeated team exposure, same-day clusters, heat-sensitive legs, or scorer punts.
- Supports match winner, draw no bet, both teams to score, over/under 2.5 goals, and anytime scorer when public scorer prices are available.
- Adds scorer starter/minutes-style context when anytime-scorer prices and public scorer memory are available.

## Hosted Web Edition

The production app lives in `web/` and is deployed by `.github/workflows/worldcupmagic.yml`.

The scheduled job currently runs at:

```text
05:23, 08:23, 11:23, 14:23, 17:23, 20:23, and 23:23 UTC
```

Each run writes `web/data/latest.json` with:

- collection duration;
- source-health summary;
- fixture, odds, news, team-form, player-scorer, and intelligence counts;
- outcome-learning and calibration summaries;
- pre-scored profiles for days-ahead values `0` to `14`;
- pre-scored profiles for risk values `0` to `100` in `5` point steps.

Scheduled and manual production runs also commit the refreshed `data/` history and `web/data` output back to `main`. That is how odds movement, source health, market memory, and team intelligence compound across the tournament instead of resetting on every deployment.

The web app loads the newest published database and recalculates stake/return locally. The expensive public-web gathering happens in the scheduled server-side run, not in each visitor's browser.

## Commands

```powershell
cd C:\CodexWorkspace\WorldCupMagik
npm install
npm test
npm run web:build-data
```

Useful scripts:

```powershell
npm run web:build-data # gather public data and build web/data/latest.json
npm run daily          # CLI collection + analysis cycle
npm run snapshot       # collect odds/news/stats only
npm run analyse        # build bets from existing public data
npm run offers         # rank configured bookmaker offers
npm run status         # show latest engine state
npm test               # run unit tests
```

## No API Rule

WorldCupMagik does not use odds APIs, news APIs, or stats APIs. Provider config lives in:

- `config/fixture-sources.json`
- `config/odds-sources.json`
- `config/news-sources.json`
- `config/providers.json`

If a public source blocks the scanner or returns no useful rows, the scan records that in `data/source-health-latest.json` and does not fill the gap with made-up data.

## Hosting Choice

For now GitHub Pages plus GitHub Actions is the best free fit because the scanner needs a real Node runner for public-web gathering. Cloudflare Workers/Pages and Netlify are possible later, but free edge/serverless limits are usually tighter for long collection jobs. The built dataset records `collection.durationSeconds`, so we can judge whether the schedule is too aggressive after real runs.

`FutureTrade` remains completely separate. WorldCupMagik has its own package, scripts, config, data, and tests under `C:\CodexWorkspace\WorldCupMagik`.
