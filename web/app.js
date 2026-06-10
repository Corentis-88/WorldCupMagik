const state = {
  data: null
};
const standardSlip = [
  ["single", "Single"],
  ["double", "Double"],
  ["trixie", "Trixie"],
  ["accumulator_3", "3-leg accumulator"],
  ["accumulator_4", "4-leg accumulator"],
  ["accumulator_5", "5-leg accumulator"],
  ["accumulator_6", "6-leg accumulator"],
  ["accumulator_8", "8-leg accumulator"]
];
const pickOfDaySlip = [
  ["single", "Single"],
  ["double", "Double"],
  ["trixie", "Trixie"],
  ["accumulator_4", "4-leg accumulator"],
  ["accumulator_8", "8-leg accumulator"]
];
const defaultGatheringSchedule = {
  automaticRunMinutesUtc: [323, 503, 683, 863, 1043, 1223, 1403],
  gatheringWindowMinutes: 5,
  gatheringMessage: "Data Gathering: Come back in 5"
};
const usageInstructions = "1. Input stake per bet 2. Choose Date From 3. Choose Date To 4. Adjust risk slider 5. We add our secret sauce and some luck, we don't just go by the bookies! Enjoy!";

const el = {
  scanStamp: document.getElementById("scanStamp"),
  gatheringNotice: document.getElementById("gatheringNotice"),
  stake: document.getElementById("stakeInput"),
  dateFrom: document.getElementById("dateFromInput"),
  dateTo: document.getElementById("dateToInput"),
  risk: document.getElementById("riskInput"),
  riskValue: document.getElementById("riskValue"),
  engineNotes: document.getElementById("engineNotes"),
  fixtureCount: document.getElementById("fixtureCount"),
  edgeCount: document.getElementById("edgeCount"),
  memoryCount: document.getElementById("memoryCount"),
  returnTotal: document.getElementById("returnTotal"),
  marketLine: document.getElementById("marketLine"),
  betslip: document.getElementById("betslipList"),
  pickOfDay: document.getElementById("pickOfDayList")
};

for (const input of [el.stake, el.dateFrom, el.dateTo, el.risk]) {
  input.addEventListener("input", render);
}

loadData();
registerServiceWorker();

async function loadData() {
  el.scanStamp.textContent = "Loading latest database...";

  try {
    const response = await fetch(`./data/latest.json?v=${Date.now()}`);
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    state.data = await response.json();
    initialiseDateInputs();
    render();
  } catch (error) {
    el.scanStamp.textContent = `No generated database yet: ${error.message}`;
    el.betslip.innerHTML = `<article class="bet-card">Run <strong>npm run web:build-data</strong> locally or let GitHub Actions publish the latest database.</article>`;
  }
}

function render() {
  if (!state.data) {
    return;
  }

  const risk = Number(el.risk.value);
  const stake = Number(el.stake.value || 10);
  const riskBucket = nearest(state.data.riskBuckets, risk);
  const dateRange = selectedDateRange();
  const profile = buildRangeProfile({ data: state.data, riskBucket, dateRange });
  const gathering = automaticGatheringState(state.data);
  const stakePerBet = round(stake, 2);
  const slip = (profile?.betslip || []).map((bet) => ({
    ...bet,
    stake: stakePerBet,
    potentialReturn: recalculateReturn(bet, stakePerBet)
  }));
  const pickProfile = buildPickOfDayRangeProfile({ data: state.data, dateRange }) || null;
  const pickSlip = (pickProfile?.betslip || []).map((bet) => ({
    ...bet,
    stake: stakePerBet,
    potentialReturn: recalculateReturn(bet, stakePerBet)
  }));

  el.riskValue.textContent = risk;
  el.scanStamp.textContent = gathering.active ? gathering.message : `Latest database: ${new Date(state.data.generatedAt).toLocaleString()} | build time ${state.data.collection?.totalBuildDurationSeconds || state.data.collection?.durationSeconds || "?"}s`;
  el.gatheringNotice.hidden = !gathering.active;
  el.gatheringNotice.textContent = gathering.message;
  el.engineNotes.textContent = usageInstructions;
  el.fixtureCount.textContent = `${profile?.fixtureCount || 0} games`;
  el.edgeCount.textContent = `${profile?.eligibleLegCount || 0}`;
  el.memoryCount.textContent = `${state.data.intelligence?.teamCount || 0}`;
  el.returnTotal.textContent = money(slip.reduce((total, bet) => total + Number(bet.potentialReturn || 0), 0));
  if (el.marketLine) {
    el.marketLine.textContent = marketLine(state.data);
  }
  renderSlip(slip, profile);
  renderPickOfDay(pickSlip, pickProfile || profile);
}

function initialiseDateInputs() {
  const range = state.data?.dateRange || fallbackDateRange();

  for (const input of [el.dateFrom, el.dateTo]) {
    input.min = range.min || "";
    input.max = range.max || "";
  }

  if (!el.dateFrom.value) {
    el.dateFrom.value = range.defaultFrom || range.min || "";
  }

  if (!el.dateTo.value) {
    el.dateTo.value = range.defaultTo || range.max || el.dateFrom.value || "";
  }
}

function selectedDateRange() {
  const fallback = state.data?.dateRange || fallbackDateRange();
  let from = el.dateFrom.value || fallback.defaultFrom || fallback.min;
  let to = el.dateTo.value || fallback.defaultTo || fallback.max || from;

  if (from && to && from > to) {
    [from, to] = [to, from];
  }

  return { from, to };
}

function fallbackDateRange() {
  const today = new Date().toISOString().slice(0, 10);

  return {
    min: today,
    max: today,
    defaultFrom: today,
    defaultTo: today
  };
}

function buildRangeProfile({ data, riskBucket, dateRange }) {
  if (!data.legCandidatesByRisk) {
    const fallbackRisk = nearest(data.riskBuckets || [riskBucket], riskBucket);
    const fallbackDay = nearest(data.dayBuckets || [14], 14);
    return data.profiles?.[`d${fallbackDay}_r${fallbackRisk}`] || Object.values(data.profiles || {})[0] || null;
  }

  const fixtures = fixturesInRange(data.fixtures || [], dateRange);
  const fixtureIds = new Set(fixtures.map((fixture) => fixture.id));
  const candidates = (data.legCandidatesByRisk[riskBucket] || [])
    .filter((leg) => fixtureIds.has(leg.fixtureId));
  const policy = { riskProfile: data.riskProfiles?.[riskBucket] || {} };
  const recommendations = buildBetRecommendations(candidates, policy);

  return {
    dateFrom: dateRange.from,
    dateTo: dateRange.to,
    risk: riskBucket,
    dataQuality: data.collection?.dataQuality,
    fixtureCount: fixtures.length,
    eligibleLegCount: recommendations.eligibleLegCount,
    betslip: selectRangeBetslip({ recommendations, risk: riskBucket })
  };
}

function buildPickOfDayRangeProfile({ data, dateRange }) {
  const fixtures = fixturesInRange(data.fixtures || [], dateRange);
  const fixtureIds = new Set(fixtures.map((fixture) => fixture.id));
  const candidates = (data.mostLikelyLegCandidates || [])
    .filter((leg) => fixtureIds.has(leg.fixtureId));

  return {
    dateFrom: dateRange.from,
    dateTo: dateRange.to,
    mode: "most_likely",
    dataQuality: data.collection?.dataQuality,
    fixtureCount: fixtures.length,
    eligibleLegCount: candidates.length,
    betslip: buildMostLikelyPicks(candidates, { fixtureCount: fixtures.length })
  };
}

function fixturesInRange(fixtures, dateRange) {
  return fixtures.filter((fixture) => {
    const key = fixture.dateKey || dateKey(fixture.date);
    return key >= dateRange.from && key <= dateRange.to;
  });
}

function renderSlip(slip, profile) {
  if (!slip.length) {
    el.betslip.innerHTML = standardSlip.map(([, label]) => unavailableCard(label, profile)).join("");
    return;
  }

  const present = new Set(slip.map(categoryForBet));
  const missingCards = standardSlip
    .filter(([key]) => !present.has(key))
    .map(([, label]) => unavailableCard(label, profile));

  el.betslip.innerHTML = slip.map((bet) => `
    <article class="bet-card">
      <header>
        <span class="tag">${escapeHtml(bet.label || bet.type)}</span>
        <span class="score">${escapeHtml(confidenceLabel(bet))}</span>
      </header>
      <ul class="legs">
        ${bet.legs.map((leg) => `
          <li>
            ${escapeHtml(leg.selectionLabel)} <strong>@ ${Number(leg.decimalOdds || 0).toFixed(2)}</strong>
            <span class="leg-note">${escapeHtml(formatLegNote(leg))}</span>
          </li>
        `).join("")}
      </ul>
      <p class="why">${escapeHtml(bet.thesis || "The shared model found enough value, confidence, and fixture separation for this slip.")}</p>
      <div class="bet-meta">
        <div><span>Odds</span><strong>${Number(bet.combinedDecimalOdds || 0).toFixed(2)}</strong></div>
        <div><span>Stake</span><strong>${money(bet.stake)}</strong></div>
        <div><span>Return</span><strong>${money(bet.potentialReturn)}</strong></div>
      </div>
    </article>
  `).concat(missingCards).join("");
}

function renderPickOfDay(slip, profile) {
  if (!el.pickOfDay) {
    return;
  }

  if (!slip.length) {
    const supported = supportedPickOfDaySlip(profile);
    el.pickOfDay.innerHTML = supported.length
      ? supported.map(([, label]) => unavailableCard(label, profile, "No most-likely pick passed the current database checks yet.")).join("")
      : unavailableCard("Picks of the Day", profile, "No matches exist in this selected date range yet.");
    return;
  }

  const present = new Set(slip.map(categoryForBet));
  const missingCards = supportedPickOfDaySlip(profile)
    .filter(([key]) => !present.has(key))
    .map(([, label]) => unavailableCard(label, profile, "Not enough real data passed the most-likely checks for this supported card yet."));

  el.pickOfDay.innerHTML = slip.map((bet) => `
    <article class="bet-card pick-card">
      <header>
        <span class="tag pick-tag">${escapeHtml(bet.label || bet.type)}</span>
        <span class="score">${escapeHtml(likelihoodLabel(bet))}</span>
      </header>
      <ul class="legs">
        ${bet.legs.map((leg) => `
          <li>
            ${escapeHtml(leg.selectionLabel)} <strong>@ ${Number(leg.decimalOdds || 0).toFixed(2)}</strong>
            <span class="leg-note">${escapeHtml(formatLikelyLegNote(leg))}</span>
          </li>
        `).join("")}
      </ul>
      <p class="why">${escapeHtml(bet.thesis || "The most-likely engine ranked this by model probability, confidence, fresh odds, and positive edge.")}</p>
      <div class="bet-meta">
        <div><span>Odds</span><strong>${Number(bet.combinedDecimalOdds || 0).toFixed(2)}</strong></div>
        <div><span>Stake</span><strong>${money(bet.stake)}</strong></div>
        <div><span>Return</span><strong>${money(bet.potentialReturn)}</strong></div>
      </div>
    </article>
  `).concat(missingCards).join("");
}

function unavailableCard(label, profile, prefix = "No real-data pick passed this date/risk profile yet.") {
  const message = profile?.dataQuality?.message || state.data?.collection?.dataQuality?.message || "The database is still collecting public-web source data.";

  return `
    <article class="bet-card unavailable">
      <header>
        <span class="tag">${escapeHtml(label)}</span>
        <span class="score">waiting</span>
      </header>
      <p class="why">${escapeHtml(prefix)} ${escapeHtml(message)}</p>
    </article>
  `;
}

function supportedPickOfDaySlip(profile) {
  const fixtureCount = Number(profile?.fixtureCount || 0);

  return pickOfDaySlip.filter(([key]) => fixtureCount >= legCountForPickCategory(key));
}

function legCountForPickCategory(key) {
  if (key === "single") {
    return 1;
  }
  if (key === "double") {
    return 2;
  }
  if (key === "trixie") {
    return 3;
  }

  return Number(String(key).replace("accumulator_", "")) || 1;
}

function categoryForBet(bet) {
  if (bet.category) {
    return bet.category;
  }

  if (bet.type === "single") {
    return "single";
  }
  if (bet.type === "double") {
    return "double";
  }
  if (bet.type === "trixie") {
    return "trixie";
  }
  if (bet.type === "accumulator") {
    return `accumulator_${bet.legCount}`;
  }

  return bet.type;
}

function buildBetRecommendations(legs, policy) {
  const eligibleLegs = legs
    .filter((leg) => Number(leg.modelProbability || 0) > 0)
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
  const accumulatorsByLegCount = buildAccumulatorRecommendationsByLegCount(eligibleLegs, policy);

  return {
    eligibleLegCount: eligibleLegs.length,
    singles: rankCombos(eligibleLegs.map((leg) => [leg]), "single", policy).slice(0, 12),
    doubles: rankCombos(combinations(eligibleLegs.slice(0, 30), 2, 10000), "double", policy).slice(0, 8),
    trixies: rankCombos(combinations(eligibleLegs.slice(0, 28), 3, 12000), "trixie", policy).slice(0, 8),
    accumulatorsByLegCount,
    accumulators: Object.values(accumulatorsByLegCount).flat().sort((left, right) => right.score - left.score).slice(0, 16)
  };
}

function buildAccumulatorRecommendationsByLegCount(eligibleLegs, policy) {
  const byLegCount = {};

  for (const size of [3, 4, 5, 6, 8]) {
    const pool = eligibleLegs.slice(0, accumulatorPoolSize(size));
    byLegCount[size] = rankCombos(combinations(pool, size, accumulatorCombinationLimit(size)), "accumulator", policy).slice(0, 8);
  }

  return byLegCount;
}

function accumulatorPoolSize(size) {
  if (size >= 8) {
    return 18;
  }

  if (size >= 6) {
    return 22;
  }

  return 28;
}

function accumulatorCombinationLimit(size) {
  if (size >= 8) {
    return 9000;
  }

  if (size >= 6) {
    return 10000;
  }

  return 12000;
}

function fixtureKeyForLeg(leg) {
  const home = normalizeFixtureName(leg.homeTeam);
  const away = normalizeFixtureName(leg.awayTeam);

  if (home && away) {
    return `${home}_vs_${away}`;
  }

  const labelFixture = String(leg.selectionLabel || "").split(":")[0].trim();
  if (labelFixture.toLowerCase().includes(" vs ")) {
    return normalizeFixtureName(labelFixture);
  }

  return leg.fixtureId || leg.id;
}

function normalizeFixtureName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, "_");
}

function rankCombos(combos, type, policy) {
  return combos
    .map((legs) => scoreCombo(legs, type, policy))
    .filter((combo) => combo && !combo.hardBlocks.length)
    .sort((left, right) => right.score - left.score);
}

function scoreCombo(legs, type, policy) {
  const hardBlocks = [];
  const riskProfile = policy.riskProfile || {};
  const appetite = riskAppetiteFromPolicy(policy);
  const fixtureIds = new Set(legs.map(fixtureKeyForLeg));
  const combinedDecimalOdds = product(legs.map((leg) => leg.decimalOdds));
  const combinedProbability = product(legs.map((leg) => leg.modelProbability));
  const survivalProbabilities = legs.map((leg) => likelyWinProbability(leg, { legCount: legs.length }));
  const survivalCombinedProbability = product(survivalProbabilities);
  const averageSurvivalProbability = mean(survivalProbabilities);
  const expectedValue = combinedProbability * combinedDecimalOdds - 1;
  const averageEdge = mean(legs.map((leg) => leg.edge));
  const averageIndependentEdge = mean(legs.map((leg) => leg.independentEdge ?? leg.edge));
  const averageConfidence = mean(legs.map((leg) => leg.confidence));
  const riskLegs = legs.filter((leg) => ["calculated_risk", "longshot_value", "contrarian_value"].includes(leg.riskTag));
  const intelligenceConfidence = mean(legs.map((leg) => leg.components?.intelligenceConfidence || 0.45));
  const averageNonMarketSignalCount = mean(legs.map((leg) => leg.components?.nonMarketSignalCount || 0));
  const marketConfirmedLegs = legs.filter((leg) => leg.riskTag === "market_confirmed_edge");
  const contrarianLegs = legs.filter((leg) => leg.riskTag === "contrarian_value");
  const favouriteLegs = legs.filter((leg) => Number(leg.impliedProbability) >= Number(riskProfile.maxFavoriteImpliedProbability || 0.72));
  const bttsLegCount = legs.filter(isBttsYesLeg).length;
  const fragileLegCount = legs.filter((leg) => riskPortfolioLegPenalty(leg, legs.length, appetite) >= 0.025).length;
  const preferred = preferredOddsRange(type, legs.length, policy);
  const correlation = portfolioCorrelationProfile(legs, { legCount: legs.length, appetite });

  if (fixtureIds.size !== legs.length) {
    hardBlocks.push("same_fixture_correlation");
  }

  if (combinedDecimalOdds < preferred.min || combinedDecimalOdds > preferred.max) {
    hardBlocks.push("combined_odds_outside_policy_range");
  }

  if (combinedDecimalOdds > Number(riskProfile.maxCombinedOdds || 50)) {
    hardBlocks.push("combined_odds_above_absolute_cap");
  }

  if (type === "trixie" && riskLegs.length < Number(riskProfile.minRiskLegsForTrixie || 0)) {
    hardBlocks.push("trixie_missing_calculated_risk_leg");
  }

  if ((type === "trixie" || type === "accumulator") && favouriteLegs.length === legs.length) {
    hardBlocks.push("all_legs_are_high_implied_probability_favourites");
  }

  const oddsFit = oddsFitScore(combinedDecimalOdds, preferred.min, preferred.max);
  const diversityBonus = riskLegs.length > 0 ? Math.min(8, riskLegs.length * 3.5) : -5;
  const evidenceBonus = clamp((averageNonMarketSignalCount - 2) * 3.2, -4, 8);
  const intelligenceBonus = clamp((intelligenceConfidence - 0.5) * 10 + marketConfirmedLegs.length + contrarianLegs.length * 1.5, -5, 9);
  const survivalCombinedMultiplier = type === "single"
    ? 44
    : type === "double"
      ? 78
      : type === "trixie"
        ? 108
        : 150 + legs.length * 13;
  const survivalScore = survivalCombinedProbability * survivalCombinedMultiplier
    + averageSurvivalProbability * (22 + Math.min(legs.length, 8) * 2.5);
  const valueScore = averageEdge * 46
    + averageIndependentEdge * 58
    + clamp(expectedValue * (5 + appetite * 6), -8, 10)
    + oddsFit * 0.65;
  const survivalWeight = 1.08 - appetite * 0.42;
  const valueWeight = 0.72 + appetite * 0.54;
  const portfolioPenalty = riskPortfolioPenalty({ legs, appetite, bttsLegCount, fragileLegCount }) + correlation.penalty;
  const favouritePenalty = favouriteLegs.length * 4;
  const sizePenalty = type === "accumulator" ? Math.max(0, legs.length - 3) * 3 : 0;
  const score = clamp(22
    + survivalScore * survivalWeight
    + valueScore * valueWeight
    + averageConfidence * 16
    + diversityBonus
    + evidenceBonus
    + intelligenceBonus
    - favouritePenalty
    - sizePenalty
    - portfolioPenalty, 0, 100);

  return {
    id: `${type}_${legs.map((leg) => leg.id).join("_").slice(0, 48)}`,
    type,
    legCount: legs.length,
    legs,
    combinedDecimalOdds: round(combinedDecimalOdds, 2),
    combinedProbability: round(combinedProbability, 4),
    expectedValue: round(expectedValue, 4),
    averageEdge: round(averageEdge, 4),
    averageIndependentEdge: round(averageIndependentEdge, 4),
    averageConfidence: round(averageConfidence, 4),
    survivalCombinedProbability: round(survivalCombinedProbability, 4),
    averageSurvivalProbability: round(averageSurvivalProbability, 4),
    displayRating: displayConfidenceRating(legs),
    riskLegCount: riskLegs.length,
    bttsLegCount,
    fragileLegCount,
    averageNonMarketSignalCount: round(averageNonMarketSignalCount, 2),
    correlationPenalty: round(correlation.penalty, 2),
    correlationReasons: correlation.reasons,
    marketFamilyMix: correlation.familyCounts,
    repeatedTeamCount: correlation.repeatedTeamCount,
    sameDateCluster: correlation.sameDateCluster,
    score: round(score, 2),
    hardBlocks,
    thesis: buildComboThesis({ type, legs, combinedDecimalOdds, expectedValue, averageIndependentEdge, averageNonMarketSignalCount, riskLegs, favouriteLegs, survivalCombinedProbability, averageSurvivalProbability, bttsLegCount, fragileLegCount, correlation })
  };
}

function selectRangeBetslip({ recommendations, risk }) {
  return standardSlip
    .map((category) => ({ category, combo: pickCategoryCombo(recommendations, category, risk) }))
    .filter((item) => item.combo)
    .map(({ category, combo }, index) => ({
      id: combo.id,
      rank: index + 1,
      category: category[0],
      label: category[1],
      type: combo.type,
      score: combo.score,
      legCount: combo.legCount,
      combinedDecimalOdds: combo.combinedDecimalOdds,
      combinedProbability: combo.combinedProbability,
      expectedValue: combo.expectedValue,
      averageConfidence: combo.averageConfidence,
      survivalCombinedProbability: combo.survivalCombinedProbability,
      averageSurvivalProbability: combo.averageSurvivalProbability,
      displayRating: combo.displayRating,
      riskLegCount: combo.riskLegCount,
      bttsLegCount: combo.bttsLegCount,
      fragileLegCount: combo.fragileLegCount,
      correlationPenalty: combo.correlationPenalty,
      correlationReasons: combo.correlationReasons,
      marketFamilyMix: combo.marketFamilyMix,
      repeatedTeamCount: combo.repeatedTeamCount,
      sameDateCluster: combo.sameDateCluster,
      legs: combo.legs,
      thesis: combo.thesis
    }));
}

function pickCategoryCombo(recommendations, category, risk = 50) {
  const [key] = category;

  if (key === "single") {
    return bestSingleForRisk(recommendations.singles || [], risk);
  }

  if (key === "double") {
    return bestCombo(recommendations.doubles || []);
  }

  if (key === "trixie") {
    return bestCombo(recommendations.trixies || []);
  }

  const legCount = Number(key.replace("accumulator_", ""));
  return bestCombo(recommendations.accumulatorsByLegCount?.[legCount] || []);
}

function bestSingleForRisk(combos, risk) {
  const appetite = clamp(Number(risk || 0), 0, 100) / 100;
  const targetOdds = 1.48 + appetite * 2.35;
  const targetRisk = appetite * 3;

  return [...combos].sort((left, right) => {
    return singleRiskFit(right, targetOdds, targetRisk, appetite) - singleRiskFit(left, targetOdds, targetRisk, appetite);
  })[0] || null;
}

function singleRiskFit(combo, targetOdds, targetRisk, appetite) {
  const leg = combo.legs?.[0] || {};
  const odds = Number(combo.combinedDecimalOdds || leg.decimalOdds || 1);
  const confidence = Number(combo.averageConfidence || leg.confidence || 0);
  const edge = Number(combo.averageEdge || leg.edge || 0);
  const expectedValue = Number(combo.expectedValue || 0);
  const oddsFit = Math.max(0, 1 - Math.abs(Math.log(Math.max(1.01, odds) / targetOdds)) / 0.78);
  const tagFit = Math.max(0, 1 - Math.abs(riskTagLevel(leg.riskTag) - targetRisk) / 3);
  const lowRiskStability = appetite < 0.38 && ["steady_edge", "value_favourite", "market_confirmed_edge"].includes(leg.riskTag) ? 9 : 0;
  const highRiskPrice = appetite > 0.55 && ["calculated_risk", "longshot_value", "contrarian_value"].includes(leg.riskTag) ? 6 : 0;

  return (Number(combo.score || 0) * 0.1)
    + oddsFit * 42
    + tagFit * 14
    + confidence * (30 - appetite * 8)
    + edge * (18 + appetite * 40)
    + clamp(expectedValue * 8, -6, 12) * appetite
    + lowRiskStability
    + highRiskPrice;
}

function riskTagLevel(tag) {
  if (tag === "value_favourite" || tag === "market_confirmed_edge") {
    return 0.6;
  }

  if (tag === "calculated_risk") {
    return 1.8;
  }

  if (tag === "longshot_value") {
    return 2.6;
  }

  if (tag === "contrarian_value") {
    return 3;
  }

  return 0;
}

function bestCombo(combos) {
  return [...combos].sort((left, right) => {
    const leftScore = Number(left.score || 0) + Number(left.expectedValue || 0) * 8 + Number(left.averageConfidence || 0) * 5;
    const rightScore = Number(right.score || 0) + Number(right.expectedValue || 0) * 8 + Number(right.averageConfidence || 0) * 5;
    return rightScore - leftScore;
  })[0] || null;
}

function buildMostLikelyPicks(legs, { fixtureCount = null } = {}) {
  const eligibleLegs = legs
    .filter((leg) => !leg.hardBlocks?.length)
    .filter((leg) => Number(leg.modelProbability) > 0)
    .sort((left, right) => likelyLegScore(right) - likelyLegScore(left));
  const fixtureSeparatedCount = bestLikelyLegPerFixture(eligibleLegs).length;
  const availableFixtureCount = Number.isFinite(Number(fixtureCount)) && Number(fixtureCount) > 0
    ? Number(fixtureCount)
    : fixtureSeparatedCount;

  return pickOfDaySlip
    .map(([category, label], index) => {
      const legCount = legCountForPickCategory(category);

      if (availableFixtureCount < legCount) {
        return null;
      }

      const bestPerFixture = bestLikelyLegPerFixture(eligibleLegs, legCount);
      const targetEligibleLegs = [...eligibleLegs].sort((left, right) => likelyLegScore(right, legCount) - likelyLegScore(left, legCount));
      const selectedLegs = selectMostLikelyLegsForTarget({
        fixtureSeparatedLegs: bestPerFixture,
        eligibleLegs: targetEligibleLegs,
        legCount
      });

      if (!selectedLegs.length) {
        return null;
      }

      return scoreMostLikelyCombo(selectedLegs, { category, label, type: pickTypeForCategory(category), legCount }, index + 1);
    })
    .filter(Boolean);
}

function pickTypeForCategory(category) {
  if (category === "single") {
    return "single";
  }
  if (category === "double") {
    return "double";
  }
  if (category === "trixie") {
    return "trixie";
  }

  return "accumulator";
}

function bestLikelyLegPerFixture(legs, legCount = 1) {
  const byFixture = new Map();

  for (const leg of legs) {
    const fixtureKey = fixtureKeyForLeg(leg);
    const existing = byFixture.get(fixtureKey);

    if (!existing || likelyLegScore(leg, legCount) > likelyLegScore(existing, legCount)) {
      byFixture.set(fixtureKey, leg);
    }
  }

  return [...byFixture.values()].sort((left, right) => likelyLegScore(right, legCount) - likelyLegScore(left, legCount));
}

function selectMostLikelyLegsForTarget({ fixtureSeparatedLegs, eligibleLegs, legCount }) {
  const selected = [];
  const selectedIds = new Set();

  addMostLikelyLegs({ selected, selectedIds, pool: fixtureSeparatedLegs, legCount, mode: "strict" });
  addMostLikelyLegs({ selected, selectedIds, pool: fixtureSeparatedLegs, legCount, mode: "balanced" });
  addMostLikelyLegs({ selected, selectedIds, pool: eligibleLegs, legCount, mode: "fallback" });
  addLeastCorrelatedLegs({ selected, selectedIds, pool: fixtureSeparatedLegs, legCount });

  if (!selected.length) {
    return [];
  }

  const fillPool = [...selected];
  let repeatIndex = 1;

  while (selected.length < legCount) {
    const leg = fillPool[(repeatIndex - 1) % fillPool.length];
    selected.push({
      ...leg,
      id: `${leg.id}_short_window_repeat_${repeatIndex}`,
      shortWindowFallback: true,
      reusedSignal: true
    });
    repeatIndex += 1;
  }

  return selected;
}

function addMostLikelyLegs({ selected, selectedIds, pool, legCount, mode }) {
  for (const leg of pool) {
    if (selected.length >= legCount) {
      break;
    }

    if (selectedIds.has(leg.id)) {
      continue;
    }

    if (selected.some((item) => fixtureKeyForLeg(item) === fixtureKeyForLeg(leg))) {
      continue;
    }

    if (!mostLikelyLegPassesPortfolioShape(leg, selected, legCount, mode)) {
      continue;
    }

    selected.push(leg);
    selectedIds.add(leg.id);
  }
}

function addLeastCorrelatedLegs({ selected, selectedIds, pool, legCount }) {
  while (selected.length < legCount) {
    const candidates = pool
      .filter((leg) => !selectedIds.has(leg.id))
      .filter((leg) => !selected.some((item) => fixtureKeyForLeg(item) === fixtureKeyForLeg(leg)))
      .filter((leg) => likelyWinProbability(leg, { legCount }) >= minimumSurvivalProbability(legCount) - 0.04)
      .filter((leg) => !(legCount >= 6 && fragileBttsHistory(leg)))
      .map((leg) => {
        const correlation = portfolioCorrelationProfile([...selected, leg], { legCount, appetite: 0 });
        return {
          leg,
          fit: likelyLegScore(leg, legCount) - correlation.penalty * 4.8
        };
      })
      .sort((left, right) => right.fit - left.fit);

    if (!candidates.length) {
      break;
    }

    selected.push(candidates[0].leg);
    selectedIds.add(candidates[0].leg.id);
  }
}

function likelyLegScore(leg, legCount = 1) {
  const probability = likelyWinProbability(leg, { legCount });
  const confidence = Number(leg.confidence || 0);
  const edge = Number(leg.edge || 0);
  const independentEdge = Number(leg.independentEdge ?? edge);
  const signalScore = clamp(Number(leg.components?.nonMarketSignalCount || 0) / 4, 0, 1);
  const intelligence = Number(leg.components?.intelligenceConfidence || 0.45);
  const freshness = Number(leg.components?.oddsFreshness || 0.75);
  const survivalPressure = survivalPressureForLegCount(legCount);
  const valueWeight = 1 - survivalPressure * 0.78;
  const portfolioPenalty = mostLikelyPortfolioPenalty(leg, legCount) * 28;

  return probability * (70 + survivalPressure * 28)
    + confidence * (18 + survivalPressure * 8)
    + intelligence * 7
    + freshness * 4
    + signalScore * (7 - survivalPressure * 4)
    + clamp(edge, 0, 0.12) * 24 * valueWeight
    + clamp(independentEdge, -0.03, 0.12) * 36 * valueWeight
    - portfolioPenalty;
}

function likelyWinProbability(leg, { legCount = 1 } = {}) {
  const model = Number(leg.modelProbability || 0);
  const rawModel = Number(leg.rawModelProbability || model);
  const market = Number(leg.marketImpliedProbability || leg.impliedProbability || 0);
  const confidence = Number(leg.confidence || 0);
  const independentEdge = Number(leg.independentEdge ?? (rawModel - market));
  const signalScore = clamp(Number(leg.components?.nonMarketSignalCount || 0) / 4, 0, 1);
  const survivalPressure = survivalPressureForLegCount(legCount);

  if (!market) {
    const noMarketProbability = (model * (0.68 - survivalPressure * 0.1))
      + (rawModel * (0.24 - survivalPressure * 0.06))
      + (confidence * (0.08 + survivalPressure * 0.16));
    return clamp(noMarketProbability - mostLikelyPortfolioPenalty(leg, legCount), 0.03, 0.92);
  }

  const modelLiftCap = 0.1
    - survivalPressure * 0.032
    + confidence * (0.035 - survivalPressure * 0.012)
    + clamp(independentEdge, 0, 0.1) * (0.42 - survivalPressure * 0.27)
    + signalScore * (0.025 - survivalPressure * 0.011);
  const marketSaneModel = Math.min(model, market + modelLiftCap);
  const modelWeight = 0.55 - survivalPressure * 0.15;
  const rawWeight = 0.25 - survivalPressure * 0.09;
  const marketWeight = 0.1 + survivalPressure * 0.24;
  const confidenceWeight = 1 - modelWeight - rawWeight - marketWeight;
  const probability = (marketSaneModel * modelWeight)
    + (rawModel * rawWeight)
    + (market * marketWeight)
    + (confidence * confidenceWeight);

  return clamp(probability - mostLikelyPortfolioPenalty(leg, legCount), 0.03, 0.92);
}

function scoreMostLikelyCombo(legs, target, rank) {
  const combinedDecimalOdds = product(legs.map((leg) => leg.decimalOdds));
  const combinedProbability = product(legs.map((leg) => likelyWinProbability(leg, { legCount: target.legCount })));
  const expectedValue = combinedProbability * combinedDecimalOdds - 1;
  const averageEdge = mean(legs.map((leg) => leg.edge));
  const averageIndependentEdge = mean(legs.map((leg) => leg.independentEdge ?? leg.edge));
  const averageConfidence = mean(legs.map((leg) => leg.confidence));
  const intelligenceConfidence = mean(legs.map((leg) => leg.components?.intelligenceConfidence || 0.45));
  const averageNonMarketSignalCount = mean(legs.map((leg) => leg.components?.nonMarketSignalCount || 0));
  const averageSurvivalProbability = mean(legs.map((leg) => likelyWinProbability(leg, { legCount: target.legCount })));
  const bttsLegCount = legs.filter(isBttsYesLeg).length;
  const fragileLegCount = legs.filter((leg) => mostLikelyPortfolioPenalty(leg, target.legCount) >= 0.035).length;
  const uniqueFixtureCount = new Set(legs.map(fixtureKeyForLeg)).size;
  const reusedSignalCount = legs.filter((leg) => leg.reusedSignal).length;
  const shortWindowFallback = uniqueFixtureCount < legs.length || reusedSignalCount > 0;
  const survivalPressure = survivalPressureForLegCount(target.legCount);
  const correlation = portfolioCorrelationProfile(legs, { legCount: target.legCount, appetite: 0 });
  const score = clamp(
    combinedProbability * (120 + survivalPressure * 240)
    + averageSurvivalProbability * (42 + survivalPressure * 42)
    + averageConfidence * 18
    + intelligenceConfidence * 8
    + clamp(averageEdge, 0, 0.12) * (32 - survivalPressure * 20)
    + clamp(averageIndependentEdge, -0.03, 0.12) * (42 - survivalPressure * 30)
    + clamp(averageNonMarketSignalCount / 4, 0, 1) * (8 - survivalPressure * 4)
    - bttsClusterPenalty(bttsLegCount, target.legCount)
    - marketClusterPenalty(legs, target.legCount)
    - correlation.penalty
    - fragileLegCount * 4.5,
    0,
    100
  );

  return {
    id: `most_likely_${target.category}_${legs.map((leg) => leg.id).join("_").slice(0, 48)}`,
    rank,
    category: target.category,
    label: target.label,
    type: target.type,
    legCount: target.legCount,
    legs: legs.map((leg) => ({
      ...leg,
      likelyProbability: round(likelyWinProbability(leg, { legCount: target.legCount }), 4),
      components: {
        ...(leg.components || {}),
        survivalPenalty: round(mostLikelyPortfolioPenalty(leg, target.legCount), 4)
      }
    })),
    combinedDecimalOdds: round(combinedDecimalOdds, 2),
    combinedProbability: round(combinedProbability, 4),
    expectedValue: round(expectedValue, 4),
    averageEdge: round(averageEdge, 4),
    averageIndependentEdge: round(averageIndependentEdge, 4),
    averageConfidence: round(averageConfidence, 4),
    averageSurvivalProbability: round(averageSurvivalProbability, 4),
    riskLegCount: legs.filter((leg) => ["calculated_risk", "longshot_value", "contrarian_value"].includes(leg.riskTag)).length,
    bttsLegCount,
    fragileLegCount,
    intelligenceConfidence: round(intelligenceConfidence, 4),
    averageNonMarketSignalCount: round(averageNonMarketSignalCount, 2),
    score: round(score, 2),
    displayRating: displayConfidenceRating(legs, { likely: true }),
    shortWindowFallback,
    uniqueFixtureCount,
    reusedSignalCount,
    correlationPenalty: round(correlation.penalty, 2),
    correlationReasons: correlation.reasons,
    marketFamilyMix: correlation.familyCounts,
    repeatedTeamCount: correlation.repeatedTeamCount,
    sameDateCluster: correlation.sameDateCluster,
    thesis: buildMostLikelyThesis({ target, legs, combinedDecimalOdds, combinedProbability, averageSurvivalProbability, averageConfidence, averageIndependentEdge, averageNonMarketSignalCount, bttsLegCount, fragileLegCount, marketClusterScore: marketClusterPenalty(legs, target.legCount), correlation, shortWindowFallback, uniqueFixtureCount, reusedSignalCount })
  };
}

function buildMostLikelyThesis({ target, legs, combinedDecimalOdds, combinedProbability, averageSurvivalProbability, averageConfidence, averageIndependentEdge, averageNonMarketSignalCount, bttsLegCount, fragileLegCount, marketClusterScore, correlation, shortWindowFallback, uniqueFixtureCount, reusedSignalCount }) {
  const selections = legs.map((leg) => leg.selectionLabel).join(" | ");
  const fallbackText = shortWindowFallback
    ? ` Short-window fallback used ${uniqueFixtureCount} fixture(s) and ${legs.length} signal(s) so Picks of the Day stay populated. ${reusedSignalCount ? `${reusedSignalCount} strongest signal(s) were repeated.` : "Some same-game signals were included."}`
    : "";
  const heatLegs = legs.filter((leg) => Number(leg.components?.heatConfidence || 0) > 0.18 && Number(leg.components?.heatStress || 0) > 0.2);
  const heatText = heatLegs.length ? ` Heat layer active on ${heatLegs.length} leg(s) as a capped weather, climate-history, and squad-depth nudge.` : "";
  const portfolioText = target.legCount >= 4
    ? ` Long-slip survival controls active: average leg survival ${round(averageSurvivalProbability * 100, 1)}%, estimated slip chance ${round(combinedProbability * 100, 2)}%, ${bttsLegCount} BTTS leg(s), ${fragileLegCount} fragile-value leg(s), market-mix pressure ${round(marketClusterScore, 1)}, correlation pressure ${round(correlation?.penalty || 0, 1)}.`
    : ` Estimated win chance ${round(combinedProbability * 100, 1)}%.`;
  const correlationText = correlation?.reasons?.length ? ` Correlation layer trimmed: ${correlation.reasons.join("; ")}.` : "";

  return `${target.label} chosen by the Pick of the Day engine, ignoring the risk slider and prioritising estimated win chance, data confidence, fixture separation, and only then price edge. Combined odds ${round(combinedDecimalOdds, 2)}, average data confidence ${round(averageConfidence * 100, 1)}%, independent edge ${round(averageIndependentEdge * 100, 2)}%, non-market signals ${round(averageNonMarketSignalCount, 1)} per leg.${portfolioText}${correlationText}${heatText}${fallbackText} Legs: ${selections}.`;
}

function mostLikelyLegPassesPortfolioShape(leg, selected, legCount, mode) {
  if (legCount < 4) {
    return true;
  }

  const probability = likelyWinProbability(leg, { legCount });
  const decimalOdds = Number(leg.decimalOdds || 1);
  const bttsCount = selected.filter(isBttsYesLeg).length + (isBttsYesLeg(leg) ? 1 : 0);
  const fragileCount = selected.filter((item) => mostLikelyPortfolioPenalty(item, legCount) >= 0.035).length
    + (mostLikelyPortfolioPenalty(leg, legCount) >= 0.035 ? 1 : 0);
  const sameMarketCount = selected.filter((item) => item.market === leg.market).length + 1;
  const totalGoalsCount = selected.filter(isTotalGoalsLeg).length + (isTotalGoalsLeg(leg) ? 1 : 0);
  const correlation = portfolioCorrelationProfile([...selected, leg], { legCount, appetite: 0 });

  if (mode === "fallback") {
    return probability >= minimumSurvivalProbability(legCount) - 0.04
      && !(legCount >= 6 && fragileBttsHistory(leg))
      && correlation.penalty <= maximumPortfolioCorrelationPenalty(legCount, "balanced");
  }

  if (mode === "strict") {
    if (probability < minimumSurvivalProbability(legCount)) {
      return false;
    }
    if (decimalOdds > maximumSurvivalOdds(legCount)) {
      return false;
    }
    if (bttsCount > maximumBttsLegs(legCount)) {
      return false;
    }
    if (fragileCount > maximumFragileLegs(legCount)) {
      return false;
    }
    if (legCount >= 6 && fragileBttsHistory(leg)) {
      return false;
    }
    if (sameMarketCount > maximumSameMarketLegs(legCount, leg.market)) {
      return false;
    }
    if (totalGoalsCount > maximumTotalGoalsLegs(legCount)) {
      return false;
    }
    if (correlation.penalty > maximumPortfolioCorrelationPenalty(legCount, "strict")) {
      return false;
    }
  }

  if (mode === "balanced") {
    if (probability < minimumSurvivalProbability(legCount) - 0.035) {
      return false;
    }
    if (bttsCount > maximumBttsLegs(legCount) + 1) {
      return false;
    }
    if (fragileCount > maximumFragileLegs(legCount) + 1) {
      return false;
    }
    if (sameMarketCount > maximumSameMarketLegs(legCount, leg.market) + 1) {
      return false;
    }
    if (totalGoalsCount > maximumTotalGoalsLegs(legCount) + 1) {
      return false;
    }
    if (correlation.penalty > maximumPortfolioCorrelationPenalty(legCount, "balanced")) {
      return false;
    }
  }

  return true;
}

function mostLikelyPortfolioPenalty(leg, legCount) {
  const pressure = survivalPressureForLegCount(legCount);

  if (!pressure) {
    return 0;
  }

  const decimalOdds = Number(leg.decimalOdds || 1);
  const expectedGoals = Number(leg.components?.expectedGoals || 0);
  const homeExpectedGoals = Number(leg.components?.homeExpectedGoals || 0);
  const awayExpectedGoals = Number(leg.components?.awayExpectedGoals || 0);
  const lowerExpectedGoals = Math.min(homeExpectedGoals || 99, awayExpectedGoals || 99);
  let penalty = 0;

  if (decimalOdds > 2.05) {
    penalty += Math.min(0.055, (decimalOdds - 2.05) * 0.09);
  }

  if (isBttsYesLeg(leg)) {
    const bttsHistory = mean([
      Number(leg.components?.homeBttsRate || 0.48),
      Number(leg.components?.awayBttsRate || 0.48)
    ]);
    const minBttsHistory = Math.min(
      Number(leg.components?.homeBttsRate || 0.48),
      Number(leg.components?.awayBttsRate || 0.48)
    );
    const overHistory = mean([
      Number(leg.components?.homeOver25Rate || 0.48),
      Number(leg.components?.awayOver25Rate || 0.48)
    ]);

    if (bttsHistory < 0.44) {
      penalty += (0.44 - bttsHistory) * 0.11;
    }
    if (minBttsHistory < 0.32) {
      penalty += (0.32 - minBttsHistory) * 0.22;
    }
    if (overHistory < 0.4) {
      penalty += (0.4 - overHistory) * 0.08;
    }
    if (lowerExpectedGoals < 0.9) {
      penalty += (0.9 - lowerExpectedGoals) * 0.08;
    }
    if (expectedGoals < 2.45) {
      penalty += (2.45 - expectedGoals) * 0.035;
    }
  }

  if (leg.market === "match_winner" && decimalOdds >= 3.2) {
    penalty += Math.min(0.06, (decimalOdds - 3.2) * 0.025);
  }

  if (leg.market === "anytime_scorer") {
    penalty += 0.035;
  }

  return clamp(penalty * pressure, 0, 0.12);
}

function survivalPressureForLegCount(legCount) {
  return clamp((Number(legCount || 1) - 2) / 6, 0, 1);
}

function minimumSurvivalProbability(legCount) {
  if (legCount >= 8) {
    return 0.55;
  }
  if (legCount >= 6) {
    return 0.56;
  }
  if (legCount >= 4) {
    return 0.57;
  }
  return 0.5;
}

function maximumSurvivalOdds(legCount) {
  if (legCount >= 8) {
    return 2.28;
  }
  if (legCount >= 6) {
    return 2.35;
  }
  if (legCount >= 4) {
    return 2.45;
  }
  return 1000;
}

function maximumBttsLegs(legCount) {
  if (legCount >= 8) {
    return 3;
  }
  if (legCount >= 6) {
    return 3;
  }
  if (legCount >= 4) {
    return 2;
  }
  return legCount;
}

function maximumFragileLegs(legCount) {
  if (legCount >= 8) {
    return 2;
  }
  if (legCount >= 6) {
    return 2;
  }
  if (legCount >= 4) {
    return 1;
  }
  return legCount;
}

function bttsClusterPenalty(bttsLegCount, legCount) {
  if (legCount < 4) {
    return 0;
  }

  const allowed = maximumBttsLegs(legCount);
  const excess = Math.max(0, Number(bttsLegCount || 0) - allowed);
  const heavyCluster = Math.max(0, Number(bttsLegCount || 0) - Math.ceil(legCount * 0.7));
  const basePenalty = legCount >= 8 ? 7.5 : legCount >= 6 ? 6 : 4.5;

  return excess * basePenalty + heavyCluster * 3;
}

function marketClusterPenalty(legs, legCount) {
  if (legCount < 4) {
    return 0;
  }

  const marketCounts = new Map();
  let totalGoalsCount = 0;

  for (const leg of legs) {
    marketCounts.set(leg.market, (marketCounts.get(leg.market) || 0) + 1);
    if (isTotalGoalsLeg(leg)) {
      totalGoalsCount += 1;
    }
  }

  let penalty = 0;
  for (const [market, count] of marketCounts.entries()) {
    const excess = Math.max(0, count - maximumSameMarketLegs(legCount, market));
    penalty += excess * (legCount >= 8 ? 5.5 : 3.8);
  }

  penalty += Math.max(0, totalGoalsCount - maximumTotalGoalsLegs(legCount)) * (legCount >= 8 ? 4.5 : 3.2);
  return penalty;
}

function portfolioCorrelationProfile(legs, { legCount = legs.length, appetite = 0 } = {}) {
  if (legCount < 3) {
    return emptyCorrelationProfile();
  }

  const familyCounts = countBy(legs, marketFamilyForLeg);
  const teamCounts = countBy(legs.flatMap(teamsForLeg), (team) => team);
  const dateCounts = countBy(legs.map((leg) => fixtureDateKey(leg)).filter(Boolean), (date) => date);
  const heatLegCount = legs.filter((leg) => Number(leg.components?.heatStress || 0) >= 0.55 && Number(leg.components?.heatConfidence || 0) >= 0.3).length;
  const scorerCount = legs.filter((leg) => leg.market === "anytime_scorer").length;
  const reasons = [];
  let penalty = 0;

  for (const [family, count] of Object.entries(familyCounts)) {
    const allowed = maximumMarketFamilyLegs(legCount, family, appetite);
    const excess = Math.max(0, count - allowed);

    if (excess) {
      penalty += excess * (family === "goals" ? 4.7 : family === "scorer" ? 5.4 : 3.8);
      reasons.push(`${count} ${family} legs`);
    }
  }

  const repeatedTeamCount = Object.values(teamCounts).reduce((total, count) => total + Math.max(0, count - 1), 0);
  const teamRepeatAllowance = legCount >= 8 ? 1 + Math.floor(appetite * 3) : legCount >= 6 ? 1 + Math.floor(appetite * 2) : Math.floor(appetite * 1.5);
  const repeatedTeamExcess = Math.max(0, repeatedTeamCount - teamRepeatAllowance);

  if (repeatedTeamExcess) {
    penalty += repeatedTeamExcess * (legCount >= 8 ? 2.8 : 3.4);
    reasons.push(`${repeatedTeamCount} repeated team exposures`);
  }

  const sameDateCluster = Math.max(0, ...Object.values(dateCounts));
  const dateAllowance = legCount >= 8 ? 5 : legCount >= 6 ? 4 : 3;
  const dateExcess = Math.max(0, sameDateCluster - dateAllowance);

  if (dateExcess) {
    penalty += dateExcess * 1.9;
    reasons.push(`${sameDateCluster} legs on one matchday`);
  }

  const heatAllowance = legCount >= 8 ? 3 : legCount >= 6 ? 2 : 1;
  const heatExcess = Math.max(0, heatLegCount - heatAllowance);

  if (heatExcess) {
    penalty += heatExcess * 1.8;
    reasons.push(`${heatLegCount} heat-sensitive legs`);
  }

  const scorerAllowance = legCount >= 8 ? 2 : legCount >= 5 ? 1 : legCount;
  const scorerExcess = Math.max(0, scorerCount - scorerAllowance);

  if (scorerExcess) {
    penalty += scorerExcess * 4.2;
    reasons.push(`${scorerCount} scorer legs`);
  }

  const pressure = survivalPressureForLegCount(legCount);
  const appetiteRelief = 1 - clamp(appetite, 0, 1) * 0.3;
  const finalPenalty = penalty * (0.45 + pressure * 0.75) * appetiteRelief;

  return {
    penalty: round(finalPenalty, 3),
    reasons,
    familyCounts,
    repeatedTeamCount,
    sameDateCluster,
    heatLegCount,
    scorerCount
  };
}

function emptyCorrelationProfile() {
  return {
    penalty: 0,
    reasons: [],
    familyCounts: {},
    repeatedTeamCount: 0,
    sameDateCluster: 0,
    heatLegCount: 0,
    scorerCount: 0
  };
}

function maximumPortfolioCorrelationPenalty(legCount, mode) {
  const strictBase = legCount >= 8 ? 7.2 : legCount >= 6 ? 6.4 : 5.2;
  return mode === "balanced" ? strictBase + 2.5 : strictBase;
}

function maximumMarketFamilyLegs(legCount, family, appetite = 0) {
  const relief = Math.floor(clamp(appetite, 0, 1) * 1.5);

  if (family === "goals") {
    if (legCount >= 8) {
      return 5 + relief;
    }
    if (legCount >= 6) {
      return 4 + relief;
    }
    return 3;
  }

  if (family === "scorer") {
    if (legCount >= 8) {
      return 2 + Math.floor(clamp(appetite, 0, 1));
    }
    if (legCount >= 5) {
      return 1 + Math.floor(clamp(appetite, 0, 1));
    }
    return legCount;
  }

  if (legCount >= 8) {
    return 5 + relief;
  }
  if (legCount >= 6) {
    return 4 + relief;
  }
  return 3;
}

function marketFamilyForLeg(leg) {
  if (isTotalGoalsLeg(leg) || leg.market === "both_teams_to_score") {
    return "goals";
  }

  if (leg.market === "anytime_scorer") {
    return "scorer";
  }

  if (leg.market === "match_winner" || leg.market === "draw_no_bet") {
    return "result";
  }

  return leg.market || "other";
}

function teamsForLeg(leg) {
  return [leg.homeTeam, leg.awayTeam]
    .map(normalizeFixtureName)
    .filter(Boolean);
}

function fixtureDateKey(leg) {
  const value = leg.fixtureDate || leg.date;

  if (!value) {
    return "";
  }

  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
}

function countBy(items, keyFn) {
  const counts = {};

  for (const item of items) {
    const key = keyFn(item);

    if (!key) {
      continue;
    }

    counts[key] = (counts[key] || 0) + 1;
  }

  return counts;
}

function isBttsYesLeg(leg) {
  return leg.market === "both_teams_to_score" && String(leg.outcome || leg.selectionLabel || "").toLowerCase().includes("yes");
}

function isTotalGoalsLeg(leg) {
  return leg.market === "over_2_5_goals" || leg.market === "under_2_5_goals";
}

function maximumSameMarketLegs(legCount, market) {
  if (legCount >= 8) {
    if (market === "both_teams_to_score") {
      return 3;
    }
    if (isTotalGoalsMarket(market)) {
      return 4;
    }
    return 5;
  }
  if (legCount >= 6) {
    return isTotalGoalsMarket(market) ? 3 : 4;
  }
  if (legCount >= 4) {
    return isTotalGoalsMarket(market) ? 2 : 3;
  }
  return legCount;
}

function maximumTotalGoalsLegs(legCount) {
  if (legCount >= 8) {
    return 4;
  }
  if (legCount >= 6) {
    return 3;
  }
  if (legCount >= 4) {
    return 2;
  }
  return legCount;
}

function isTotalGoalsMarket(market) {
  return market === "over_2_5_goals" || market === "under_2_5_goals";
}

function fragileBttsHistory(leg) {
  if (!isBttsYesLeg(leg)) {
    return false;
  }

  const minBttsHistory = Math.min(
    Number(leg.components?.homeBttsRate || 0.48),
    Number(leg.components?.awayBttsRate || 0.48)
  );
  const overHistory = mean([
    Number(leg.components?.homeOver25Rate || 0.48),
    Number(leg.components?.awayOver25Rate || 0.48)
  ]);

  return minBttsHistory < 0.3 || overHistory < 0.34;
}

function riskAppetiteFromPolicy(policy) {
  const riskProfile = policy.riskProfile || {};
  const valueWeight = Number(riskProfile.valueHuntingWeight);
  const contrarianWeight = Number(riskProfile.contrarianWeight);

  if (Number.isFinite(valueWeight) && Number.isFinite(contrarianWeight)) {
    return clamp(((valueWeight - 0.14) / 0.34) * 0.55 + ((contrarianWeight - 0.02) / 0.38) * 0.45, 0, 1);
  }

  return clamp((Number(riskProfile.maxCombinedOdds || 38) - 38) / 560, 0, 1);
}

function riskPortfolioLegPenalty(leg, legCount, appetite) {
  const pressure = survivalPressureForLegCount(legCount);
  const decimalOdds = Number(leg.decimalOdds || 1);
  let penalty = mostLikelyPortfolioPenalty(leg, legCount) * (0.75 + pressure * 0.3);

  if (leg.market === "anytime_scorer" && legCount >= 3) {
    penalty += (0.018 + pressure * 0.028) * (1 - appetite * 0.25);
  }

  if (isBttsYesLeg(leg) && fragileBttsHistory(leg)) {
    penalty += (0.018 + pressure * 0.032) * (1 - appetite * 0.35);
  }

  const longPriceLine = 2.5 + appetite * 1.2;
  if (legCount >= 4 && decimalOdds > longPriceLine) {
    penalty += Math.min(0.045, (decimalOdds - longPriceLine) * 0.03) * (1 - appetite * 0.3);
  }

  return clamp(penalty * (1 - appetite * 0.35), 0, 0.16);
}

function riskPortfolioPenalty({ legs, appetite, bttsLegCount, fragileLegCount }) {
  const legCount = legs.length;

  if (legCount < 3) {
    return 0;
  }

  const bttsAllowance = legCount >= 8
    ? 3 + Math.floor(appetite * 2)
    : legCount >= 6
      ? 3 + Math.floor(appetite * 2)
      : legCount >= 4
        ? 2 + Math.floor(appetite * 1.5)
        : legCount;
  const fragileAllowance = legCount >= 8
    ? 2 + Math.floor(appetite * 2)
    : legCount >= 4
      ? 1 + Math.floor(appetite * 2)
      : legCount;
  const bttsPenalty = Math.max(0, Number(bttsLegCount || 0) - bttsAllowance) * (legCount >= 8 ? 6 : 4) * (1 - appetite * 0.28);
  const fragilePenalty = Math.max(0, Number(fragileLegCount || 0) - fragileAllowance) * 5 * (1 - appetite * 0.3);
  const scorerCount = legs.filter((leg) => leg.market === "anytime_scorer").length;
  const scorerPenalty = legCount >= 4
    ? Math.max(0, scorerCount - (appetite > 0.7 ? 2 : 1)) * 5 * (1 - appetite * 0.2)
    : 0;
  const legPenalty = legs.reduce((total, leg) => total + riskPortfolioLegPenalty(leg, legCount, appetite), 0) * 38;
  const marketPenalty = riskMarketClusterPenalty(legs, appetite);

  return bttsPenalty + fragilePenalty + scorerPenalty + legPenalty + marketPenalty;
}

function riskMarketClusterPenalty(legs, appetite) {
  const legCount = legs.length;

  if (legCount < 4) {
    return 0;
  }

  const marketCounts = new Map();
  let totalGoalsCount = 0;

  for (const leg of legs) {
    marketCounts.set(leg.market, (marketCounts.get(leg.market) || 0) + 1);
    if (isTotalGoalsLeg(leg)) {
      totalGoalsCount += 1;
    }
  }

  const sameMarketAllowance = legCount >= 8
    ? 4 + Math.floor(appetite * 2)
    : legCount >= 6
      ? 3 + Math.floor(appetite * 2)
      : 2 + Math.floor(appetite * 1.5);
  const totalGoalsAllowance = legCount >= 8
    ? 4 + Math.floor(appetite * 2)
    : legCount >= 6
      ? 3 + Math.floor(appetite * 1.5)
      : 2 + Math.floor(appetite);
  let penalty = Math.max(0, totalGoalsCount - totalGoalsAllowance) * (4.5 - appetite * 1.6);

  for (const count of marketCounts.values()) {
    penalty += Math.max(0, count - sameMarketAllowance) * (4 - appetite * 1.4);
  }

  return penalty;
}

function preferredOddsRange(type, legCount, policy) {
  const riskProfile = policy.riskProfile || {};

  if (type === "accumulator") {
    return riskProfile.preferredCombinedOdds?.accumulatorByLegCount?.[legCount]
      || riskProfile.preferredCombinedOdds?.accumulator
      || { min: 1, max: riskProfile.maxCombinedOdds || 50 };
  }

  return riskProfile.preferredCombinedOdds?.[type] || { min: 1, max: riskProfile.maxCombinedOdds || 50 };
}

function oddsFitScore(value, min, max) {
  if (value < min || value > max) {
    return -12;
  }

  const midpoint = (min + max) / 2;
  const spread = Math.max(1, (max - min) / 2);
  return 10 * (1 - Math.min(1, Math.abs(value - midpoint) / spread));
}

function buildComboThesis({ type, legs, combinedDecimalOdds, expectedValue, averageIndependentEdge, averageNonMarketSignalCount, riskLegs, favouriteLegs, survivalCombinedProbability, averageSurvivalProbability, bttsLegCount, fragileLegCount, correlation }) {
  const selections = legs.map((leg) => leg.selectionLabel).join(" | ");
  const riskText = riskLegs.length
    ? `${riskLegs.length} calculated-risk/value leg(s) stop this from being a favourite-only ${type}.`
    : "No calculated-risk leg; this should only survive if the edge is exceptional.";
  const favouriteText = favouriteLegs.length ? `${favouriteLegs.length} high-implied-probability favourite leg(s).` : "No high-implied-probability favourite crowding.";
  const survivalText = `${type} at combined odds ${round(combinedDecimalOdds, 2)} with estimated slip chance ${round(survivalCombinedProbability * 100, 2)}% and average leg survival ${round(averageSurvivalProbability * 100, 1)}%.`;
  const clusterText = legs.length >= 4
    ? `Long-slip controls: ${bttsLegCount} BTTS leg(s), ${fragileLegCount} fragile-value leg(s), so edge cannot outrank survivability.`
    : "Short-slip controls keep model chance ahead of price hunting.";
  const correlationText = legs.length >= 3
    ? `Correlation control: ${correlation?.reasons?.length ? correlation.reasons.join("; ") : "market families and team repeats look acceptable"}.`
    : "";
  const heatLegs = legs.filter((leg) => Number(leg.components?.heatConfidence || 0) > 0.18 && Number(leg.components?.heatStress || 0) > 0.2);
  const heatText = heatLegs.length
    ? `Heat layer active on ${heatLegs.length} leg(s), capped as a small xG/result adjustment using weather, climate memory, and squad depth.`
    : "Heat layer neutral or low impact on this slip.";

  return `${survivalText} Expected value is ${round(expectedValue * 100, 2)}%, independent edge averages ${round(averageIndependentEdge * 100, 2)}%, and the model has ${round(averageNonMarketSignalCount, 1)} non-market signals per leg. ${clusterText} ${correlationText} ${riskText} ${favouriteText} ${heatText} Legs: ${selections}.`;
}

function nearest(values, value) {
  return values.reduce((winner, item) => Math.abs(item - value) < Math.abs(winner - value) ? item : winner, values[0]);
}

function combinations(items, size, limit = 12000) {
  const results = [];

  function visit(start, chosen) {
    if (results.length >= limit) {
      return;
    }

    if (chosen.length === size) {
      results.push([...chosen]);
      return;
    }

    for (let index = start; index < items.length; index += 1) {
      chosen.push(items[index]);
      visit(index + 1, chosen);
      chosen.pop();
    }
  }

  visit(0, []);
  return results;
}

function product(values) {
  return values.reduce((total, value) => total * Number(value || 1), 1);
}

function mean(values) {
  const valid = values.map(Number).filter((value) => Number.isFinite(value));
  return valid.length ? valid.reduce((total, value) => total + value, 0) / valid.length : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function dateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function automaticGatheringState(data, now = new Date()) {
  const schedule = data?.collection?.schedule || defaultGatheringSchedule;
  const runMinutes = Array.isArray(schedule.automaticRunMinutesUtc) && schedule.automaticRunMinutesUtc.length
    ? schedule.automaticRunMinutesUtc
    : defaultGatheringSchedule.automaticRunMinutesUtc;
  const windowMinutes = Number(schedule.gatheringWindowMinutes || defaultGatheringSchedule.gatheringWindowMinutes);
  const message = schedule.gatheringMessage || defaultGatheringSchedule.gatheringMessage;
  const currentMinute = (now.getUTCHours() * 60) + now.getUTCMinutes() + (now.getUTCSeconds() / 60);
  const active = runMinutes.some((startMinute) => {
    const endMinute = startMinute + windowMinutes;

    if (endMinute < 1440) {
      return currentMinute >= startMinute && currentMinute < endMinute;
    }

    return currentMinute >= startMinute || currentMinute < (endMinute - 1440);
  });

  return { active, message };
}

function money(value) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(Number(value || 0));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function formatLegNote(leg) {
  const edge = percent(leg.edge);
  const confidence = percent(leg.confidence);
  const rawAi = Number(leg.rawModelProbability || leg.modelProbability || 0);
  const market = Number(leg.marketImpliedProbability || leg.impliedProbability || 0);
  const independentEdge = Number(leg.independentEdge ?? (rawAi - market));
  const signals = Number(leg.components?.nonMarketSignalCount || 0);
  const tag = String(leg.riskTag || "edge").replace(/_/g, " ");
  const bookmaker = leg.bookmaker ? ` via ${leg.bookmaker}` : "";

  return `${tag}${bookmaker} | AI ${percent(rawAi)} vs market ${percent(market)} | independent edge ${percent(independentEdge)} | ${signals} signals | rating ${percent(displayLegRating(leg))} | final edge ${edge} | data ${confidence}`;
}

function confidenceLabel(bet) {
  return `AI Rating ${percent(displayRatingForBet(bet))}`;
}

function likelihoodLabel(bet) {
  return `AI Rating ${percent(displayRatingForBet(bet, { likely: true }))}`;
}

function formatLikelyLegNote(leg) {
  const confidence = percent(leg.confidence);
  const survival = Number(leg.likelyProbability || likelyWinProbability(leg));
  const rawAi = Number(leg.rawModelProbability || leg.modelProbability || leg.likelyProbability || 0);
  const market = Number(leg.marketImpliedProbability || leg.impliedProbability || 0);
  const independentEdge = Number(leg.independentEdge ?? (rawAi - market));
  const signals = Number(leg.components?.nonMarketSignalCount || 0);
  const bookmaker = leg.bookmaker ? ` via ${leg.bookmaker}` : "";

  return `AI survival ${percent(survival)}${bookmaker} | raw AI ${percent(rawAi)} vs market ${percent(market)} | independent edge ${percent(independentEdge)} | ${signals} signals | data ${confidence}`;
}

function displayRatingForBet(bet, options = {}) {
  if (Number.isFinite(Number(bet.displayRating)) && Number(bet.displayRating) > 0) {
    return Number(bet.displayRating);
  }

  return displayConfidenceRating(bet.legs || [], options);
}

function displayConfidenceRating(legs, { likely = false } = {}) {
  const legRatings = legs.map((leg) => displayLegRating(leg, { likely })).filter((value) => Number.isFinite(value));
  const averageLegRating = mean(legRatings);
  const confidence = mean(legs.map((leg) => leg.confidence));
  const edgeLift = clamp(mean(legs.map((leg) => leg.edge)), 0, 0.18) / 0.18;
  const rating = (averageLegRating * 0.74) + (confidence * 0.16) + (edgeLift * 0.1) + (likely ? 0.035 : 0);

  return round(clamp(rating, 0.58, likely ? 0.97 : 0.95), 4);
}

function displayLegRating(leg, { likely = false } = {}) {
  const probability = Number(likely ? (leg.likelyProbability || likelyWinProbability(leg)) : (leg.modelProbability || leg.likelyProbability || 0));
  const confidence = Number(leg.confidence || 0);
  const intelligence = Number(leg.components?.intelligenceConfidence || 0.5);
  const freshness = Number(leg.components?.oddsFreshness || 0.75);
  const edgeLift = clamp(Number(leg.edge || 0), 0, 0.18) / 0.18;
  const independentLift = clamp(Number(leg.independentEdge ?? leg.edge ?? 0), -0.03, 0.16) / 0.16;
  const evidenceLift = clamp(Number(leg.components?.nonMarketSignalCount || 0) / 4, 0, 1);
  const rawRating = (probability * 0.38) + (confidence * 0.23) + (intelligence * 0.13) + (freshness * 0.07) + (edgeLift * 0.08) + (independentLift * 0.06) + (evidenceLift * 0.05);
  const rating = 0.48 + (rawRating * 0.5) + (likely ? 0.025 : 0);

  return clamp(rating, 0.55, likely ? 0.97 : 0.95);
}

function marketLine(data) {
  const labels = {
    match_winner: "Match winner",
    draw_no_bet: "Draw no bet",
    anytime_scorer: "Anytime scorer",
    both_teams_to_score: "Both teams to score",
    over_2_5_goals: "Over 2.5 goals",
    under_2_5_goals: "Under 2.5 goals"
  };
  const configured = data?.markets?.configured || [];
  const observed = data?.markets?.observed || {};
  const active = configured.map((market) => labels[market] || market).join(", ");
  const scorerCount = Number(observed.anytime_scorer || 0);
  const scorerText = scorerCount ? ` Anytime scorer prices found: ${scorerCount}.` : " Anytime scorer is switched on, but current public sources have not exposed scorer prices yet.";

  return `Markets: ${active}.${scorerText}`;
}

function percent(value) {
  return `${Math.round(Number(value || 0) * 1000) / 10}%`;
}

function recalculateReturn(bet, stake) {
  if (bet.type !== "trixie" || !Array.isArray(bet.legs) || bet.legs.length !== 3) {
    return round(stake * Number(bet.combinedDecimalOdds || 0), 2);
  }

  const odds = bet.legs.map((leg) => Number(leg.decimalOdds || 1));
  const unit = stake / 4;
  return round(unit * ((odds[0] * odds[1]) + (odds[0] * odds[2]) + (odds[1] * odds[2]) + (odds[0] * odds[1] * odds[2])), 2);
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") {
    return;
  }

  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
