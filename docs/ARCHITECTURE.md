# Architecture

WorldCupMagic is split into five lanes:

1. Collection
   - Odds snapshots.
   - News articles and extracted signals.
   - Team 20-match history, fixture, and player-scorer statistics.
   - Venue weather and heat snapshots.
   - Squad-depth records from public squad/team pages plus conservative priors.
   - Bookmaker offers and terms.

2. Evidence Quality
   - Source reliability checks.
   - Stale data checks.
   - Contradiction and uncertainty flags.

3. Leg Scoring
   - Model probability.
   - Implied probability and capped consensus probability from best available odds.
   - Edge, confidence, odds movement, 20-match form, scorer signals, news impact, style matchup, and heat impact.
   - Heat impact combines venue weather, team climate familiarity, historical World Cup climate memory, and squad depth.
   - Favourite-crowding penalty so the system does not simply parlay obvious favourites.

4. Bet Construction
   - Doubles: two independent positive-edge legs.
   - Trixies: three legs with three doubles and one treble, requiring at least one calculated-risk/value leg.
   - Accumulators: three to five legs, capped by combined odds, correlation, and favourite concentration.

5. Reporting
   - JSON run records for audit.
   - Markdown report with the top ranked recommendations and the logic behind each one.

## Why This Shape

The engine needs to be explainable. Betting decisions become dangerous when a model hides its inputs, so every recommendation includes:

- selected legs;
- best odds and bookmaker;
- model probability;
- implied probability;
- edge;
- confidence;
- risk tag;
- reasoning notes;
- data freshness.

## Non-Goals

- No automatic bet placement.
- No guarantee of profit.
- No advice to evade regional betting restrictions.
- No scraping behind paywalls or violating bookmaker terms.
