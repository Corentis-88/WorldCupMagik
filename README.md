# WorldCupMagic

WorldCupMagic is a World Cup betting research engine. It collects odds snapshots, news signals, team and player context, then ranks doubles, Trixies, and accumulators with transparent logic.

It is decision support only. It does not place bets, it does not guarantee returns, and bookmaker selection must be checked against the user's legal jurisdiction, age, affordability, and responsible gambling controls.

## What It Does

- Saves daily odds snapshots from the configured start date.
- Scores team, fixture, news, and odds movement signals.
- Builds doubles, Trixies, and accumulators without blindly stacking bookmaker favourites.
- Ranks bookmaker offers using value, terms, jurisdiction, expiry, and market coverage.
- Writes auditable JSON outputs and a Markdown daily report.

## Quick Start

```powershell
cd C:\CodexWorkspace\WorldCupMagik
npm install
npm test
npm run app
npm run daily
```

The first version uses mock providers so the engine can be tested immediately.

## Commands

```powershell
npm run app         # open the Windows desktop app in development
npm run dist:win    # build a Windows NSIS setup program
npm run web:build-data # build Chromebook/GitHub Pages data
npm run daily       # full collection and recommendation cycle
npm run snapshot    # collect odds/news/stats only
npm run analyse     # build bets from existing data
npm run offers      # rank configured bookmaker offers
npm run status      # show latest engine state
npm test            # run unit tests
```

## Windows App

The Electron app includes:

- a `Scan` button;
- total stake input;
- number of betslip recommendations input;
- risk slider;
- days-ahead slider;
- local scan history;
- system tray menu with `Open`, `Scan now`, and `Quit`;
- automatic background scans at roughly `08:00`, `14:00`, and `20:00` local time while the app is running.

Installed app data is written to the user's Windows app-data directory, not the installation directory.

## Daily Odds Snapshots

`config/engine-policy.json` sets `snapshotStartDate` to `2026-06-04`, so odds history is configured to build from that date onward.

On Windows, create a scheduled task with:

```powershell
.\scripts\install-windows-schedule.ps1
```

The desktop app also performs three low-impact scans per day while it is open or in the tray.

## Chromebook / Web Edition

Chromebooks cannot run the Windows setup program directly. For them, use the GitHub Pages edition in `web/`.

- GitHub Actions runs the same scanner, news classifier, odds movement logic, intelligence memory, risk policy, and portfolio builder used by the Windows app.
- The generated static dataset is published with the web app as `web/data/latest.json`.
- Chromebook users open the GitHub Pages URL, move the sliders, and build a betslip from the latest central scan.
- The hosted scanner prebuilds every days-ahead value from `0` to `14` and every risk value from `0` to `100` in `5` point steps, so the risk slider is backed by real scored profiles rather than a tiny mock set.
- The web edition can be installed as a PWA-style shortcut and caches the latest app shell.
- The web edition cannot use a Windows tray or private local background service; that remains a Windows app feature. Its intelligence comes from the shared GitHub scan instead of a personal local scan.

The workflow in `.github/workflows/worldcupmagic.yml` also builds the Windows setup program. On `v*` release tags it attaches the installer to the GitHub Release, and on scheduled runs it updates the GitHub Pages dataset for Chromebook users.

## Real Data Providers

Edit `config/providers.json`:

- Odds: switch from `mock` to `the-odds-api` and set `ODDS_API_KEY`.
- News: keep `self-gather`; it fetches configured public RSS/Atom/HTML sources directly and classifies the content locally. It does not use news APIs.
- Stats: switch from `mock` to a football stats provider once API credentials and endpoints are chosen.

See `docs/DATA_PROVIDERS.md`.

`FutureTrade` remains completely separate. WorldCupMagic has its own package, scripts, config, data, and tests under `WorldCupMagic/` and does not import or modify FutureTrade files.

## Outputs

- `data/odds-snapshots.json`
- `data/news-articles.json`
- `data/recommendations-latest.json`
- `data/bookmaker-offer-ranking-latest.json`
- `data/daily-report-latest.md`
