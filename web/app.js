const state = {
  data: null,
  renderTimer: null,
  renderFrame: null,
  scrollTimer: null,
  renderPending: false,
  riskInteracting: false,
  isScrolling: false,
  lineupRefreshTimer: null,
  profileCache: new Map(),
  pickProfileCache: new Map(),
  scorerCache: new Map()
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
  automaticRunMinutesUtc: [323, 503, 683, 863, 1043, 1223, 1283, 1403],
  gatheringWindowMinutes: 5,
  gatheringMessage: "Data Gathering: Come back in 5"
};
const scorerLineupGate = {
  maxMinutesBeforeKickoff: 75,
  minMinutesBeforeKickoff: -10,
  refreshMs: 120000
};
const usageInstructions = "1. Input stake per bet 2. Choose Date From 3. Choose Date To 4. Adjust risk slider 5. We add our secret sauce and some luck, we don't just go by the bookies! Enjoy!";

const el = {
  scanStamp: document.getElementById("scanStamp"),
  gatheringNotice: document.getElementById("gatheringNotice"),
  stake: document.getElementById("stakeInput"),
  dateFrom: document.getElementById("dateFromInput"),
  dateTo: document.getElementById("dateToInput"),
  risk: document.getElementById("riskInput"),
  riskSteps: document.querySelectorAll("[data-risk-step]"),
  riskValue: document.getElementById("riskValue"),
  engineNotes: document.getElementById("engineNotes"),
  fixtureCount: document.getElementById("fixtureCount"),
  edgeCount: document.getElementById("edgeCount"),
  memoryCount: document.getElementById("memoryCount"),
  returnTotal: document.getElementById("returnTotal"),
  marketLine: document.getElementById("marketLine"),
  betslip: document.getElementById("betslipList"),
  pickOfDay: document.getElementById("pickOfDayList"),
  likelyScorers: document.getElementById("likelyScorersList")
};

for (const input of [el.stake, el.dateFrom, el.dateTo, el.risk]) {
  input.addEventListener("input", () => handleControlInput(input));
}

el.risk.addEventListener("pointerdown", beginRiskInteraction, { passive: true });
el.risk.addEventListener("pointerup", endRiskInteraction, { passive: true });
el.risk.addEventListener("pointercancel", endRiskInteraction, { passive: true });
el.risk.addEventListener("touchstart", beginRiskInteraction, { passive: true });
el.risk.addEventListener("touchend", endRiskInteraction, { passive: true });
el.risk.addEventListener("touchcancel", endRiskInteraction, { passive: true });
el.risk.addEventListener("change", endRiskInteraction);
window.addEventListener("scroll", handleScroll, { passive: true });

for (const button of el.riskSteps) {
  button.addEventListener("click", () => adjustRisk(Number(button.dataset.riskStep || 0)));
}

loadData();
registerServiceWorker();

async function loadData() {
  el.scanStamp.textContent = "Loading latest database...";

  try {
    const [database, lineups] = await Promise.all([
      fetchRequiredJson("./data/latest.json"),
      fetchOptionalJson("./data/lineups-latest.json")
    ]);

    state.data = database;
    state.data.lineupAdjustments = lineups;
    clearRenderCaches();
    initialiseDateInputs();
    render();
    startLineupRefresh();
  } catch (error) {
    el.scanStamp.textContent = `No generated database yet: ${error.message}`;
    el.betslip.innerHTML = `<article class="bet-card">Run <strong>npm run web:build-data</strong> locally or let GitHub Actions publish the latest database.</article>`;
  }
}

async function fetchRequiredJson(path) {
  const response = await fetch(`${path}?v=${Date.now()}`);

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function fetchOptionalJson(path) {
  try {
    const response = await fetch(`${path}?v=${Date.now()}`);

    if (!response.ok) {
      return null;
    }

    return response.json();
  } catch {
    return null;
  }
}

function startLineupRefresh() {
  if (state.lineupRefreshTimer) {
    clearInterval(state.lineupRefreshTimer);
  }

  state.lineupRefreshTimer = setInterval(refreshLineupAdjustments, scorerLineupGate.refreshMs);
}

async function refreshLineupAdjustments() {
  if (!state.data || !hasLineupSensitiveFixture(state.data)) {
    return;
  }

  const lineups = await fetchOptionalJson("./data/lineups-latest.json");

  if (!lineups) {
    return;
  }

  const previousKey = lineupFeedKey(state.data.lineupAdjustments);
  const nextKey = lineupFeedKey(lineups);

  if (nextKey === previousKey) {
    return;
  }

  state.data.lineupAdjustments = lineups;
  clearRenderCaches();
  render();
}

function lineupFeedKey(lineups) {
  return `${lineups?.generatedAt || ""}|${lineups?.lineups?.length || 0}|${lineups?.diagnostics?.length || 0}`;
}

function hasLineupSensitiveFixture(data) {
  return (data?.fixtures || []).some((fixture) => {
    const minutes = minutesUntilKickoff(fixture);
    return minutes >= -15 && minutes <= 130;
  });
}

function handleControlInput(input) {
  if (input === el.risk) {
    el.riskValue.textContent = el.risk.value;
    scheduleRender(state.riskInteracting ? 320 : 180);
    return;
  }

  scheduleRender(input === el.stake ? 0 : 80);
}

function beginRiskInteraction() {
  state.riskInteracting = true;
}

function endRiskInteraction() {
  state.riskInteracting = false;
  el.riskValue.textContent = el.risk.value;
  scheduleRender(0);
}

function adjustRisk(step) {
  const min = Number(el.risk.min || 0);
  const max = Number(el.risk.max || 100);
  const next = Math.max(min, Math.min(max, Number(el.risk.value || 0) + step));

  el.risk.value = String(next);
  el.riskValue.textContent = el.risk.value;
  scheduleRender(0);
}

function handleScroll() {
  state.isScrolling = true;

  if (state.scrollTimer) {
    clearTimeout(state.scrollTimer);
  }

  state.scrollTimer = setTimeout(() => {
    state.isScrolling = false;

    if (state.renderPending) {
      scheduleRender(0);
    }
  }, 140);
}

function scheduleRender(delayMs = 0) {
  if (!state.data) {
    return;
  }

  state.renderPending = true;

  if (state.renderTimer) {
    clearTimeout(state.renderTimer);
    state.renderTimer = null;
  }

  if (delayMs > 0) {
    state.renderTimer = setTimeout(flushScheduledRender, delayMs);
  } else {
    flushScheduledRender();
  }
}

function flushScheduledRender() {
  state.renderTimer = null;

  if (!state.renderPending) {
    return;
  }

  if (state.riskInteracting || state.isScrolling) {
    state.renderTimer = setTimeout(flushScheduledRender, state.riskInteracting ? 180 : 120);
    return;
  }

  state.renderPending = false;

  if (state.renderFrame) {
    cancelAnimationFrame(state.renderFrame);
  }

  state.renderFrame = requestAnimationFrame(() => {
    state.renderFrame = null;
    render();
  });
}

function clearRenderCaches() {
  state.profileCache.clear();
  state.pickProfileCache.clear();
  state.scorerCache.clear();
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
  renderLikelyGoalscorers(buildLikelyGoalscorersToday(state.data));
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
  if (Number(riskBucket || 0) <= 0) {
    const pickProfile = buildPickOfDayRangeProfile({ data, dateRange });
    return rememberCache(state.profileCache, rangeCacheKey(data, riskBucket, dateRange), {
      ...pickProfile,
      risk: riskBucket,
      riskProfile: data.riskProfiles?.[riskBucket] || { mode: "most_likely" }
    });
  }

  const cacheKey = rangeCacheKey(data, riskBucket, dateRange);

  if (state.profileCache.has(cacheKey)) {
    return state.profileCache.get(cacheKey);
  }

  if (!data.legCandidatesByRisk) {
    const fallbackRisk = nearest(data.riskBuckets || [riskBucket], riskBucket);
    const fallbackDay = nearest(data.dayBuckets || [14], 14);
    return rememberCache(state.profileCache, cacheKey, data.profiles?.[`d${fallbackDay}_r${fallbackRisk}`] || Object.values(data.profiles || {})[0] || null);
  }

  const fixtures = fixturesInRange(data.fixtures || [], dateRange);
  const fixtureIds = new Set(fixtures.map((fixture) => fixture.id));
  const candidates = (data.legCandidatesByRisk[riskBucket] || [])
    .filter((leg) => fixtureIds.has(leg.fixtureId));
  const policy = { riskProfile: data.riskProfiles?.[riskBucket] || {} };
  const recommendations = buildBetRecommendations(candidates, policy);

  return rememberCache(state.profileCache, cacheKey, {
    dateFrom: dateRange.from,
    dateTo: dateRange.to,
    risk: riskBucket,
    dataQuality: data.collection?.dataQuality,
    fixtureCount: fixtures.length,
    eligibleLegCount: recommendations.eligibleLegCount,
    betslip: selectRangeBetslip({ recommendations, risk: riskBucket })
  });
}

function buildPickOfDayRangeProfile({ data, dateRange }) {
  const cacheKey = rangeCacheKey(data, "pick", dateRange);

  if (state.pickProfileCache.has(cacheKey)) {
    return state.pickProfileCache.get(cacheKey);
  }

  const fixtures = fixturesInRange(data.fixtures || [], dateRange);
  const fixtureIds = new Set(fixtures.map((fixture) => fixture.id));
  const candidates = (data.mostLikelyLegCandidates || [])
    .filter((leg) => fixtureIds.has(leg.fixtureId));

  return rememberCache(state.pickProfileCache, cacheKey, {
    dateFrom: dateRange.from,
    dateTo: dateRange.to,
    mode: "most_likely",
    dataQuality: data.collection?.dataQuality,
    fixtureCount: fixtures.length,
    eligibleLegCount: candidates.length,
    betslip: buildMostLikelyPicks(candidates, { fixtureCount: fixtures.length })
  });
}

function rangeCacheKey(data, bucket, dateRange) {
  return [
    data?.generatedAt || "database",
    data?.lineupAdjustments?.generatedAt || "",
    bucket,
    dateRange.from,
    dateRange.to
  ].join("|");
}

function rememberCache(cache, key, value) {
  cache.set(key, value);

  if (cache.size > 36) {
    cache.delete(cache.keys().next().value);
  }

  return value;
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
            <span class="leg-note">${escapeHtml(formatLegNoteWithKickoff(leg, false))}</span>
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
            <span class="leg-note">${escapeHtml(formatLegNoteWithKickoff(leg, true))}</span>
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

function renderLikelyGoalscorers(groups) {
  if (!el.likelyScorers) {
    return;
  }

  if (!groups.length) {
    el.likelyScorers.innerHTML = `
      <article class="scorer-card unavailable">
        <header>
          <span class="tag scorer-tag">Today</span>
          <span class="score">waiting</span>
        </header>
        <p class="why">No World Cup fixtures are listed for today in the current database.</p>
      </article>
    `;
    return;
  }

  el.likelyScorers.innerHTML = groups.map((group) => {
    const emptyText = group.lineupNotice || "Scorer data is still building for this game.";
    const players = group.players.length
      ? group.players.map((player, index) => `
        <li>
          <span class="rank">${index + 1}</span>
          <div>
            <strong>${escapeHtml(player.playerName)}</strong>
            <span>${escapeHtml(player.team)} | ${escapeHtml(player.reason)}</span>
          </div>
          <em>${percent(player.probability)}</em>
        </li>
      `).join("")
      : `<li class="empty-scorers">${escapeHtml(emptyText)}</li>`;
    const notice = group.lineupNotice && group.players.length
      ? `<p class="why">${escapeHtml(group.lineupNotice)}</p>`
      : "";

    return `
      <article class="scorer-card">
        <header>
          <span class="tag scorer-tag">${escapeHtml(group.fixtureLabel)}</span>
          <span class="score">${escapeHtml(formatKickoff(group.fixture.date))}</span>
        </header>
        <ol class="scorers">
          ${players}
        </ol>
        ${notice}
      </article>
    `;
  }).join("");
}

function buildLikelyGoalscorersToday(data, today = localDateKey(new Date())) {
  const cacheKey = `${data?.generatedAt || "database"}|${data?.lineupAdjustments?.generatedAt || ""}|${today}`;

  if (state.scorerCache.has(cacheKey)) {
    return state.scorerCache.get(cacheKey);
  }

  const fixtures = (data?.fixtures || [])
    .filter((fixture) => (fixture.dateKey || dateKey(fixture.date)) === today)
    .sort((left, right) => new Date(left.date) - new Date(right.date));

  return rememberCache(state.scorerCache, cacheKey, fixtures.map((fixture) => {
    const players = likelyGoalscorersForFixture(data, fixture).slice(0, 4);

    return {
      fixture,
      fixtureLabel: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
      players,
      lineupNotice: scorerLineupNotice(data, fixture, players)
    };
  }));
}

function likelyGoalscorersForFixture(data, fixture) {
  const byPlayer = new Map();
  const model = fixtureModelComponents(data, fixture.id);
  const legs = scorerLegCandidates(data, fixture.id);
  const firstScorerLegs = legs.filter((leg) => leg.market === "first_goalscorer");
  const anytimeScorerLegs = legs.filter((leg) => leg.market === "anytime_scorer");

  if (firstScorerLegs.length) {
    addScorerOddsCandidates({ byPlayer, data, fixture, legs: firstScorerLegs, preferredMarket: "first_goalscorer" });
    if (byPlayer.size < 4) {
      addScorerMemoryCandidates({ byPlayer, data, fixture, model, mode: "first_goalscorer", maxPerTeam: 5 });
    }
  } else if (anytimeScorerLegs.length) {
    addScorerOddsCandidates({ byPlayer, data, fixture, legs: anytimeScorerLegs, preferredMarket: "anytime_scorer" });
    if (byPlayer.size < 4) {
      addScorerMemoryCandidates({ byPlayer, data, fixture, model, mode: "anytime_scorer", maxPerTeam: 5 });
    }
  } else {
    addScorerMemoryCandidates({ byPlayer, data, fixture, model, mode: "anytime_scorer", maxPerTeam: 8 });
  }

  return applyLineupAdjustments([...byPlayer.values()], data, fixture)
    .sort((left, right) => scorerRankScore(right) - scorerRankScore(left));
}

function addScorerMemoryCandidates({ byPlayer, data, fixture, model, mode = "anytime_scorer", maxPerTeam = 8 }) {
  const teamPlayers = data?.playerStats?.teams || {};
  const firstScorerMode = mode === "first_goalscorer";

  for (const side of ["home", "away"]) {
    const team = side === "home" ? fixture.homeTeam : fixture.awayTeam;
    const players = teamPlayers[team] || [];
    const teamExpectedGoals = Number(model?.[`${side}ExpectedGoals`] || model?.expectedGoals) / (model?.[`${side}ExpectedGoals`] ? 1 : 2) || 1.25;
    const teamGoalChance = 1 - Math.exp(-teamExpectedGoals);
    const totalExpectedGoals = Math.max(0.2, Number(model?.expectedGoals || teamExpectedGoals * 2));
    const teamFirstGoalShare = clamp(teamExpectedGoals / totalExpectedGoals, 0.18, 0.82);
    const topGoalTotal = Math.max(1, players.slice(0, 8).reduce((total, player) => total + Number(player.goalsPerTwentyTeamMatches || player.goals || 0), 0));

    for (const player of players.slice(0, maxPerTeam)) {
      const playerGoals = Number(player.goalsPerTwentyTeamMatches || player.goals || 0);
      if (!player.playerName || playerGoals <= 0) {
        continue;
      }

      const scoringRate = clamp(playerGoals / Number(player.matchesSampled || 20), 0.02, 0.85);
      const scorerShare = clamp(playerGoals / (topGoalTotal + 4), 0.04, 0.5);
      const confidence = Number(player.scorerConfidence || 0.45);
      const probability = clamp(
        (scoringRate * 0.43)
          + (teamGoalChance * scorerShare * 0.44)
          + (teamExpectedGoals * scorerShare * 0.12)
          + (confidence * 0.015),
        0.03,
        0.46
      );
      const firstGoalProbability = clamp(
        probability * teamFirstGoalShare * 0.58,
        0.018,
        0.18
      );

      upsertScorerCandidate(byPlayer, {
        playerName: player.playerName,
        team,
        probability: firstScorerMode ? firstGoalProbability : probability,
        confidence,
        market: mode,
        sourceWeight: firstScorerMode ? 0.28 : 0.72,
        reason: firstScorerMode
          ? `first-scorer fallback from ${round(playerGoals, 1)} goals in last ${Number(player.matchesSampled || 20)} team games; ${round(teamExpectedGoals, 2)} team xG`
          : `${round(playerGoals, 1)} goals in last ${Number(player.matchesSampled || 20)} team games; ${round(teamExpectedGoals, 2)} team xG`
      }, data, fixture);
    }
  }
}

function addScorerOddsCandidates({ byPlayer, data, fixture, legs, preferredMarket }) {
  for (const leg of legs) {
    const playerName = leg.playerName || leg.outcome;
    if (!playerName) {
      continue;
    }

    const baseProbability = Number(leg.modelProbability || leg.rawModelProbability || leg.likelyProbability || 0);
    const probability = leg.market === "first_goalscorer"
      ? clamp(baseProbability, 0.018, 0.34)
      : clamp(baseProbability, 0.04, 0.58);
    const bookmaker = leg.bookmaker ? ` via ${leg.bookmaker}` : "";
    const oddsText = leg.decimalOdds ? ` @ ${Number(leg.decimalOdds).toFixed(2)}` : "";
    const label = leg.market === "first_goalscorer" ? "first-goalscorer odds" : "anytime-scorer odds";

    upsertScorerCandidate(byPlayer, {
      playerName,
      team: playerTeamFromScorerData(leg, fixture, data),
      probability,
      confidence: Number(leg.confidence || 0.5),
      market: leg.market,
      sourceWeight: leg.market === preferredMarket ? 1.25 : 0.82,
      reason: `${label}${bookmaker}${oddsText}`
    }, data, fixture);
  }
}

function scorerLegCandidates(data, fixtureId) {
  const fromRisks = Object.values(data?.legCandidatesByRisk || {}).flat();
  const legs = [
    ...(data?.mostLikelyLegCandidates || []),
    ...fromRisks
  ];
  const seen = new Set();

  return legs.filter((leg) => {
    if (leg.fixtureId !== fixtureId || !isScorerLeg(leg)) {
      return false;
    }

    const key = `${leg.market}:${normalizeLookupKey(leg.playerName || leg.outcome)}:${normalizeLookupKey(leg.playerTeam)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function fixtureModelComponents(data, fixtureId) {
  const candidates = [
    ...(data?.mostLikelyLegCandidates || []),
    ...Object.values(data?.legCandidatesByRisk || {}).flat()
  ];
  const leg = candidates.find((candidate) => candidate.fixtureId === fixtureId && (candidate.components || candidate.thesis));
  const components = { ...(leg?.components || {}) };
  const thesisExpectedGoals = parseThesisExpectedGoals(leg?.thesis);

  if (thesisExpectedGoals && !Number(components.homeExpectedGoals)) {
    components.expectedGoals = thesisExpectedGoals.total;
    components.homeExpectedGoals = thesisExpectedGoals.home;
    components.awayExpectedGoals = thesisExpectedGoals.away;
  }

  return components;
}

function parseThesisExpectedGoals(thesis) {
  const match = String(thesis || "").match(/expected goals\s+([\d.]+)\s+\(([\d.]+)-([\d.]+)\)/i);

  if (!match) {
    return null;
  }

  return {
    total: Number(match[1]),
    home: Number(match[2]),
    away: Number(match[3])
  };
}

function upsertScorerCandidate(byPlayer, candidate, data, fixture) {
  const canonical = canonicalScorerIdentity(candidate, data, fixture);
  const existingEntry = byPlayer.get(canonical.key)
    ? [canonical.key, byPlayer.get(canonical.key)]
    : [...byPlayer.entries()].find(([, player]) => sameTeam(player.team, candidate.team) && playerNamesMatch(player.playerName, canonical.playerName));
  const key = existingEntry?.[0] || canonical.key;
  const existing = existingEntry?.[1];
  const displayName = betterDisplayPlayerName(canonical.playerName, existing?.playerName || candidate.playerName);

  if (!existing) {
    byPlayer.set(key, { ...candidate, playerName: displayName });
    return;
  }

  const keepCandidateReason = Number(candidate.sourceWeight || 0) >= Number(existing.sourceWeight || 0)
    || candidate.market === "first_goalscorer";
  const probability = (existing.probability * existing.sourceWeight + candidate.probability * candidate.sourceWeight)
    / Math.max(0.01, existing.sourceWeight + candidate.sourceWeight);
  byPlayer.set(key, {
    ...existing,
    ...candidate,
    playerName: displayName,
    probability: clamp(probability, 0.03, 0.54),
    confidence: Math.max(Number(existing.confidence || 0), Number(candidate.confidence || 0)),
    sourceWeight: existing.sourceWeight + candidate.sourceWeight,
    reason: keepCandidateReason ? candidate.reason : existing.reason
  });
}

function scorerRankScore(player) {
  return Number(player.probability || 0) * 100
    + Number(player.confidence || 0) * 4
    + Math.min(4, Number(player.sourceWeight || 0));
}

function playerTeamFromScorerData(leg, fixture, data) {
  if (leg.playerTeam) {
    return leg.playerTeam;
  }

  const playerKey = normalizeLookupKey(leg.playerName || leg.outcome);
  const teams = data?.playerStats?.teams || {};

  for (const team of [fixture.homeTeam, fixture.awayTeam]) {
    if ((teams[team] || []).some((player) => normalizeLookupKey(player.playerName) === playerKey)) {
      return team;
    }
  }

  return "Unknown team";
}

function canonicalScorerIdentity(candidate, data, fixture) {
  const team = candidate.team || "Unknown team";
  const names = knownPlayerNamesForTeam(data, fixture, team);
  const directName = candidate.playerName || "";
  const matched = names
    .filter((name) => playerNamesMatch(name, directName))
    .sort((left, right) => normalizeLookupKey(right).split(/\s+/).filter(Boolean).length - normalizeLookupKey(left).split(/\s+/).filter(Boolean).length)[0];
  const playerName = matched ? betterDisplayPlayerName(matched, directName) : directName;

  return {
    key: `${normalizeLookupKey(team)}:${normalizeLookupKey(playerName)}`,
    playerName
  };
}

function knownPlayerNamesForTeam(data, fixture, team) {
  const names = [];
  const teams = data?.playerStats?.teams || {};
  const lineup = teamLineup(data, fixture, team);

  for (const player of teams[team] || []) {
    if (player.playerName) {
      names.push(player.playerName);
    }
  }

  for (const starter of lineup?.starters || []) {
    names.push(starter);
  }

  for (const leg of scorerLegCandidates(data, fixture.id)) {
    if (sameTeam(playerTeamFromScorerData(leg, fixture, data), team) && (leg.playerName || leg.outcome)) {
      names.push(leg.playerName || leg.outcome);
    }
  }

  return names.filter(Boolean).filter((name, index, items) => items.findIndex((other) => normalizeLookupKey(other) === normalizeLookupKey(name)) === index);
}

function betterDisplayPlayerName(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  const aWords = normalizeLookupKey(a).split(/\s+/).filter(Boolean).length;
  const bWords = normalizeLookupKey(b).split(/\s+/).filter(Boolean).length;

  if (!a) {
    return b;
  }

  if (!b) {
    return a;
  }

  return bWords > aWords ? b : a;
}

function playerNamesMatch(left, right) {
  const a = normalizeLookupKey(left);
  const b = normalizeLookupKey(right);

  if (!a || !b) {
    return false;
  }

  if (a === b || a.endsWith(` ${b}`) || b.endsWith(` ${a}`)) {
    return true;
  }

  const aTokens = a.split(/\s+/).filter(Boolean);
  const bTokens = b.split(/\s+/).filter(Boolean);
  const aSurname = aTokens.at(-1);
  const bSurname = bTokens.at(-1);

  return Boolean(aSurname && bSurname && aSurname.length > 3 && aSurname === bSurname);
}

function applyLineupAdjustments(players, data, fixture) {
  const lineup = lineupForFixture(data, fixture);
  const lineupRequired = isLineupRequiredForFixture(fixture);

  if (!lineup) {
    return lineupRequired
      ? players.map((player) => ({
        ...player,
        lineupStatus: "lineup_unavailable",
        reason: `${player.reason} | team sheets not found yet`
      }))
      : players;
  }

  const adjusted = [];

  for (const player of players) {
    const team = teamLineupFromRecord(lineup, player.team);
    const teamUsable = isUsableTeamLineup(team);

    if (!teamUsable) {
      adjusted.push(lineupRequired
        ? {
          ...player,
          lineupStatus: "lineup_unavailable",
          reason: `${player.reason} | ${player.team || "team"} XI not found yet`
        }
        : player);
      continue;
    }

    const starterName = team.starters.find((starter) => playerNamesMatch(starter, player.playerName));
    const status = team.status === "confirmed" ? "confirmed_starter" : "predicted_starter";
    const statusText = team.status === "confirmed" ? "confirmed starter" : "predicted starter";

    if (!starterName) {
      if (!lineupRequired) {
        adjusted.push({
          ...player,
          lineupStatus: team.status === "confirmed" ? "not_starting" : "not_predicted_starter",
          probability: clamp(Number(player.probability || 0) * 0.08, 0.01, 0.08),
          confidence: clamp(Number(player.confidence || 0) * 0.55, 0, 1),
          sourceWeight: Number(player.sourceWeight || 0) * 0.35,
          reason: `${player.reason} | not in ${team.status === "confirmed" ? "confirmed" : "predicted"} XI`
        });
      }
      continue;
    }

    adjusted.push({
      ...player,
      playerName: betterDisplayPlayerName(starterName, player.playerName),
      lineupStatus: status,
      reason: `${player.reason} | ${statusText}`
    });
  }

  if (lineupRequired) {
    const starters = adjusted.filter((player) => ["confirmed_starter", "predicted_starter", "lineup_unavailable"].includes(player.lineupStatus));
    return starters.length ? starters : players.map((player) => ({
      ...player,
      lineupStatus: "lineup_inconclusive",
      reason: `${player.reason} | lineup check inconclusive`
    }));
  }

  const starterOnly = adjusted.filter((player) => !["not_starting", "not_predicted_starter"].includes(player.lineupStatus));
  return starterOnly.length ? starterOnly : adjusted;
}

function lineupForFixture(data, fixture) {
  const records = data?.lineupAdjustments?.lineups || [];

  return records.find((record) => record.fixtureId === fixture.id)
    || records.find((record) => sameTeam(record.homeTeam, fixture.homeTeam)
      && sameTeam(record.awayTeam, fixture.awayTeam)
      && String(record.fixtureDate || "").slice(0, 10) === (fixture.dateKey || dateKey(fixture.date)))
    || null;
}

function teamLineup(data, fixture, teamName) {
  const lineup = lineupForFixture(data, fixture);
  return teamLineupFromRecord(lineup, teamName);
}

function teamLineupFromRecord(lineup, teamName) {
  if (!lineup?.teams || !teamName) {
    return null;
  }

  const exact = lineup.teams[teamName];

  if (exact) {
    return exact;
  }

  const entry = Object.entries(lineup.teams).find(([team]) => sameTeam(team, teamName));
  return entry?.[1] || null;
}

function scorerLineupNotice(data, fixture, players) {
  if (!isLineupRequiredForFixture(fixture)) {
    return "";
  }

  const lineup = lineupForFixture(data, fixture);

  if (!lineup) {
    return players.length
      ? "Team sheets are not available yet; showing model scorer picks until the lineup check lands."
      : "Team sheets are not available yet and scorer data is still building.";
  }

  const missingTeams = [fixture.homeTeam, fixture.awayTeam]
    .filter((team) => !isConfirmedTeamLineup(teamLineupFromRecord(lineup, team)));
  const predictedTeams = missingTeams
    .filter((team) => isPredictedTeamLineup(teamLineupFromRecord(lineup, team)));

  if (!players.length && missingTeams.length) {
    return `Lineup check is still incomplete for ${missingTeams.join(" and ")}; showing no scorer candidate would be unsafe.`;
  }

  if (!players.length) {
    return "Confirmed lineups were found, but no scorer candidate matched the starting XIs.";
  }

  if (predictedTeams.length) {
    return `Confirmed XI not published yet for ${predictedTeams.join(" and ")}; showing predicted starters from the lineup check.`;
  }

  if (missingTeams.length) {
    return `Showing available scorer picks while waiting for confirmed ${missingTeams.join(" and ")} XI.`;
  }

  return "";
}

function isConfirmedTeamLineup(team) {
  return team?.status === "confirmed" && Array.isArray(team.starters) && team.starters.length >= 7;
}

function isPredictedTeamLineup(team) {
  return team?.status === "predicted" && Array.isArray(team.starters) && team.starters.length >= 7;
}

function isUsableTeamLineup(team) {
  return ["confirmed", "predicted"].includes(team?.status) && Array.isArray(team.starters) && team.starters.length >= 7;
}

function isLineupRequiredForFixture(fixture, now = new Date()) {
  const minutes = minutesUntilKickoff(fixture, now);
  return minutes >= scorerLineupGate.minMinutesBeforeKickoff
    && minutes <= scorerLineupGate.maxMinutesBeforeKickoff;
}

function minutesUntilKickoff(fixture, now = new Date()) {
  return (new Date(fixture.date).getTime() - now.getTime()) / 60000;
}

function sameTeam(left, right) {
  const a = normalizeLookupKey(left);
  const b = normalizeLookupKey(right);

  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function localDateKey(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatKickoff(value) {
  if (!value) {
    return "today";
  }

  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatLegNoteWithKickoff(leg, likely = false) {
  const note = likely ? formatLikelyLegNote(leg) : formatLegNote(leg);
  const kickoff = formatLegKickoff(leg);

  return kickoff ? `${kickoff} | ${note}` : note;
}

function formatLegKickoff(leg) {
  const date = new Date(leg.fixtureDate || "");

  if (!Number.isFinite(date.getTime())) {
    return "";
  }

  const formatted = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);

  return `Kickoff ${formatted}`;
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
  const singles = rankCombos(eligibleLegs.map((leg) => [leg]), "single", policy);
  const doubles = rankCombosWithFallback(
    combinations(eligibleLegs.slice(0, 30), 2, 10000),
    "double",
    policy,
    eligibleLegs,
    2
  ).slice(0, 8);
  const trixies = rankCombosWithFallback(
    combinations(eligibleLegs.slice(0, 28), 3, 12000),
    "trixie",
    policy,
    eligibleLegs,
    3
  ).slice(0, 8);

  return {
    eligibleLegCount: eligibleLegs.length,
    singles,
    doubles,
    trixies,
    accumulatorsByLegCount,
    accumulators: Object.values(accumulatorsByLegCount).flat().sort((left, right) => right.score - left.score).slice(0, 16)
  };
}

function buildAccumulatorRecommendationsByLegCount(eligibleLegs, policy) {
  const byLegCount = {};

  for (const size of [3, 4, 5, 6, 8]) {
    const pool = eligibleLegs.slice(0, accumulatorPoolSize(size));
    byLegCount[size] = rankCombosWithFallback(
      combinations(pool, size, accumulatorCombinationLimit(size)),
      "accumulator",
      policy,
      eligibleLegs,
      size
    ).slice(0, 8);
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

function legSignalKey(leg) {
  return [
    fixtureKeyForLeg(leg),
    normalizeFixtureName(leg.market),
    normalizeFixtureName(leg.outcome || ""),
    normalizeFixtureName(leg.playerName || ""),
    normalizeFixtureName(leg.selectionLabel || "")
  ].join("|");
}

function hasSelectedLegSignal(selected, leg) {
  const key = legSignalKey(leg);
  return selected.some((item) => item.id === leg.id || legSignalKey(item) === key);
}

function normalizeFixtureName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, "_");
}

function normalizeLookupKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function rankCombos(combos, type, policy) {
  return combos
    .map((legs) => scoreCombo(legs, type, policy))
    .filter((combo) => combo && !combo.hardBlocks.length)
    .sort((left, right) => right.score - left.score);
}

function rankCombosWithFallback(combos, type, policy, eligibleLegs, legCount) {
  const ranked = rankCombos(combos, type, policy);

  if (ranked.length) {
    return ranked;
  }

  const fallback = buildShortWindowFallbackCombo(eligibleLegs, type, policy, legCount);
  return fallback ? [fallback] : [];
}

function buildShortWindowFallbackCombo(eligibleLegs, type, policy, legCount) {
  const selected = selectShortWindowFallbackLegs(eligibleLegs, policy, legCount);

  if (selected.length !== legCount) {
    return null;
  }

  const uniqueFixtureCount = new Set(selected.map(fixtureKeyForLeg)).size;
  const combo = scoreCombo(selected, type, policy, {
    allowSameFixture: uniqueFixtureCount < selected.length,
    relaxPreferredOdds: true,
    relaxAbsoluteOdds: true,
    relaxTrixieRiskLeg: true,
    relaxFavouriteOnly: true,
    shortWindowFallback: true
  });

  if (!combo || combo.hardBlocks.length) {
    return null;
  }

  return combo;
}

function selectShortWindowFallbackLegs(eligibleLegs, policy, legCount) {
  const selected = [];
  const selectedIds = new Set();
  const uniqueFixtures = new Set((eligibleLegs || []).map(fixtureKeyForLeg));
  const targetUniqueFixtures = Math.min(legCount, uniqueFixtures.size);
  const cappedPool = shortWindowFallbackPool(eligibleLegs, policy, legCount);
  const ranked = cappedPool
    .map((leg) => ({ leg, score: shortWindowLegScore(leg, policy, legCount) }))
    .sort((left, right) => right.score - left.score)
    .map((item) => item.leg);

  addShortWindowLegs({
    selected,
    selectedIds,
    pool: ranked,
    legCount: targetUniqueFixtures,
    allowSameFixture: false,
    policy
  });

  addShortWindowLegs({
    selected,
    selectedIds,
    pool: ranked,
    legCount,
    allowSameFixture: true,
    policy
  });

  upgradeShortWindowPayout({ selected, selectedIds, pool: ranked, policy, legCount });

  return selected;
}

function shortWindowFallbackPool(eligibleLegs, policy, legCount) {
  const appetite = riskAppetiteFromPolicy(policy);
  const riskProfile = policy.riskProfile || {};
  const maxCombinedOdds = Number(riskProfile.maxCombinedOdds || 50);
  const perLegCombinedCap = legCount > 1 && maxCombinedOdds > 1
    ? Math.pow(maxCombinedOdds, 1 / legCount) * (1.04 + appetite * 0.42)
    : Infinity;
  const marketAwareCap = shortWindowMaxLegOdds(legCount, appetite);
  const primaryCap = Math.max(1.18, Math.min(perLegCombinedCap || Infinity, marketAwareCap));
  const sorted = [...(eligibleLegs || [])]
    .filter((leg) => Number(leg.modelProbability || 0) > 0)
    .filter((leg) => Number(leg.decimalOdds || 0) > 1)
    .sort((left, right) => shortWindowLegScore(right, policy, legCount) - shortWindowLegScore(left, policy, legCount));
  const safeSorted = sorted.filter((leg) => shortWindowSafetyCandidateAllowed(leg, policy, legCount));
  const pool = safeSorted.length ? safeSorted : sorted;
  const capped = pool.filter((leg) => Number(leg.decimalOdds || 99) <= primaryCap);

  if (capped.length >= legCount) {
    return capped;
  }

  const relaxedMultiplier = legCount >= 6
    ? 1.05 + appetite * 0.45
    : 1.15 + appetite * 0.7;
  const relaxedCap = Math.max(primaryCap, marketAwareCap * relaxedMultiplier);
  const relaxed = pool.filter((leg) => Number(leg.decimalOdds || 99) <= relaxedCap);

  return relaxed.length >= legCount ? relaxed : pool;
}

function shortWindowMaxLegOdds(legCount, appetite) {
  if (legCount >= 8) {
    return 2.2 + appetite * 1.8;
  }

  if (legCount >= 6) {
    return 2.45 + appetite * 2.35;
  }

  if (legCount >= 4) {
    return 3.3 + appetite * 3.2;
  }

  if (legCount >= 3) {
    return 3.4 + appetite * 3.2;
  }

  return 3 + appetite * 4;
}

function addShortWindowLegs({ selected, selectedIds, pool, legCount, allowSameFixture, policy }) {
  while (selected.length < legCount) {
    const baseCandidates = pool
      .filter((leg) => !selectedIds.has(leg.id))
      .filter((leg) => shortWindowSafetyCandidateAllowed(leg, policy, legCount))
      .filter((leg) => allowSameFixture || !selected.some((item) => fixtureKeyForLeg(item) === fixtureKeyForLeg(leg)));
    const strictCandidates = baseCandidates.filter((leg) => shortWindowCandidateAllowed(leg, selected, policy, legCount, { allowSameFixture }));

    if (!strictCandidates.length) {
      break;
    }

    const candidate = strictCandidates
      .map((leg) => ({
        leg,
        fit: shortWindowPortfolioFit(leg, selected, policy)
      }))
      .sort((left, right) => right.fit - left.fit)[0]?.leg;

    if (!candidate) {
      break;
    }

    selected.push(candidate);
    selectedIds.add(candidate.id);
  }
}

function shortWindowSafetyCandidateAllowed(leg, policy, legCount) {
  const appetite = riskAppetiteFromPolicy(policy);
  const decimalOdds = Number(leg.decimalOdds || 99);

  return decimalOdds > 1 && decimalOdds <= shortWindowFallbackMaxLegOdds(legCount, appetite);
}

function shortWindowFallbackMaxLegOdds(legCount, appetite) {
  if (legCount >= 8) {
    return 4.35 + appetite * 0.85;
  }

  if (legCount >= 6) {
    return 4.25 + appetite * 1.35;
  }

  if (legCount >= 4) {
    return 5 + appetite * 1.6;
  }

  return 6 + appetite * 2;
}

function shortWindowFallbackCombinedOddsCap(legCount, appetite, uniqueFixtureCount = legCount) {
  const fullCoverageCap = legCount >= 8
    ? 220 + appetite * 630
    : legCount >= 6
      ? 140 + appetite * 380
      : legCount >= 5
        ? 95 + appetite * 265
        : legCount >= 4
          ? 60 + appetite * 180
          : legCount >= 3
            ? 35 + appetite * 85
            : Infinity;

  if (!Number.isFinite(fullCoverageCap)) {
    return fullCoverageCap;
  }

  const coverage = clamp(Number(uniqueFixtureCount || legCount) / Math.max(1, legCount), 0.2, 1);
  return fullCoverageCap * (0.45 + coverage * 0.55);
}

function shortWindowCandidateAllowed(leg, selected, policy, legCount, { allowSameFixture = false } = {}) {
  const appetite = riskAppetiteFromPolicy(policy);
  const sameFixtureCount = selected.filter((item) => fixtureKeyForLeg(item) === fixtureKeyForLeg(leg)).length;
  const sameMarketInFixture = selected.some((item) => fixtureKeyForLeg(item) === fixtureKeyForLeg(leg) && item.market === leg.market);
  const scorerCount = selected.filter(isScorerLeg).length + (isScorerLeg(leg) ? 1 : 0);
  const firstScorerCount = selected.filter((item) => item.market === "first_goalscorer").length + (leg.market === "first_goalscorer" ? 1 : 0);
  const bttsCount = selected.filter(isBttsYesLeg).length + (isBttsYesLeg(leg) ? 1 : 0);
  const totalGoalsCount = selected.filter(isTotalGoalsLeg).length + (isTotalGoalsLeg(leg) ? 1 : 0);

  if (!shortWindowSafetyCandidateAllowed(leg, policy, legCount)) {
    return false;
  }

  if (hasSelectedLegSignal(selected, leg)) {
    return false;
  }

  if (allowSameFixture && sameMarketInFixture) {
    return false;
  }

  if (allowSameFixture && sameFixtureCount >= maximumSignalsPerFixture(legCount)) {
    return false;
  }

  if (scorerCount > maximumScorerLegs(legCount, appetite)) {
    return false;
  }

  if (firstScorerCount > maximumFirstScorerLegs(legCount, appetite)) {
    return false;
  }

  if (legCount >= 6 && isScorerLeg(leg) && !isLongSlipAnytimeScorerLeg(leg)) {
    return false;
  }

  if (bttsCount > maximumBttsLegs(legCount) + Math.floor(appetite)) {
    return false;
  }

  if (totalGoalsCount > maximumTotalGoalsLegs(legCount) + Math.floor(appetite)) {
    return false;
  }

  return true;
}

function shortWindowStretchPenalty(leg, selected, policy, legCount) {
  const appetite = riskAppetiteFromPolicy(policy);
  const scorerOverflow = Math.max(0, selected.filter(isScorerLeg).length + (isScorerLeg(leg) ? 1 : 0) - maximumScorerLegs(legCount, appetite));
  const firstOverflow = Math.max(0, selected.filter((item) => item.market === "first_goalscorer").length + (leg.market === "first_goalscorer" ? 1 : 0) - maximumFirstScorerLegs(legCount, appetite));
  const sameFixtureOverflow = Math.max(0, selected.filter((item) => fixtureKeyForLeg(item) === fixtureKeyForLeg(leg)).length + 1 - maximumSignalsPerFixture(legCount));

  return scorerOverflow * 28 + firstOverflow * 34 + sameFixtureOverflow * 15;
}

function shortWindowPortfolioFit(leg, selected, policy) {
  const appetite = riskAppetiteFromPolicy(policy);
  const repeatedFixture = selected.some((item) => fixtureKeyForLeg(item) === fixtureKeyForLeg(leg)) ? 1 : 0;
  const sameMarketCount = selected.filter((item) => item.market === leg.market).length;
  const scorerRepeat = isScorerLeg(leg) && selected.some(isScorerLeg) ? 1 : 0;
  const goalsRepeat = isTotalGoalsLeg(leg) && selected.some(isTotalGoalsLeg) ? 1 : 0;
  const correlationPenalty = repeatedFixture * (18 - appetite * 7)
    + Math.max(0, sameMarketCount - 1) * (7 - appetite * 2.5)
    + scorerRepeat * (5 - appetite * 1.5)
    + goalsRepeat * (3.5 - appetite);

  return shortWindowLegScore(leg, policy, selected.length + 1)
    - correlationPenalty;
}

function upgradeShortWindowPayout({ selected, selectedIds, pool, policy, legCount }) {
  const appetite = riskAppetiteFromPolicy(policy);
  const edgeBlend = clamp((appetite - 0.8) / 0.2, 0, 1);

  if (edgeBlend <= 0 || selected.length < Math.min(5, legCount)) {
    return;
  }

  const maxCandidateOdds = shortWindowMaxLegOdds(legCount, appetite) * (legCount >= 6 ? 1.16 + edgeBlend * 0.14 : 1.45 + edgeBlend * 0.22);
  const attempts = legCount >= 8 ? 2 : 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let bestSwap = null;

    for (const candidate of pool) {
      if (selectedIds.has(candidate.id)) {
        continue;
      }

      if (!shortWindowSafetyCandidateAllowed(candidate, policy, legCount)) {
        continue;
      }

      const candidateOdds = Number(candidate.decimalOdds || 1);

      if (candidateOdds <= 1 || candidateOdds > maxCandidateOdds) {
        continue;
      }

      for (let index = 0; index < selected.length; index += 1) {
        const outgoing = selected[index];
        const outgoingOdds = Number(outgoing.decimalOdds || 1);
        const sameFixtureSwap = fixtureKeyForLeg(candidate) === fixtureKeyForLeg(outgoing);

        if (legCount >= 6 && !sameFixtureSwap) {
          continue;
        }

        const withoutOutgoing = selected.filter((_leg, selectedIndex) => selectedIndex !== index);

        if (!shortWindowCandidateAllowed(candidate, withoutOutgoing, policy, legCount, { allowSameFixture: true })) {
          continue;
        }

        if (candidateOdds < outgoingOdds * (1.08 + (1 - edgeBlend) * 0.08)) {
          continue;
        }

        const candidateScore = shortWindowLegScore(candidate, policy, legCount);
        const outgoingScore = shortWindowLegScore(outgoing, policy, legCount);
        const toleratedScoreDrop = sameFixtureSwap ? 12 + edgeBlend * 18 : 5 + edgeBlend * 9;

        if (!sameFixtureSwap && candidateScore < outgoingScore - toleratedScoreDrop) {
          continue;
        }

        const replacement = selected.map((leg, selectedIndex) => selectedIndex === index ? candidate : leg);
        const correlation = portfolioCorrelationProfile(replacement, { legCount, appetite });
        const fit = (candidateOdds / outgoingOdds - 1) * 100
          + (candidateScore - outgoingScore)
          - correlation.penalty * 0.55;

        if (!bestSwap || fit > bestSwap.fit) {
          bestSwap = { candidate, outgoing, index, fit };
        }
      }
    }

    if (!bestSwap) {
      break;
    }

    selected[bestSwap.index] = bestSwap.candidate;
    selectedIds.delete(bestSwap.outgoing.id);
    selectedIds.add(bestSwap.candidate.id);
  }
}

function shortWindowLegScore(leg, policy, legCount) {
  const appetite = riskAppetiteFromPolicy(policy);
  const probability = likelyWinProbability(leg, { legCount });
  const confidence = Number(leg.confidence || 0);
  const edge = Number(leg.edge || 0);
  const independentEdge = Number(leg.independentEdge ?? edge);
  const odds = Number(leg.decimalOdds || 1);
  const signalScore = clamp(Number(leg.components?.nonMarketSignalCount || 0) / 4, 0, 1);
  const intelligence = Number(leg.components?.intelligenceConfidence || 0.45);
  const targetOdds = shortWindowTargetLegOdds(legCount, appetite);
  const oddsFit = clamp(1 - Math.abs(Math.log(Math.max(1.01, odds) / targetOdds)) / 1.1, 0, 1);
  const edgeBlend = clamp((appetite - 0.8) / 0.2, 0, 1);
  const riskTagLift = ["calculated_risk", "longshot_value", "contrarian_value"].includes(leg.riskTag) ? appetite * 5 + edgeBlend * 4 : 0;
  const survivalPressure = survivalPressureForLegCount(legCount);
  const maxSurvivalOdds = shortWindowMaxLegOdds(legCount, appetite);
  const cappedPriceLift = clamp(Math.log(Math.max(1.01, Math.min(odds, maxSurvivalOdds * 1.4))), 0, 2.2);
  const boldSweetSpotLift = edgeBlend * clamp(odds - targetOdds, 0, maxSurvivalOdds * 0.75) * (legCount >= 6 ? 3.2 : 2.1);
  const longPricePenalty = Math.max(0, odds - maxSurvivalOdds)
    * (legCount >= 8 ? 9 : legCount >= 6 ? 6.8 : legCount >= 4 ? 4.2 : 1.8)
    * (1 - appetite * 0.28 - edgeBlend * 0.24);
  const priceWeight = (4 + appetite * 22) * (1 - survivalPressure * 0.72)
    + edgeBlend * (legCount >= 6 ? 13 : legCount >= 4 ? 8 : 4);

  return probability * (78 - appetite * 30)
    + confidence * (18 - appetite * 2)
    + intelligence * 7
    + signalScore * 5
    + clamp(edge, -0.03, 0.24) * (22 + appetite * 44 + edgeBlend * 20)
    + clamp(independentEdge, -0.04, 0.26) * (28 + appetite * 54 + edgeBlend * 24)
    + oddsFit * (12 + appetite * 6)
    + cappedPriceLift * priceWeight
    + boldSweetSpotLift
    + riskTagLift
    - longPricePenalty
    - riskPortfolioLegPenalty(leg, legCount, appetite) * 55;
}

function shortWindowTargetLegOdds(legCount, appetite) {
  if (legCount >= 8) {
    return 1.35 + appetite * 0.62;
  }

  if (legCount >= 6) {
    return 1.42 + appetite * 0.82;
  }

  if (legCount >= 4) {
    return 1.55 + appetite * 1.15;
  }

  if (legCount >= 3) {
    return 1.7 + appetite * 1.65;
  }

  return 1.8 + appetite * 2.2;
}

function scoreCombo(legs, type, policy, options = {}) {
  const hardBlocks = [];
  const riskProfile = policy.riskProfile || {};
  const appetite = riskAppetiteFromPolicy(policy);
  const fixtureIds = new Set(legs.map(fixtureKeyForLeg));
  const {
    allowSameFixture = false,
    relaxPreferredOdds = false,
    relaxAbsoluteOdds = false,
    relaxTrixieRiskLeg = false,
    relaxFavouriteOnly = false,
    shortWindowFallback = false
  } = options;
  const uncappedCombinedDecimalOdds = product(legs.map((leg) => leg.decimalOdds));
  const fallbackOddsCap = shortWindowFallback
    ? shortWindowFallbackCombinedOddsCap(legs.length, appetite, fixtureIds.size)
    : Infinity;
  const combinedDecimalOdds = Math.min(uncappedCombinedDecimalOdds, fallbackOddsCap);
  const oddsCapped = uncappedCombinedDecimalOdds > combinedDecimalOdds + 0.005;
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
  const scorerLegCount = legs.filter(isScorerLeg).length;
  const firstScorerLegCount = legs.filter((leg) => leg.market === "first_goalscorer").length;
  const reusedSignalCount = legs.filter((leg) => leg.reusedSignal).length;
  const fragileLegCount = legs.filter((leg) => riskPortfolioLegPenalty(leg, legs.length, appetite) >= 0.025).length;
  const preferred = preferredOddsRange(type, legs.length, policy);
  const correlation = portfolioCorrelationProfile(legs, { legCount: legs.length, appetite });

  if (!allowSameFixture && fixtureIds.size !== legs.length) {
    hardBlocks.push("same_fixture_correlation");
  }

  if (!relaxPreferredOdds && (combinedDecimalOdds < preferred.min || combinedDecimalOdds > preferred.max)) {
    hardBlocks.push("combined_odds_outside_policy_range");
  }

  if (!relaxAbsoluteOdds && combinedDecimalOdds > Number(riskProfile.maxCombinedOdds || 50)) {
    hardBlocks.push("combined_odds_above_absolute_cap");
  }

  if (!relaxTrixieRiskLeg && type === "trixie" && riskLegs.length < Number(riskProfile.minRiskLegsForTrixie ?? 0)) {
    hardBlocks.push("trixie_missing_calculated_risk_leg");
  }

  if (!relaxFavouriteOnly && (type === "trixie" || type === "accumulator") && favouriteLegs.length === legs.length) {
    hardBlocks.push("all_legs_are_high_implied_probability_favourites");
  }

  if (!shortWindowFallback && type === "accumulator" && legs.length >= 4 && scorerLegCount > maximumScorerLegs(legs.length, appetite)) {
    hardBlocks.push("too_many_scorer_legs_for_survival_slip");
  }

  if (!shortWindowFallback && type === "accumulator" && firstScorerLegCount > maximumFirstScorerLegs(legs.length, appetite)) {
    hardBlocks.push("too_many_first_goalscorer_legs_for_survival_slip");
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
    uncappedCombinedDecimalOdds: oddsCapped ? round(uncappedCombinedDecimalOdds, 2) : undefined,
    fallbackCombinedOddsCap: oddsCapped ? round(fallbackOddsCap, 2) : undefined,
    combinedProbability: round(combinedProbability, 4),
    expectedValue: round(expectedValue, 4),
    averageEdge: round(averageEdge, 4),
    averageIndependentEdge: round(averageIndependentEdge, 4),
    averageConfidence: round(averageConfidence, 4),
    survivalCombinedProbability: round(survivalCombinedProbability, 4),
    averageSurvivalProbability: round(averageSurvivalProbability, 4),
    displayRating: round(clamp(
      displayConfidenceRating(legs)
        - (shortWindowFallback ? fallbackDisplayPenalty({ legs, legCount: legs.length, correlation, shortWindowFallback, reusedSignalCount, fragileLegCount }) : 0)
        - Math.max(0, scorerLegCount - maximumScorerLegs(legs.length, appetite)) * 0.025
        - Math.max(0, firstScorerLegCount - maximumFirstScorerLegs(legs.length, appetite)) * 0.03,
      0.28,
      0.95
    ), 4),
    riskLegCount: riskLegs.length,
    bttsLegCount,
    scorerLegCount,
    firstScorerLegCount,
    fragileLegCount,
    reusedSignalCount,
    averageNonMarketSignalCount: round(averageNonMarketSignalCount, 2),
    correlationPenalty: round(correlation.penalty, 2),
    correlationReasons: correlation.reasons,
    marketFamilyMix: correlation.familyCounts,
    repeatedTeamCount: correlation.repeatedTeamCount,
    sameDateCluster: correlation.sameDateCluster,
    shortWindowFallback,
    score: round(score, 2),
    hardBlocks,
    thesis: buildComboThesis({ type, legs, combinedDecimalOdds, uncappedCombinedDecimalOdds, oddsCapped, expectedValue, averageIndependentEdge, averageNonMarketSignalCount, riskLegs, favouriteLegs, survivalCombinedProbability, averageSurvivalProbability, bttsLegCount, fragileLegCount, correlation, shortWindowFallback })
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
    return bestCombo(recommendations.doubles || [], risk);
  }

  if (key === "trixie") {
    return bestCombo(recommendations.trixies || [], risk);
  }

  const legCount = Number(key.replace("accumulator_", ""));
  return bestCombo(recommendations.accumulatorsByLegCount?.[legCount] || [], risk);
}

function bestSingleForRisk(combos, risk) {
  const appetite = clamp(Number(risk || 0), 0, 100) / 100;

  if (appetite <= 0) {
    return bestCombo(combos, 0);
  }

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
  const edgeBlend = clamp((appetite - 0.8) / 0.2, 0, 1);
  const highRiskPrice = edgeBlend > 0 && ["calculated_risk", "longshot_value", "contrarian_value"].includes(leg.riskTag) ? 4 * edgeBlend : 0;

  return (Number(combo.score || 0) * 0.1)
    + oddsFit * (34 - edgeBlend * 10)
    + tagFit * 14
    + comboSurvivalFit(combo, appetite) * 0.62
    + confidence * (28 - appetite * 4)
    + edge * (14 + edgeBlend * 24)
    + clamp(expectedValue * 6, -4, 8) * edgeBlend
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

function bestCombo(combos, risk = 50) {
  const appetite = clamp(Number(risk || 0), 0, 100) / 100;

  return [...combos].sort((left, right) => {
    return comboFit(right, appetite) - comboFit(left, appetite);
  })[0] || null;
}

function comboFit(combo, appetite) {
  const edgeBlend = clamp((appetite - 0.8) / 0.2, 0, 1);
  const survivalFit = comboSurvivalFit(combo, appetite);
  const expectedValue = Number(combo.expectedValue || 0);
  const independentEdge = Number(combo.averageIndependentEdge ?? combo.averageEdge ?? combo.legs?.[0]?.independentEdge ?? combo.legs?.[0]?.edge ?? 0);
  const odds = Number(combo.combinedDecimalOdds || 1);
  const legCount = Number(combo.legCount || combo.legs?.length || 1);
  const longOddsPenalty = legCount === 1
    ? Math.max(0, odds - (2.15 + appetite * 0.75 + edgeBlend * 0.45)) * (7 - edgeBlend * 2)
    : Math.max(0, Math.log(Math.max(1, odds)) - (1.2 + legCount * 0.38 + appetite * 0.35)) * (5 - edgeBlend * 1.5);

  return survivalFit
    + Number(combo.score || 0) * (0.18 - edgeBlend * 0.06)
    + independentEdge * (18 + edgeBlend * 28)
    + clamp(expectedValue * 5, -4, 8) * edgeBlend
    - longOddsPenalty;
}

function comboSurvivalFit(combo, appetite) {
  const survival = Number(combo.survivalCombinedProbability || combo.combinedProbability || 0);
  const averageSurvival = Number(combo.averageSurvivalProbability || combo.combinedProbability || 0);
  const confidence = Number(combo.averageConfidence || combo.legs?.[0]?.confidence || 0);
  const displayRating = Number(combo.displayRating || 0);
  const probability = Number(combo.combinedProbability || 0);
  const edgeBlend = clamp((appetite - 0.8) / 0.2, 0, 1);

  return survival * (110 - edgeBlend * 22)
    + averageSurvival * (34 - edgeBlend * 7)
    + probability * (24 - edgeBlend * 6)
    + confidence * 22
    + displayRating * 18;
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

      if (!availableFixtureCount || eligibleLegs.length < Math.min(legCount, availableFixtureCount)) {
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
  addSameFixtureFallbackLegs({ selected, selectedIds, pool: eligibleLegs, legCount });

  return selected.length === legCount ? selected : [];
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

function addSameFixtureFallbackLegs({ selected, selectedIds, pool, legCount }) {
  while (selected.length < legCount) {
    const candidates = pool
      .filter((leg) => !selectedIds.has(leg.id))
      .filter((leg) => likelyWinProbability(leg, { legCount }) >= minimumSurvivalProbability(legCount) - 0.085)
      .filter((leg) => sameFixtureFallbackCanAdd(leg, selected, legCount))
      .map((leg) => {
        const correlation = portfolioCorrelationProfile([...selected, leg], { legCount, appetite: 0 });
        return {
          leg,
          fit: likelyLegScore(leg, legCount) - correlation.penalty * 5.2 - sameFixtureFallbackStretchPenalty(leg, selected, legCount)
        };
      })
      .sort((left, right) => right.fit - left.fit);

    if (!candidates.length) {
      break;
    }

    const leg = {
      ...candidates[0].leg,
      shortWindowFallback: true
    };
    selected.push(leg);
    selectedIds.add(candidates[0].leg.id);
  }
}

function sameFixtureFallbackCanAdd(leg, selected, legCount) {
  const selectedFixtureCount = selected.filter((item) => fixtureKeyForLeg(item) === fixtureKeyForLeg(leg)).length;
  const sameMarketInFixture = selected.some((item) => fixtureKeyForLeg(item) === fixtureKeyForLeg(leg) && item.market === leg.market);
  const scorerCount = selected.filter(isScorerLeg).length + (isScorerLeg(leg) ? 1 : 0);
  const firstScorerCount = selected.filter((item) => item.market === "first_goalscorer").length + (leg.market === "first_goalscorer" ? 1 : 0);
  const bttsCount = selected.filter(isBttsYesLeg).length + (isBttsYesLeg(leg) ? 1 : 0);
  const totalGoalsCount = selected.filter(isTotalGoalsLeg).length + (isTotalGoalsLeg(leg) ? 1 : 0);
  const correlation = portfolioCorrelationProfile([...selected, leg], { legCount, appetite: 0 });

  if (hasSelectedLegSignal(selected, leg)) {
    return false;
  }

  if (selectedFixtureCount >= maximumSignalsPerFixture(legCount)) {
    return false;
  }

  if (sameMarketInFixture) {
    return false;
  }

  if (scorerCount > maximumScorerLegs(legCount, 0)) {
    return false;
  }

  if (firstScorerCount > maximumFirstScorerLegs(legCount, 0)) {
    return false;
  }

  if (bttsCount > maximumBttsLegs(legCount) + 1) {
    return false;
  }

  if (totalGoalsCount > maximumTotalGoalsLegs(legCount) + 1) {
    return false;
  }

  if (legCount >= 6 && isScorerLeg(leg) && !isLongSlipAnytimeScorerLeg(leg)) {
    return false;
  }

  return correlation.penalty <= maximumPortfolioCorrelationPenalty(legCount, "balanced") + 1.4;
}

function sameFixtureFallbackStretchPenalty(leg, selected, legCount) {
  const selectedFixtureCount = selected.filter((item) => fixtureKeyForLeg(item) === fixtureKeyForLeg(leg)).length;
  const scorerStretch = isScorerLeg(leg) ? 7 : 0;
  const oddsStretch = Math.max(0, Number(leg.decimalOdds || 1) - maximumSurvivalOdds(legCount)) * 4.8;
  return selectedFixtureCount * 7.5 + scorerStretch + oddsStretch;
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
  const uncappedCombinedDecimalOdds = product(legs.map((leg) => leg.decimalOdds));
  const uniqueFixtureCount = new Set(legs.map(fixtureKeyForLeg)).size;
  const reusedSignalCount = legs.filter((leg) => leg.reusedSignal).length;
  const shortWindowFallback = uniqueFixtureCount < legs.length || reusedSignalCount > 0;
  const fallbackOddsCap = shortWindowFallback ? shortWindowFallbackCombinedOddsCap(target.legCount, 0, uniqueFixtureCount) : Infinity;
  const combinedDecimalOdds = Math.min(uncappedCombinedDecimalOdds, fallbackOddsCap);
  const oddsCapped = uncappedCombinedDecimalOdds > combinedDecimalOdds + 0.005;
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
  const survivalPressure = survivalPressureForLegCount(target.legCount);
  const correlation = portfolioCorrelationProfile(legs, { legCount: target.legCount, appetite: 0 });
  const fallbackRatingPenalty = fallbackDisplayPenalty({ legs, legCount: target.legCount, correlation, shortWindowFallback, reusedSignalCount, fragileLegCount });
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
        survivalPenalty: round(mostLikelyPortfolioPenalty(leg, target.legCount), 4),
        lateKickoffGuard: lateKickoffGuard(leg, target.legCount)
      }
    })),
    combinedDecimalOdds: round(combinedDecimalOdds, 2),
    uncappedCombinedDecimalOdds: oddsCapped ? round(uncappedCombinedDecimalOdds, 2) : undefined,
    fallbackCombinedOddsCap: oddsCapped ? round(fallbackOddsCap, 2) : undefined,
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
    displayRating: round(clamp(displayConfidenceRating(legs, { likely: true }) - fallbackRatingPenalty, 0.28, 0.97), 4),
    shortWindowFallback,
    uniqueFixtureCount,
    reusedSignalCount,
    correlationPenalty: round(correlation.penalty, 2),
    correlationReasons: correlation.reasons,
    marketFamilyMix: correlation.familyCounts,
    repeatedTeamCount: correlation.repeatedTeamCount,
    sameDateCluster: correlation.sameDateCluster,
    thesis: buildMostLikelyThesis({ target, legs, combinedDecimalOdds, uncappedCombinedDecimalOdds, oddsCapped, combinedProbability, averageSurvivalProbability, averageConfidence, averageIndependentEdge, averageNonMarketSignalCount, bttsLegCount, fragileLegCount, marketClusterScore: marketClusterPenalty(legs, target.legCount), correlation, shortWindowFallback, uniqueFixtureCount, reusedSignalCount })
  };
}

function buildMostLikelyThesis({ target, legs, combinedDecimalOdds, uncappedCombinedDecimalOdds, oddsCapped = false, combinedProbability, averageSurvivalProbability, averageConfidence, averageIndependentEdge, averageNonMarketSignalCount, bttsLegCount, fragileLegCount, marketClusterScore, correlation, shortWindowFallback, uniqueFixtureCount, reusedSignalCount }) {
  const selections = legs.map((leg) => leg.selectionLabel).join(" | ");
  const oddsCapText = oddsCapped
    ? ` Displayed fallback odds are capped from raw ${round(uncappedCombinedDecimalOdds, 2)} to ${round(combinedDecimalOdds, 2)} so same-day signals cannot overstate the take-home.`
    : "";
  const fallbackText = shortWindowFallback
    ? ` Short-window fallback used ${uniqueFixtureCount} fixture(s) and ${legs.length} unique signal(s) so Picks of the Day stay populated without repeating exact legs. Some same-game markets were included.${oddsCapText}`
    : "";
  const heatLegs = legs.filter((leg) => Number(leg.components?.heatConfidence || 0) > 0.18 && Number(leg.components?.heatStress || 0) > 0.2);
  const heatText = heatLegs.length ? ` Heat layer active on ${heatLegs.length} leg(s) as a capped weather, climate-history, and squad-depth nudge.` : "";
  const lateGuardedLegs = legs.filter((leg) => lateKickoffGuard(leg, target.legCount).penalty > 0.004);
  const lateText = lateGuardedLegs.length ? ` Late-kickoff guard active on ${lateGuardedLegs.length} leg(s), trimming stale/drifting prices and fragile pre-match angles.` : "";
  const portfolioText = target.legCount >= 4
    ? ` Long-slip survival controls active: average leg survival ${round(averageSurvivalProbability * 100, 1)}%, estimated slip chance ${round(combinedProbability * 100, 2)}%, ${bttsLegCount} BTTS leg(s), ${fragileLegCount} fragile-value leg(s), market-mix pressure ${round(marketClusterScore, 1)}, correlation pressure ${round(correlation?.penalty || 0, 1)}.`
    : ` Estimated win chance ${round(combinedProbability * 100, 1)}%.`;
  const correlationText = correlation?.reasons?.length ? ` Correlation layer trimmed: ${correlation.reasons.join("; ")}.` : "";

  return `${target.label} chosen by the Pick of the Day engine, ignoring the risk slider and prioritising estimated win chance, data confidence, fixture separation, and only then price edge. Combined odds ${round(combinedDecimalOdds, 2)}, average data confidence ${round(averageConfidence * 100, 1)}%, independent edge ${round(averageIndependentEdge * 100, 2)}%, non-market signals ${round(averageNonMarketSignalCount, 1)} per leg.${portfolioText}${correlationText}${heatText}${lateText}${fallbackText} Legs: ${selections}.`;
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
  const scorerCount = selected.filter(isScorerLeg).length + (isScorerLeg(leg) ? 1 : 0);
  const firstScorerCount = selected.filter((item) => item.market === "first_goalscorer").length + (leg.market === "first_goalscorer" ? 1 : 0);
  const correlation = portfolioCorrelationProfile([...selected, leg], { legCount, appetite: 0 });

  if (decimalOdds > shortWindowFallbackMaxLegOdds(legCount, 0)) {
    return false;
  }

  if (mode === "fallback") {
    return probability >= minimumSurvivalProbability(legCount) - 0.04
      && !(legCount >= 6 && fragileBttsHistory(leg))
      && scorerCount <= maximumScorerLegs(legCount, 0)
      && firstScorerCount <= maximumFirstScorerLegs(legCount, 0)
      && !(legCount >= 6 && isScorerLeg(leg) && !isLongSlipAnytimeScorerLeg(leg))
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
    if (scorerCount > maximumScorerLegs(legCount, 0)) {
      return false;
    }
    if (firstScorerCount > maximumFirstScorerLegs(legCount, 0)) {
      return false;
    }
    if (legCount >= 6 && isScorerLeg(leg) && !isLongSlipAnytimeScorerLeg(leg)) {
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
    if (scorerCount > maximumScorerLegs(legCount, 0)) {
      return false;
    }
    if (firstScorerCount > maximumFirstScorerLegs(legCount, 0)) {
      return false;
    }
    if (legCount >= 6 && isScorerLeg(leg) && !isLongSlipAnytimeScorerLeg(leg)) {
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
  const latePenalty = lateKickoffGuard(leg, legCount).penalty;

  if (!pressure) {
    return latePenalty;
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

  const marketOnlyPenalty = marketOnlySurvivalPenalty(leg, legCount);
  if (marketOnlyPenalty) {
    penalty += marketOnlyPenalty;
  }

  if (isScorerLeg(leg)) {
    const starterLikelihood = Number(leg.components?.starterLikelihood || 0);
    const scorerGoals = Number(leg.components?.scorerGoalsPerTwentyTeamMatches || 0);
    const scorerConfidence = Number(leg.components?.scorerConfidence || 0);
    penalty += 0.035;
    if (starterLikelihood < 0.64) {
      penalty += (0.64 - starterLikelihood) * 0.11;
    }
    if (decimalOdds >= 4 && scorerGoals < 3.5) {
      penalty += (3.5 - scorerGoals) * 0.012;
    }
    if (decimalOdds >= 4 && scorerConfidence < 0.62) {
      penalty += (0.62 - scorerConfidence) * 0.06;
    }
    if (leg.market === "first_goalscorer") {
      penalty += 0.03;
    }
  }

  if (isOpeningGroupGoalLeg(leg) && legCount >= 4) {
    penalty += 0.018 + pressure * 0.026;
  }

  return clamp((penalty * pressure) + latePenalty, 0, 0.14);
}

function marketOnlySurvivalPenalty(leg, legCount) {
  const market = Number(leg.marketImpliedProbability || leg.impliedProbability || 0);
  const rawModel = Number(leg.rawModelProbability || leg.modelProbability || 0);
  const independentEdge = Number(leg.independentEdge ?? (rawModel - market));
  const gap = market - rawModel;

  if (gap <= 0.18 || independentEdge >= -0.04) {
    return 0;
  }

  const pressure = survivalPressureForLegCount(legCount);
  const favouritePressure = leg.market === "match_winner" && Number(leg.decimalOdds || 99) <= 1.45 ? 1.2 : 1;
  return clamp((gap - 0.18) * (0.32 + pressure * 0.28) * favouritePressure, 0, 0.11);
}

function fallbackDisplayPenalty({ legs, legCount, correlation, shortWindowFallback, reusedSignalCount, fragileLegCount }) {
  const fallbackPenalty = shortWindowFallback ? 0.045 + Math.max(0, legCount - new Set(legs.map(fixtureKeyForLeg)).size) * 0.012 : 0;
  const repeatPenalty = Number(reusedSignalCount || 0) * 0.018;
  const fragilePenalty = Number(fragileLegCount || 0) * 0.009;
  const scorerPenalty = Math.max(0, legs.filter(isScorerLeg).length - maximumScorerLegs(legCount, 0)) * 0.025;
  const correlationPenalty = Number(correlation?.penalty || 0) / 115;

  return clamp(fallbackPenalty + repeatPenalty + fragilePenalty + scorerPenalty + correlationPenalty, 0, 0.24);
}

function lateKickoffGuard(leg, legCount = 1) {
  const hoursUntilKickoff = hoursUntilFixture(leg);

  if (!Number.isFinite(hoursUntilKickoff) || hoursUntilKickoff < -0.5 || hoursUntilKickoff > 6) {
    return {
      active: false,
      hoursUntilKickoff: null,
      penalty: 0,
      reasons: []
    };
  }

  const pressure = clamp((6 - Math.max(0, hoursUntilKickoff)) / 6, 0, 1);
  const survivalPressure = survivalPressureForLegCount(legCount);
  const reasons = [];
  let penalty = 0;
  const oddsAgeHours = Number(leg.components?.oddsAgeHours || 0);
  const freshness = Number(leg.components?.oddsFreshness ?? 0.75);
  const confidence = Number(leg.confidence || 0);
  const independentEdge = Number(leg.independentEdge ?? leg.edge ?? 0);
  const expectedGoals = Number(leg.components?.expectedGoals || 0);

  if (oddsAgeHours > 2) {
    penalty += clamp((oddsAgeHours - 2) / 8, 0, 1) * 0.045;
    reasons.push("odds snapshot is ageing close to kick-off");
  }

  if (freshness < 0.78) {
    penalty += clamp((0.78 - freshness) / 0.5, 0, 1) * 0.035;
    reasons.push("freshness below late-match comfort level");
  }

  if (leg.components?.oddsDrifting) {
    penalty += 0.024;
    reasons.push("selection is drifting in the market");
  }

  if (confidence < 0.68 && legCount >= 3) {
    penalty += (0.68 - confidence) * 0.065;
    reasons.push("confidence is thin for a near-kick-off slip");
  }

  if (isOpeningGroupGoalLeg(leg) && (expectedGoals < 3.05 || independentEdge < 0.075)) {
    penalty += 0.028;
    reasons.push("opening-game goal angle needs extra proof");
  }

  if (isScorerLeg(leg)) {
    const starterLikelihood = Number(leg.components?.starterLikelihood || 0);

    if (starterLikelihood < 0.64) {
      penalty += 0.03;
      reasons.push("scorer leg lacks strong starter/minutes confidence");
    }

    if (leg.market === "first_goalscorer") {
      penalty += 0.014;
      reasons.push("first goalscorer remains fragile before confirmed lineups");
    }
  }

  const scaledPenalty = clamp(penalty * pressure * (0.55 + survivalPressure * 0.55), 0, 0.09);

  return {
    active: scaledPenalty > 0,
    hoursUntilKickoff: round(hoursUntilKickoff, 2),
    pressure: round(pressure, 3),
    penalty: round(scaledPenalty, 4),
    reasons: reasons.slice(0, 4)
  };
}

function hoursUntilFixture(leg) {
  const fixtureDate = new Date(leg.fixtureDate || leg.date || "");
  const referenceDate = new Date(leg.createdAt || leg.components?.createdAt || state.data?.generatedAt || "");

  if (!Number.isFinite(fixtureDate.getTime()) || !Number.isFinite(referenceDate.getTime())) {
    return null;
  }

  return (fixtureDate - referenceDate) / 36e5;
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
  const scorerCount = legs.filter(isScorerLeg).length;
  const openingGoalCount = legs.filter(isOpeningGroupGoalLeg).length;
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

  const scorerAllowance = maximumScorerLegs(legCount, appetite);
  const scorerExcess = Math.max(0, scorerCount - scorerAllowance);

  if (scorerExcess) {
    penalty += scorerExcess * 4.2;
    reasons.push(`${scorerCount} scorer legs`);
  }

  const openingGoalAllowance = legCount >= 8 ? 2 + Math.floor(appetite * 1.5) : legCount >= 6 ? 2 : legCount >= 4 ? 1 : legCount;
  const openingGoalExcess = Math.max(0, openingGoalCount - openingGoalAllowance);

  if (openingGoalExcess) {
    penalty += openingGoalExcess * (legCount >= 8 ? 3.6 : 3.1);
    reasons.push(`${openingGoalCount} opening-game goal legs`);
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
    scorerCount,
    openingGoalCount
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
    scorerCount: 0,
    openingGoalCount: 0
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
    return maximumScorerLegs(legCount, appetite);
  }

  if (legCount >= 8) {
    return 5 + relief;
  }
  if (legCount >= 6) {
    return 4 + relief;
  }
  return 3;
}

function maximumScorerLegs(legCount, appetite = 0) {
  if (legCount >= 8) {
    return clamp(appetite, 0, 1) >= 0.8 ? 2 : 1;
  }

  if (legCount >= 6) {
    return clamp(appetite, 0, 1) >= 0.82 ? 2 : 1;
  }

  if (legCount >= 4) {
    return 1;
  }

  return legCount;
}

function maximumFirstScorerLegs(legCount, appetite = 0) {
  if (legCount >= 4) {
    return clamp(appetite, 0, 1) >= 0.95 ? 1 : 0;
  }

  return clamp(appetite, 0, 1) >= 0.82 ? 1 : 0;
}

function maximumSignalsPerFixture(legCount) {
  if (legCount >= 8) {
    return 3;
  }

  if (legCount >= 5) {
    return 2;
  }

  return 1;
}

function marketFamilyForLeg(leg) {
  if (isTotalGoalsLeg(leg) || leg.market === "both_teams_to_score") {
    return "goals";
  }

  if (isScorerLeg(leg)) {
    return "scorer";
  }

  if (leg.market === "match_winner" || leg.market === "draw_no_bet" || leg.market === "double_chance") {
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
  return ["over_1_5_goals", "over_2_5_goals", "under_2_5_goals", "under_3_5_goals", "under_4_5_goals"].includes(leg.market);
}

function isScorerLeg(leg) {
  return leg.market === "anytime_scorer" || leg.market === "first_goalscorer";
}

function isLongSlipAnytimeScorerLeg(leg) {
  if (leg.market !== "anytime_scorer") {
    return false;
  }

  return Number(leg.decimalOdds || 99) <= 6.2
    && Number(leg.modelProbability || 0) >= 0.22
    && Number(leg.rawModelProbability || leg.modelProbability || 0) >= 0.2
    && Number(leg.confidence || 0) >= 0.66
    && Number(leg.components?.starterLikelihood || 0) >= 0.66
    && Number(leg.components?.projectedMinutes || 0) >= 65
    && Number(leg.components?.scorerGoalsPerTwentyTeamMatches || 0) >= 3.5
    && Number(leg.components?.scorerConfidence || 0) >= 0.6;
}

function isOpeningGroupGoalLeg(leg) {
  return Boolean(leg.components?.bothOpeningGroupGame)
    && (leg.market === "over_2_5_goals" || isBttsYesLeg(leg));
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
  return ["over_1_5_goals", "over_2_5_goals", "under_2_5_goals", "under_3_5_goals", "under_4_5_goals"].includes(market);
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
  const sliderRisk = Number(riskProfile.sliderRisk);

  if (Number.isFinite(sliderRisk)) {
    return clamp(sliderRisk / 100, 0, 1);
  }

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

  if (isScorerLeg(leg) && legCount >= 3) {
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
  const scorerCount = legs.filter(isScorerLeg).length;
  const firstScorerCount = legs.filter((leg) => leg.market === "first_goalscorer").length;
  const scorerPenalty = legCount >= 4
    ? Math.max(0, scorerCount - maximumScorerLegs(legCount, appetite)) * 5 * (1 - appetite * 0.2)
    : 0;
  const firstScorerPenalty = legCount >= 3
    ? Math.max(0, firstScorerCount - maximumFirstScorerLegs(legCount, appetite)) * 6 * (1 - appetite * 0.15)
    : 0;
  const legPenalty = legs.reduce((total, leg) => total + riskPortfolioLegPenalty(leg, legCount, appetite), 0) * 38;
  const marketPenalty = riskMarketClusterPenalty(legs, appetite);

  return bttsPenalty + fragilePenalty + scorerPenalty + firstScorerPenalty + legPenalty + marketPenalty;
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

function buildComboThesis({ type, legs, combinedDecimalOdds, uncappedCombinedDecimalOdds, oddsCapped = false, expectedValue, averageIndependentEdge, averageNonMarketSignalCount, riskLegs, favouriteLegs, survivalCombinedProbability, averageSurvivalProbability, bttsLegCount, fragileLegCount, correlation, shortWindowFallback = false }) {
  const selections = legs.map((leg) => leg.selectionLabel).join(" | ");
  const riskText = riskLegs.length
    ? `${riskLegs.length} calculated-risk/value leg(s) stop this from being a favourite-only ${type}.`
    : "No calculated-risk leg; this should only survive if the edge is exceptional.";
  const favouriteText = favouriteLegs.length ? `${favouriteLegs.length} high-implied-probability favourite leg(s).` : "No high-implied-probability favourite crowding.";
  const survivalText = `${type} at combined odds ${round(combinedDecimalOdds, 2)} with estimated slip chance ${round(survivalCombinedProbability * 100, 2)}% and average leg survival ${round(averageSurvivalProbability * 100, 1)}%.`;
  const uniqueFixtureCount = new Set(legs.map(fixtureKeyForLeg)).size;
  const oddsCapText = oddsCapped
    ? ` Displayed fallback odds are capped from raw ${round(uncappedCombinedDecimalOdds, 2)} to ${round(combinedDecimalOdds, 2)} so same-day signals cannot overstate the take-home.`
    : "";
  const fallbackText = shortWindowFallback
    ? `Short-window fallback active: the selected date range only offers ${uniqueFixtureCount} distinct fixture(s) for ${legs.length} leg(s), so the engine keeps the card populated with the best available real legs and only repeats a fixture when unavoidable.${oddsCapText}`
    : "";
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

  return `${survivalText} Expected value is ${round(expectedValue * 100, 2)}%, independent edge averages ${round(averageIndependentEdge * 100, 2)}%, and the model has ${round(averageNonMarketSignalCount, 1)} non-market signals per leg. ${fallbackText} ${clusterText} ${correlationText} ${riskText} ${favouriteText} ${heatText} Legs: ${selections}.`;
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

  return round(clamp(rating, 0.34, likely ? 0.97 : 0.95), 4);
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

  return clamp(rating, 0.32, likely ? 0.97 : 0.95);
}

function marketLine(data) {
  const labels = {
    match_winner: "Match winner",
    draw_no_bet: "Draw no bet",
    anytime_scorer: "Anytime scorer",
    first_goalscorer: "First goalscorer",
    both_teams_to_score: "Both teams to score",
    double_chance: "Double chance",
    over_1_5_goals: "Over 1.5 goals",
    over_2_5_goals: "Over 2.5 goals",
    under_2_5_goals: "Under 2.5 goals",
    under_3_5_goals: "Under 3.5 goals",
    under_4_5_goals: "Under 4.5 goals",
    asian_handicap: "Asian handicap",
    asian_total_goals: "Asian totals",
    three_way_handicap: "3-way handicap",
    team_total_goals: "Team totals",
    team_to_score: "Team to score",
    to_qualify: "To qualify"
  };
  const configured = data?.markets?.configured || [];
  const collectOnly = data?.markets?.collectOnly || [];
  const observed = data?.markets?.observed || {};
  const active = configured.map((market) => labels[market] || market).join(", ");
  const survivabilityRecords = Number(data?.markets?.survivabilityCoverage?.summary?.freshRecordCount || 0);
  const anytimeCount = Number(observed.anytime_scorer || 0);
  const firstCount = Number(observed.first_goalscorer || 0);
  const scorerCount = anytimeCount + firstCount;
  const scorerText = scorerCount
    ? ` Scorer prices found: ${scorerCount} (${anytimeCount} anytime, ${firstCount} first).`
    : " Scorer markets are switched on, but current public sources have not exposed scorer prices yet.";
  const collectOnlyText = collectOnly.length
    ? ` Collect-only survival markets: ${collectOnly.map((market) => labels[market] || market).join(", ")}${survivabilityRecords ? ` (${survivabilityRecords} fresh records).` : "."}`
    : "";

  return `Markets: ${active}.${scorerText}${collectOnlyText}`;
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
