export function buildDailyReport({ recommendations, offerRanking, legCandidates, run, policy }) {
  const lines = [];
  lines.push("# WorldCupMagic Daily Report");
  lines.push("");
  lines.push(`Created: ${run.createdAt}`);
  lines.push(`Region: ${policy.region || policy.bookmakerOfferPolicy?.region || "unknown"}`);
  lines.push(`Snapshot start date: ${policy.snapshotStartDate}`);
  lines.push("");
  lines.push("This report is betting research only. It does not place bets or guarantee returns.");
  lines.push("");
  lines.push("## Source State");
  lines.push("");
  lines.push(`- Odds records collected this run: ${run.oddsRecordsCollected}`);
  lines.push(`- News records collected this run: ${run.newsRecordsCollected}`);
  lines.push(`- Team stat records available: ${run.teamStatsCount}`);
  lines.push(`- Eligible positive-edge legs: ${recommendations.eligibleLegCount}`);
  lines.push("");
  lines.push("## Top Doubles");
  appendCombos(lines, recommendations.doubles);
  lines.push("");
  lines.push("## Top Trixies");
  appendCombos(lines, recommendations.trixies);
  lines.push("");
  lines.push("## Top Accumulators");
  appendCombos(lines, recommendations.accumulators);
  lines.push("");
  lines.push("## Best Offer Candidates");
  lines.push("");

  if (!offerRanking.length) {
    lines.push("No bookmaker offer passed the policy checks.");
  } else {
    for (const offer of offerRanking.slice(0, 5)) {
      lines.push(`- ${offer.rank}. ${offer.bookmaker}: score ${offer.score}, net promo value ${offer.netPromoValue}. ${offer.thesis}`);
    }
  }

  lines.push("");
  lines.push("## Strongest Single Legs");
  lines.push("");

  for (const leg of legCandidates.filter((item) => !item.hardBlocks.length).slice(0, 10)) {
    lines.push(`- ${leg.selectionLabel}: odds ${leg.decimalOdds} at ${leg.bookmaker}, edge ${Math.round(leg.edge * 10000) / 100}%, confidence ${Math.round(leg.confidence * 1000) / 10}%, ${leg.riskTag}.`);
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function appendCombos(lines, combos) {
  lines.push("");

  if (!combos.length) {
    lines.push("No recommendation passed the current gates.");
    return;
  }

  for (const combo of combos.slice(0, 5)) {
    lines.push(`- ${combo.type} score ${combo.score}, odds ${combo.combinedDecimalOdds}, EV ${Math.round(combo.expectedValue * 10000) / 100}%. ${combo.thesis}`);
  }
}
