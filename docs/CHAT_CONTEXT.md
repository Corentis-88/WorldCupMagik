# WorldCupMagik Chat Context

Saved: 2026-06-11
Source thread: `019e8e29-23fa-7ac1-b891-4342dfe9e013` (`World Cup betting engine`)

This note preserves the useful context from the prior Codex thread so future turns can refer to it from the workspace without needing to recover the chat again.

## Product Goal

WorldCupMagik is a hosted World Cup betting research engine. It should find credible Singles, Doubles, Trixies, and accumulators using real public web data, not guessed fixtures or invented odds.

The engine should avoid boring favourite-only slips. It is meant to take calculated risk when the evidence supports it, using odds, odds movement, news, team form, individual scorer data, tactical/team memory, heat/weather, and post-match learning.

It is decision support only. It does not place bets and does not guarantee returns.

## Data And Hosting Model

- Repo: `C:\CodexWorkspace\WorldCupMagik`
- Remote: `https://github.com/Corentis-88/WorldCupMagik.git`
- Hosted app files live in `web/`.
- GitHub Actions runs the expensive scanner and publishes GitHub Pages.
- The browser does not scrape live odds itself. It loads `web/data/latest.json` and recalculates stake/returns locally.
- Scheduled/manual production runs can persist refreshed `data/` and `web/data` back to `main`; push builds can publish a fresh Pages artifact without necessarily committing generated data.

## Current Automatic Refresh Schedule

The workflow source of truth is `.github/workflows/worldcupmagic.yml`, with data generation mirrored in `scripts/build-web-data.mjs`.

Current scheduled UTC starts:

- `05:23`
- `08:23`
- `11:23`
- `14:23`
- `17:23`
- `20:23`
- `21:23`
- `23:23`

On 2026-06-11 in the UK, this is BST (UTC+1), so the user-facing approximate start times are:

- `06:23`
- `09:23`
- `12:23`
- `15:23`
- `18:23`
- `21:23`
- `22:23`
- `00:23`

GitHub Actions can start a few minutes late, then the scanner/build/deploy can take roughly 30-45 minutes. So the page does not update exactly at midnight; the nearest after-midnight scheduled run is about `00:23` UK time, and the live page changes after that run finishes and Pages publishes.

## Relevant Recent Work

- Commit `1bfa869`: improved survivability markets and late-kickoff guard; deployment finished successfully.
- Commit `090a026`: added the `Likely Goalscorers Today` section below Picks of the Day.
- Follow-up fix: the browser scorer panel should use first-goalscorer probabilities directly when first-scorer prices exist, dedupe surname/full-name variants, and apply the lightweight lineup adjustment file when confirmed lineups are available.

## Likely Goalscorers Today Behavior

The new section is in:

- `web/index.html`
- `web/app.js`
- `web/styles.css`

It renders below `PICKS OF THE DAY - THE MOST LIKELY TO WIN IN YOUR DATE RANGE`.

It is intentionally independent of the user's selected date range. It only uses fixtures whose `dateKey` equals the browser's local date.

If there are no World Cup fixtures listed for today's local date, it shows a waiting card:

`No World Cup fixtures are listed for today in the current database.`

It ranks up to 4 likely scorers per game using first-goalscorer chances when first-scorer prices are available, otherwise a fallback from scorer odds, team expected goals, and 20-match player scoring memory.

The lightweight lineup workflow writes `web/data/lineups-latest.json`. The browser treats it as optional. When confirmed starters exist for a fixture, confirmed non-starters should be dropped from the visible top four.

Known first-scorer context from the prior chat:

- Raul Jimenez: `15.24%`
- Julian Quinones: `10.15%`
- Lyle Foster: `9.53%`
- Alvaro Fidalgo: `5.82%`

Bench/lineup insight from the prior chat: if Santiago Gimenez is benched, raw bookie first-scorer odds should be heavily downgraded. The engine should not blindly trust stale scorer markets.

## Current User Question Context

The user checked Chrome and saw nothing below Picks of the Day. Likely causes:

- The new commit may not have finished deploying yet, so Chrome is still showing the previous GitHub Pages build.
- If the new section has deployed but has no rows, the current generated database may have no fixtures dated today in the browser's local date.
- The next automatic refresh is not exactly midnight UK time; in BST the after-midnight scheduled run starts around `00:23`, then the live page updates after the GitHub Action and Pages deployment finish.
