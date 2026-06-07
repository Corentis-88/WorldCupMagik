import { makeId } from "../utils.mjs";

const bookies = ["DemoBook Balanced", "DemoBook Local", "DemoBook Flashy"];

const baseOdds = {
  "demo-eng-bra": {
    match_winner: { England: 2.72, Draw: 3.28, Brazil: 2.63 },
    draw_no_bet: { England: 1.95, Brazil: 1.88 },
    both_teams_to_score: { Yes: 1.76, No: 2.02 },
    over_2_5_goals: { Over: 1.94 },
    under_2_5_goals: { Under: 1.87 }
  },
  "demo-fra-can": {
    match_winner: { France: 1.45, Draw: 4.3, Canada: 7.2 },
    draw_no_bet: { France: 1.16, Canada: 5.2 },
    both_teams_to_score: { Yes: 2.04, No: 1.72 },
    over_2_5_goals: { Over: 1.84 },
    under_2_5_goals: { Under: 1.96 }
  },
  "demo-arg-jpn": {
    match_winner: { Argentina: 1.72, Draw: 3.75, Japan: 4.9 },
    draw_no_bet: { Argentina: 1.31, Japan: 3.45 },
    both_teams_to_score: { Yes: 1.98, No: 1.78 },
    over_2_5_goals: { Over: 2.06 },
    under_2_5_goals: { Under: 1.74 }
  },
  "demo-mar-mex": {
    match_winner: { Morocco: 2.48, Draw: 3.04, Mexico: 3.05 },
    draw_no_bet: { Morocco: 1.73, Mexico: 2.12 },
    both_teams_to_score: { Yes: 2.08, No: 1.7 },
    over_2_5_goals: { Over: 2.32 },
    under_2_5_goals: { Under: 1.58 }
  }
};

export function buildMockOdds(fixtures, now = new Date()) {
  const capturedAt = now.toISOString();
  const records = [];

  for (const fixture of fixtures) {
    const fixtureOdds = baseOdds[fixture.id] || buildFallbackFixtureOdds(fixture);

    for (const [market, outcomes] of Object.entries(fixtureOdds)) {
      for (const [outcome, decimalOdds] of Object.entries(outcomes)) {
        bookies.forEach((bookmaker, index) => {
          const adjustment = 1 + ((index - 1) * 0.018);
          const adjustedOdds = Math.max(1.02, Number((decimalOdds * adjustment).toFixed(2)));

          records.push({
            id: makeId("odds", [capturedAt, bookmaker, fixture.id, market, outcome]),
            capturedAt,
            provider: "mock",
            bookmaker,
            fixtureId: fixture.id,
            fixtureDate: fixture.date,
            homeTeam: fixture.homeTeam,
            awayTeam: fixture.awayTeam,
            market,
            outcome,
            decimalOdds: adjustedOdds
          });
        });
      }
    }
  }

  return records;
}

export function buildMockNews(fixtures, now = new Date()) {
  const teams = [...new Set(fixtures.flatMap((fixture) => [fixture.homeTeam, fixture.awayTeam]))];
  const publishedAt = now.toISOString();

  return teams.flatMap((team, index) => {
    const positive = index % 3 !== 1;
    const injury = index % 5 === 0;
    const title = positive
      ? `${team} training report points to settled World Cup shape`
      : `${team} selection questions remain before World Cup opener`;
    const description = injury
      ? `${team} have a minor injury concern but tactical preparation is said to be stable.`
      : `${team} sources describe strong preparation, likely starters, and a clear tactical plan.`;

    return [{
      id: makeId("news", [publishedAt, team, title]),
      createdAt: publishedAt,
      publishedAt,
      provider: "mock",
      source: positive ? "Demo Sports Desk" : "Demo Wire",
      url: `https://example.com/world-cup/${team.toLowerCase().replace(/\s+/g, "-")}`,
      title,
      description,
      teamTags: [team],
      playerTags: [],
      sentiment: positive ? 0.38 : -0.16,
      signals: {
        injury: injury ? 0.35 : 0.05,
        lineupClarity: positive ? 0.72 : 0.42,
        tacticalFit: positive ? 0.65 : 0.45,
        morale: positive ? 0.66 : 0.43,
        rotationRisk: positive ? 0.18 : 0.38
      },
      sourceReliability: positive ? 0.66 : 0.58
    }];
  });
}

function buildFallbackFixtureOdds(fixture) {
  return {
    match_winner: { [fixture.homeTeam]: 2.42, Draw: 3.2, [fixture.awayTeam]: 2.88 },
    draw_no_bet: { [fixture.homeTeam]: 1.72, [fixture.awayTeam]: 2.02 },
    both_teams_to_score: { Yes: 1.92, No: 1.84 },
    over_2_5_goals: { Over: 2.02 },
    under_2_5_goals: { Under: 1.76 }
  };
}
