# Event Market Expansion Plan

World Cup Magik should work backwards from markets that can be placed across normal UK bookmakers, then only show confident event picks when the public-web evidence is strong enough.

## Scope

Supported bottom-of-UI event sections:

- Player 1+ shot on target
- Player to be carded
- Penalty awarded: Yes / No
- Red card in match: Yes / No

These markets are collected and displayed as event intelligence first. They are not promoted into the main accumulator engine until coverage, settlement, and performance learning are strong enough.

## Data Rules

- No APIs.
- Use public bookmaker/comparison pages, public fixture pages, public lineup pages, and public boxscores.
- Prefer markets that are common across bookmakers.
- Treat bookmaker-specific markets as supporting evidence only.
- Keep player-event picks lineup-sensitive and re-filter when confirmed XIs arrive.

## Collection Plan

1. Extend public odds extraction for cross-bookmaker event markets.
2. Enrich post-match tournament records with cards, red cards, and penalty events when public boxscores expose them.
3. Use team/player/tournament evidence as a fallback when odds are absent.
4. Track market counts so the UI can show whether the pick is price-backed or model-backed.
5. Keep these event markets collect-only until enough settled history exists.

## Lineup Reliability Plan

- Run the lightweight lineup workflow every 5 minutes.
- Keep the normal pre-kickoff window, plus an explicit final pass at 28 minutes before kickoff with a 4-minute tolerance.
- Never allow a newer predicted lineup to overwrite an older confirmed lineup.
- Keep non-group fixtures in the lineup scanner.
- Poll the published lineup feed every 30 seconds in both desktop and mobile near kickoff.

## UI Plan

Add split sections at the bottom of desktop and mobile:

- Player Shots On Target Today
- Most Likely Players To Be Carded Today
- Penalty Awarded Today
- Red Card Today

Each section shows fixture-level percentages and a short source/reason string. Player sections apply the same lineup adjustment logic as goalscorer and assist sections.

## Next Gate

Before these event markets enter actual suggested betslips, the app should have:

- Event odds from at least two public sources or one highly reliable source.
- Post-match settlement support for the market.
- Prediction-vs-result learning by market.
- Positive or neutral settled performance after sample-size checks.
