const state = {
  data: null,
  lineups: null,
  lineupRefreshTimer: null,
  renderFrame: null
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

const el = {
  scanStamp: document.getElementById("scanStamp"),
  gatheringNotice: document.getElementById("gatheringNotice"),
  stake: document.getElementById("stakeInput"),
  dateFrom: document.getElementById("dateFromInput"),
  dateTo: document.getElementById("dateToInput"),
  risk: document.getElementById("riskInput"),
  riskSteps: document.querySelectorAll("[data-risk-step]"),
  riskValue: document.getElementById("riskValue"),
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
  input.addEventListener("input", () => {
    if (input === el.risk) {
      el.riskValue.textContent = el.risk.value;
    }

    scheduleRender();
  });
}

for (const button of el.riskSteps) {
  button.addEventListener("click", () => adjustRisk(Number(button.dataset.riskStep || 0)));
}

loadData();
registerServiceWorker();

async function loadData() {
  el.scanStamp.textContent = "Loading mobile database...";

  try {
    const [database, lineups] = await Promise.all([
      fetchRequiredJson("./data/mobile-latest.json"),
      fetchOptionalJson("./data/lineups-latest.json")
    ]);

    state.data = database;
    state.lineups = lineups;
    initialiseDateInputs();
    render();
    startLineupRefresh();
  } catch (error) {
    el.scanStamp.textContent = `No mobile database yet: ${error.message}`;
    el.betslip.innerHTML = `<article class="bet-card">The mobile database is still publishing.</article>`;
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
    return response.ok ? response.json() : null;
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
  if (!state.data || !hasLineupSensitiveFixture()) {
    return;
  }

  const lineups = await fetchOptionalJson("./data/lineups-latest.json");

  if (!lineups || lineupFeedKey(lineups) === lineupFeedKey(state.lineups)) {
    return;
  }

  state.lineups = lineups;
  scheduleRender();
}

function lineupFeedKey(lineups) {
  return `${lineups?.generatedAt || ""}|${lineups?.lineups?.length || 0}|${lineups?.diagnostics?.length || 0}`;
}

function hasLineupSensitiveFixture() {
  return (state.data?.fixtures || []).some((fixture) => {
    const minutes = minutesUntilKickoff(fixture);
    return minutes >= -15 && minutes <= 130;
  });
}

function adjustRisk(step) {
  const min = Number(el.risk.min || 0);
  const max = Number(el.risk.max || 100);
  const next = Math.max(min, Math.min(max, Number(el.risk.value || 0) + step));

  el.risk.value = String(next);
  el.riskValue.textContent = el.risk.value;
  scheduleRender();
}

function scheduleRender() {
  if (!state.data) {
    return;
  }

  if (state.renderFrame) {
    cancelAnimationFrame(state.renderFrame);
  }

  state.renderFrame = requestAnimationFrame(() => {
    state.renderFrame = null;
    render();
  });
}

function render() {
  const risk = Number(el.risk.value);
  const riskBucket = nearest(state.data.riskBuckets || [risk], risk);
  const dayBucket = selectedDayBucket();
  const profile = state.data.profiles?.[`d${dayBucket}_r${riskBucket}`] || null;
  const pickProfile = state.data.pickOfTheDay?.[`d${dayBucket}`] || null;
  const stakePerBet = round(Number(el.stake.value || 10), 2);
  const slip = recalculateSlip(profile?.betslip || [], stakePerBet);
  const pickSlip = recalculateSlip(pickProfile?.betslip || [], stakePerBet);
  const gathering = automaticGatheringState(state.data);

  el.riskValue.textContent = String(risk);
  el.scanStamp.textContent = gathering.active
    ? gathering.message
    : `Latest database: ${new Date(state.data.generatedAt).toLocaleString()} | mobile`;
  el.gatheringNotice.hidden = !gathering.active;
  el.gatheringNotice.textContent = gathering.message;
  el.fixtureCount.textContent = `${profile?.fixtureCount || 0}`;
  el.edgeCount.textContent = `${profile?.eligibleLegCount || 0}`;
  el.memoryCount.textContent = `${state.data.summary?.memoryTeamCount || 0}`;
  el.returnTotal.textContent = money(slip.reduce((total, bet) => total + Number(bet.potentialReturn || 0), 0));
  el.marketLine.textContent = marketLine(state.data);

  renderSlip(slip, profile);
  renderPickOfDay(pickSlip, pickProfile || profile);
  renderLikelyGoalscorers(todayScorerGroups());
}

function initialiseDateInputs() {
  const range = state.data?.dateRange || fallbackDateRange();

  for (const input of [el.dateFrom, el.dateTo]) {
    input.min = range.min || "";
    input.max = range.max || "";
  }

  el.dateFrom.value = el.dateFrom.value || range.defaultFrom || range.min || "";
  el.dateTo.value = el.dateTo.value || range.defaultTo || range.max || el.dateFrom.value || "";
}

function selectedDayBucket() {
  const range = state.data?.dateRange || fallbackDateRange();
  const buckets = state.data?.dayBuckets || [0];
  const selected = selectedDateRange();
  const base = parseDateKey(range.defaultFrom || range.min || selected.from);
  const to = parseDateKey(selected.to || selected.from);
  const days = base && to ? Math.max(0, Math.round((to - base) / 86400000)) : 0;

  return nearest(buckets, days);
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

function recalculateSlip(slip, stake) {
  return slip.map((bet) => ({
    ...bet,
    stake,
    potentialReturn: recalculateReturn(bet, stake)
  }));
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

  el.betslip.innerHTML = slip.map((bet) => betCard(bet)).concat(missingCards).join("");
}

function renderPickOfDay(slip, profile) {
  if (!slip.length) {
    const supported = supportedPickOfDaySlip(profile);
    el.pickOfDay.innerHTML = supported.length
      ? supported.map(([, label]) => unavailableCard(label, profile, "No most-likely pick passed the current checks yet.")).join("")
      : unavailableCard("Picks of the Day", profile, "No matches exist in this selected date range yet.");
    return;
  }

  const present = new Set(slip.map(categoryForBet));
  const missingCards = supportedPickOfDaySlip(profile)
    .filter(([key]) => !present.has(key))
    .map(([, label]) => unavailableCard(label, profile, "Not enough real data passed the most-likely checks for this card yet."));

  el.pickOfDay.innerHTML = slip.map((bet) => betCard(bet, { pick: true })).concat(missingCards).join("");
}

function betCard(bet, { pick = false } = {}) {
  return `
    <article class="bet-card${pick ? " pick-card" : ""}">
      <header>
        <span class="tag${pick ? " pick-tag" : ""}">${escapeHtml(bet.label || bet.type)}</span>
        <span class="score">${escapeHtml(confidenceLabel(bet, pick))}</span>
      </header>
      <ul class="legs">
        ${(bet.legs || []).map((leg) => `
          <li>
            ${escapeHtml(leg.selectionLabel)} <strong>@ ${Number(leg.decimalOdds || 0).toFixed(2)}</strong>
            <span class="leg-note">${escapeHtml(formatLegNote(leg, pick))}</span>
          </li>
        `).join("")}
      </ul>
      <p class="why">${escapeHtml(bet.thesis || "The model found enough value, confidence, and fixture separation for this slip.")}</p>
      <div class="bet-meta">
        <div><span>Odds</span><strong>${Number(bet.combinedDecimalOdds || 0).toFixed(2)}</strong></div>
        <div><span>Stake</span><strong>${money(bet.stake)}</strong></div>
        <div><span>Return</span><strong>${money(bet.potentialReturn)}</strong></div>
      </div>
    </article>
  `;
}

function unavailableCard(label, profile, prefix = "No real-data pick passed this date/risk profile yet.") {
  const fixtureText = Number(profile?.fixtureCount || 0) > 0
    ? `${profile.fixtureCount} game(s) checked.`
    : "No games in the selected window.";

  return `
    <article class="bet-card unavailable">
      <header>
        <span class="tag">${escapeHtml(label)}</span>
        <span class="score">waiting</span>
      </header>
      <p class="why">${escapeHtml(`${prefix} ${fixtureText}`)}</p>
    </article>
  `;
}

function supportedPickOfDaySlip(profile) {
  const fixtureCount = Number(profile?.fixtureCount || 0);

  if (fixtureCount <= 0) {
    return [];
  }

  return pickOfDaySlip.filter(([key]) => {
    const legs = key === "single" ? 1 : key === "double" ? 2 : key === "trixie" ? 3 : Number(key.match(/\d+/)?.[0] || 1);
    return fixtureCount >= legs;
  });
}

function categoryForBet(bet) {
  if (bet.category) {
    return bet.category;
  }

  if (bet.type === "accumulator") {
    return `accumulator_${bet.legCount || (bet.legs || []).length}`;
  }

  return bet.type || "unknown";
}

function todayScorerGroups() {
  const today = localDateKey(new Date());
  const groups = state.data?.likelyScorersByDate?.[today] || [];

  return groups.map((group) => {
    const players = applyLineupAdjustments(group.players || [], group.fixture).slice(0, 4);

    return {
      ...group,
      players,
      lineupNotice: scorerLineupNotice(group.fixture, players)
    };
  });
}

function renderLikelyGoalscorers(groups) {
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

function applyLineupAdjustments(players, fixture) {
  const lineup = lineupForFixture(fixture);
  const lineupRequired = isLineupRequiredForFixture(fixture);

  if (!lineup) {
    return lineupRequired ? [] : players;
  }

  const adjusted = [];

  for (const player of players) {
    const team = teamLineupFromRecord(lineup, player.team);
    const teamConfirmed = isConfirmedTeamLineup(team);

    if (!teamConfirmed) {
      if (!lineupRequired) {
        adjusted.push(player);
      }
      continue;
    }

    const starterName = team.starters.find((starter) => playerNamesMatch(starter, player.playerName));

    if (!starterName) {
      if (!lineupRequired) {
        adjusted.push({
          ...player,
          lineupStatus: "not_starting",
          probability: clamp(Number(player.probability || 0) * 0.08, 0.01, 0.08),
          confidence: clamp(Number(player.confidence || 0) * 0.55, 0, 1),
          sourceWeight: Number(player.sourceWeight || 0) * 0.35,
          reason: `${player.reason} | not in confirmed XI`
        });
      }
      continue;
    }

    adjusted.push({
      ...player,
      playerName: betterDisplayPlayerName(starterName, player.playerName),
      lineupStatus: "confirmed_starter",
      reason: `${player.reason} | confirmed starter`
    });
  }

  if (lineupRequired) {
    return adjusted.filter((player) => player.lineupStatus === "confirmed_starter");
  }

  const starterOnly = adjusted.filter((player) => player.lineupStatus !== "not_starting");
  return starterOnly.length ? starterOnly : adjusted;
}

function lineupForFixture(fixture) {
  const records = state.lineups?.lineups || [];

  return records.find((record) => record.fixtureId === fixture.id)
    || records.find((record) => sameTeam(record.homeTeam, fixture.homeTeam)
      && sameTeam(record.awayTeam, fixture.awayTeam)
      && String(record.fixtureDate || "").slice(0, 10) === (fixture.dateKey || dateKey(fixture.date)))
    || null;
}

function teamLineupFromRecord(lineup, teamName) {
  if (!lineup?.teams || !teamName) {
    return null;
  }

  return lineup.teams[teamName]
    || Object.entries(lineup.teams).find(([team]) => sameTeam(team, teamName))?.[1]
    || null;
}

function scorerLineupNotice(fixture, players) {
  if (!isLineupRequiredForFixture(fixture)) {
    return "";
  }

  const lineup = lineupForFixture(fixture);

  if (!lineup) {
    return "Confirmed lineups are not available yet; scorer picks are hidden until the XI check lands.";
  }

  const missingTeams = [fixture.homeTeam, fixture.awayTeam]
    .filter((team) => !isConfirmedTeamLineup(teamLineupFromRecord(lineup, team)));

  if (!players.length && missingTeams.length) {
    return `Waiting for confirmed ${missingTeams.join(" and ")} XI; scorer picks are hidden for now.`;
  }

  if (!players.length) {
    return "Confirmed lineups were found, but no scorer candidate matched the starting XIs.";
  }

  if (missingTeams.length) {
    return `Only confirmed starters are shown; waiting for confirmed ${missingTeams.join(" and ")} XI.`;
  }

  return "";
}

function isConfirmedTeamLineup(team) {
  return team?.status === "confirmed" && Array.isArray(team.starters) && team.starters.length >= 7;
}

function isLineupRequiredForFixture(fixture, now = new Date()) {
  const minutes = minutesUntilKickoff(fixture, now);
  return minutes >= scorerLineupGate.minMinutesBeforeKickoff
    && minutes <= scorerLineupGate.maxMinutesBeforeKickoff;
}

function minutesUntilKickoff(fixture, now = new Date()) {
  return (new Date(fixture.date).getTime() - now.getTime()) / 60000;
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

  const aSurname = a.split(/\s+/).filter(Boolean).at(-1);
  const bSurname = b.split(/\s+/).filter(Boolean).at(-1);

  return Boolean(aSurname && bSurname && aSurname.length > 3 && aSurname === bSurname);
}

function betterDisplayPlayerName(starterName, fallbackName) {
  return String(starterName || "").trim().length > String(fallbackName || "").trim().length
    ? starterName
    : fallbackName;
}

function sameTeam(left, right) {
  return normalizeLookupKey(left) === normalizeLookupKey(right);
}

function normalizeLookupKey(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function formatLegNote(leg, likely = false) {
  const rawAi = Number(leg.rawModelProbability || leg.modelProbability || leg.likelyProbability || 0);
  const market = Number(leg.marketImpliedProbability || leg.impliedProbability || 0);
  const independentEdge = Number(leg.independentEdge ?? (rawAi - market));
  const signals = Number(leg.components?.nonMarketSignalCount || 0);
  const bookmaker = leg.bookmaker ? ` via ${leg.bookmaker}` : "";

  if (likely) {
    return `AI survival ${percent(leg.likelyProbability || leg.modelProbability)}${bookmaker} | raw AI ${percent(rawAi)} vs market ${percent(market)} | edge ${percent(independentEdge)} | ${signals} signals`;
  }

  const tag = String(leg.riskTag || "edge").replace(/_/g, " ");
  return `${tag}${bookmaker} | AI ${percent(rawAi)} vs market ${percent(market)} | edge ${percent(independentEdge)} | ${signals} signals | data ${percent(leg.confidence)}`;
}

function confidenceLabel(bet, likely = false) {
  const rating = Number(bet.displayRating || bet.combinedProbability || bet.score / 100 || 0);
  return `AI Rating ${percent(clamp(rating, 0, likely ? 0.97 : 0.95))}`;
}

function marketLine(data) {
  const labels = {
    match_winner: "Match winner",
    draw_no_bet: "Draw no bet",
    anytime_scorer: "Anytime scorer",
    first_goalscorer: "First goalscorer",
    both_teams_to_score: "BTTS",
    double_chance: "Double chance",
    over_1_5_goals: "Over 1.5",
    over_2_5_goals: "Over 2.5",
    under_2_5_goals: "Under 2.5",
    under_3_5_goals: "Under 3.5",
    under_4_5_goals: "Under 4.5",
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
  const scorerCount = Number(observed.anytime_scorer || 0) + Number(observed.first_goalscorer || 0);
  const survivalCount = Number(data?.markets?.survivabilityCoverage?.summary?.freshRecordCount || 0);
  const collectOnlyText = collectOnly.length
    ? ` Survival data: ${collectOnly.map((market) => labels[market] || market).join(", ")}${survivalCount ? ` (${survivalCount}).` : "."}`
    : "";

  return `Markets: ${active}.${scorerCount ? ` Scorer prices found: ${scorerCount}.` : ""}${collectOnlyText}`;
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
    return endMinute < 1440
      ? currentMinute >= startMinute && currentMinute < endMinute
      : currentMinute >= startMinute || currentMinute < (endMinute - 1440);
  });

  return { active, message };
}

function recalculateReturn(bet, stake) {
  if (bet.type !== "trixie" || !Array.isArray(bet.legs) || bet.legs.length !== 3) {
    return round(stake * Number(bet.combinedDecimalOdds || 0), 2);
  }

  const odds = bet.legs.map((leg) => Number(leg.decimalOdds || 1));
  const unit = stake / 4;
  return round(unit * ((odds[0] * odds[1]) + (odds[0] * odds[2]) + (odds[1] * odds[2]) + (odds[0] * odds[1] * odds[2])), 2);
}

function nearest(values, value) {
  return values.reduce((winner, item) => Math.abs(item - value) < Math.abs(winner - value) ? item : winner, values[0]);
}

function parseDateKey(value) {
  if (!value) {
    return null;
  }

  const date = new Date(`${value}T00:00:00`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function dateKey(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
}

function localDateKey(date) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function formatKickoff(value) {
  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return "Kickoff TBC";
  }

  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function money(value) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(Number(value || 0));
}

function percent(value) {
  return `${Math.round(Number(value || 0) * 1000) / 10}%`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
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
