(function attachSelectionCore(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.WorldCupMagikSelectionCore = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function createSelectionCore() {
  "use strict";

  const defaultSlip = [
    ["single", "Single"],
    ["double", "Double"],
    ["trixie", "Trixie"],
    ["accumulator_3", "3-leg accumulator"],
    ["accumulator_4", "4-leg accumulator"],
    ["accumulator_5", "5-leg accumulator"],
    ["accumulator_6", "6-leg accumulator"],
    ["accumulator_8", "8-leg accumulator"]
  ];
  const defaultPickSlip = [
    ["single", "Single"],
    ["double", "Double"],
    ["trixie", "Trixie"],
    ["accumulator_4", "4-leg accumulator"],
    ["accumulator_8", "8-leg accumulator"]
  ];
  const playerMarkets = new Set([
    "anytime_scorer",
    "first_goalscorer",
    "anytime_assist",
    "score_or_assist",
    "player_card",
    "player_shot",
    "player_shot_on_target",
    "goalkeeper_saves"
  ]);

  function prepareCandidates({ candidates = [], fixtures = [], lineups = null, now = new Date(), cutoffMinutes = 75 } = {}) {
    const fixtureById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
    const eligible = [];
    const provisional = [];
    const excluded = [];

    for (const candidate of candidates) {
      const fixture = fixtureById.get(candidate.fixtureId) || fixtureFromCandidate(candidate);
      const decision = evaluatePlayerProp({ candidate, fixture, lineups, now, cutoffMinutes });
      const decorated = {
        ...candidate,
        lineupStatus: decision.status,
        lineupPlaceable: decision.placeable,
        lineupReason: decision.reason
      };

      if (decision.status === "provisional") {
        provisional.push(decorated);
      } else if (decision.status === "confirmed_non_starter") {
        excluded.push(decorated);
      } else {
        eligible.push(decorated);
      }
    }

    return {
      eligible,
      provisional,
      excluded,
      summary: {
        inputCount: candidates.length,
        eligibleCount: eligible.length,
        provisionalCount: provisional.length,
        excludedNonStarterCount: excluded.length
      }
    };
  }

  function evaluatePlayerProp({ candidate, fixture, lineups = null, now = new Date(), cutoffMinutes = 75 } = {}) {
    if (!isPlayerProp(candidate)) {
      return { status: "not_player_prop", placeable: true, reason: "" };
    }

    if (!fixture || !isLineupRequired(fixture, now, cutoffMinutes)) {
      return { status: "lineup_not_required_yet", placeable: true, reason: "" };
    }

    const lineup = lineupForFixture(lineups, fixture);
    if (!lineup) {
      return provisional("Confirmed team sheet is not available yet");
    }

    const playerName = candidate.playerName || candidate.outcome;
    const playerTeam = candidate.playerTeam || candidate.team;

    if (playerTeam) {
      const team = teamLineup(lineup, playerTeam);
      if (!isConfirmedLineup(team)) {
        return provisional(`${playerTeam} confirmed XI is not available yet`);
      }

      return starterDecision(team, playerName, playerTeam);
    }

    const confirmedTeams = Object.entries(lineup.teams || {}).filter(([, team]) => isConfirmedLineup(team));
    const starterTeam = confirmedTeams.find(([, team]) => team.starters.some((starter) => playerNamesMatch(starter, playerName)));

    if (starterTeam) {
      return { status: "confirmed_starter", placeable: true, reason: `Confirmed starter for ${starterTeam[0]}` };
    }

    if (confirmedTeams.length >= 2) {
      return { status: "confirmed_non_starter", placeable: false, reason: "Not in either confirmed starting XI" };
    }

    return provisional("Player team is unclear or one confirmed XI is still missing");
  }

  function buildBetslip({ candidates = [], risk = 0, slipTypes, likely = false } = {}) {
    const types = slipTypes || (likely ? defaultPickSlip : defaultSlip);
    const appetite = clamp(Number(risk || 0) / 100, 0, 1);
    const eligible = candidates
      .filter((leg) => !leg.hardBlocks?.length)
      .filter((leg) => leg.lineupPlaceable !== false && leg.lineupStatus !== "provisional")
      .filter((leg) => Number(leg.modelProbability || leg.likelyProbability || 0) > 0)
      .filter((leg) => Number(leg.decimalOdds || 0) > 1)
      .filter((leg, index, items) => items.findIndex((other) => legSignalKey(other) === legSignalKey(leg)) === index);

    return types.map(([key, label], index) => {
      const legCount = legCountForKey(key);
      const legs = selectLegs(eligible, { legCount, appetite, likely });

      if (legs.length !== legCount) {
        return null;
      }

      return scoreSlip({ key, label, legs, risk, likely, rank: index + 1 });
    }).filter(Boolean);
  }

  function selectLegs(candidates, { legCount, appetite, likely }) {
    const ranked = [...candidates].sort((left, right) => {
      const scoreDifference = candidateScore(right, { legCount, appetite, likely }) - candidateScore(left, { legCount, appetite, likely });
      return scoreDifference || legSignalKey(left).localeCompare(legSignalKey(right));
    });
    const selected = [];

    addLegs(selected, ranked, legCount, appetite, { sameFixture: false });
    addLegs(selected, ranked, legCount, appetite, { sameFixture: true });

    return selected;
  }

  function addLegs(selected, ranked, legCount, appetite, { sameFixture }) {
    for (const leg of ranked) {
      if (selected.length >= legCount) {
        break;
      }

      if (!canAddLeg(selected, leg, legCount, appetite, sameFixture)) {
        continue;
      }

      selected.push(sameFixture && selected.some((item) => fixtureKey(item) === fixtureKey(leg))
        ? { ...leg, shortWindowFallback: true }
        : leg);
    }
  }

  function canAddLeg(selected, leg, legCount, appetite, sameFixture) {
    if (selected.some((item) => legSignalKey(item) === legSignalKey(leg))) {
      return false;
    }

    const sameGame = selected.filter((item) => fixtureKey(item) === fixtureKey(leg));
    if (!sameFixture && sameGame.length) {
      return false;
    }
    if (sameFixture && sameGame.length >= maximumSignalsPerFixture(legCount)) {
      return false;
    }
    if (sameGame.some((item) => marketFamily(item) === marketFamily(leg))) {
      return false;
    }
    if (sameGame.length && !sameFixtureBetBuilderCompatible([...sameGame, leg])) {
      return false;
    }

    const playerPropCount = selected.filter(isPlayerProp).length + (isPlayerProp(leg) ? 1 : 0);
    const firstScorerCount = selected.filter((item) => item.market === "first_goalscorer").length + (leg.market === "first_goalscorer" ? 1 : 0);
    const maxPlayerProps = legCount < 4 ? 1 : appetite >= 0.8 ? 2 : 1;
    if (playerPropCount > maxPlayerProps || firstScorerCount > (appetite >= 0.85 ? 1 : 0)) {
      return false;
    }

    return true;
  }

  function candidateScore(leg, { legCount, appetite, likely }) {
    const survival = survivalProbability(leg, legCount);
    const confidence = clamp(Number(leg.confidence || 0), 0, 1);
    const edge = clamp(Number(leg.independentEdge ?? leg.edge ?? 0), -0.15, 0.35);
    const odds = Math.max(1.01, Number(leg.decimalOdds || 1.01));
    const evidence = clamp(Number(leg.components?.nonMarketSignalCount || 0) / 6, 0, 1);
    const longSlipPressure = clamp((legCount - 2) / 6, 0, 1);
    const effectiveAppetite = likely ? 0 : appetite;
    const survivalProgress = clamp(effectiveAppetite / 0.8, 0, 1);
    const edgeBlend = clamp((effectiveAppetite - 0.8) / 0.2, 0, 1);
    const targetPerLegOdds = 1.45 + survivalProgress * 1.1 + edgeBlend * 1.25;
    const oddsFit = clamp(1 - Math.abs(Math.log(odds / targetPerLegOdds)) / 0.78, 0, 1);
    const survivalWeight = 112 - effectiveAppetite * 58 + longSlipPressure * 24;
    const edgeWeight = 18 + effectiveAppetite * 76;
    const priceWeight = (2 + effectiveAppetite * 14) * (1 - longSlipPressure * 0.55);
    const fragilePricePenalty = Math.max(0, odds - (2.1 + effectiveAppetite * 4.5)) * (9 + longSlipPressure * 15);

    return survival * survivalWeight
      + confidence * (20 - effectiveAppetite * 4)
      + edge * edgeWeight
      + Math.log(odds) * priceWeight
      + oddsFit * (legCount === 1 ? 30 : 12)
      + evidence * 7
      + clamp(Number(leg.score || 0), 0, 100) * 0.05
      - fragilePricePenalty;
  }

  function survivalProbability(leg, legCount = 1) {
    const model = clamp(Number(leg.learnedModelProbability ?? leg.modelProbability ?? leg.likelyProbability ?? 0), 0.01, 0.99);
    const market = clamp(Number(leg.marketImpliedProbability ?? leg.impliedProbability ?? 0), 0, 0.99);
    const confidence = clamp(Number(leg.confidence || 0.5), 0, 1);
    const pressure = clamp((legCount - 1) / 8, 0, 1);

    if (!market) {
      return clamp(model * (0.9 - pressure * 0.08) + confidence * (0.1 + pressure * 0.08), 0.02, 0.95);
    }

    const modelWeight = 0.68 - pressure * 0.13;
    const marketWeight = 0.24 + pressure * 0.16;
    const confidenceWeight = 1 - modelWeight - marketWeight;
    return clamp(model * modelWeight + market * marketWeight + confidence * confidenceWeight, 0.02, 0.95);
  }

  function scoreSlip({ key, label, legs, risk, likely, rank }) {
    const legCount = legs.length;
    const probabilities = legs.map((leg) => survivalProbability(leg, legCount));
    const combinedDecimalOdds = product(legs.map((leg) => Number(leg.decimalOdds || 1)));
    const combinedProbability = product(probabilities);
    const averageProbability = mean(probabilities);
    const averageConfidence = mean(legs.map((leg) => Number(leg.confidence || 0)));
    const averageIndependentEdge = mean(legs.map((leg) => Number(leg.independentEdge ?? leg.edge ?? 0)));
    const averageNonMarketSignalCount = mean(legs.map((leg) => Number(leg.components?.nonMarketSignalCount || 0)));
    const expectedValue = combinedProbability * combinedDecimalOdds - 1;
    const type = key === "trixie" ? "trixie" : key.startsWith("accumulator_") ? "accumulator" : key;
    const shortWindowFallback = new Set(legs.map(fixtureKey)).size < legs.length;
    const bestAvailableFallback = legs.some((leg) => leg.bestAvailableFallback);
    const displayRating = clamp(averageProbability * 0.7 + averageConfidence * 0.3 - (shortWindowFallback ? 0.035 : 0) - (bestAvailableFallback ? 0.06 : 0), 0.2, 0.97);
    const riskLegCount = legs.filter((leg) => ["calculated_risk", "longshot_value", "contrarian_value"].includes(leg.riskTag)).length;
    const playerPropCount = legs.filter(isPlayerProp).length;
    const selections = legs.map((leg) => leg.selectionLabel).join(" | ");
    const modeText = likely
      ? "Picks of the Day prioritise calibrated survival, confidence, and fixture separation."
      : `Risk ${Number(risk || 0)} balances calibrated survival against independent edge and price.`;
    const lineupText = playerPropCount
      ? ` ${playerPropCount} player prop(s) passed the current lineup-availability gate.`
      : "";
    const fallbackText = bestAvailableFallback
      ? " Best-available mode is active because strict confidence thresholds left this date range blank; structural safety blocks remain excluded."
      : "";
    const placeability = placeabilityForLegs(legs);

    return {
      id: `shared_${key}_${legs.map((leg) => leg.id).join("_").slice(0, 54)}`,
      rank,
      category: key,
      label,
      type,
      score: round(displayRating * 100, 2),
      legCount,
      legs,
      combinedDecimalOdds: round(combinedDecimalOdds, 6),
      combinedProbability: round(combinedProbability, 4),
      survivalCombinedProbability: round(combinedProbability, 4),
      averageSurvivalProbability: round(averageProbability, 4),
      expectedValue: round(expectedValue, 4),
      averageConfidence: round(averageConfidence, 4),
      averageIndependentEdge: round(averageIndependentEdge, 4),
      averageNonMarketSignalCount: round(averageNonMarketSignalCount, 2),
      displayRating: round(displayRating, 4),
      riskLegCount,
      scorerLegCount: legs.filter((leg) => ["anytime_scorer", "first_goalscorer", "anytime_assist"].includes(leg.market)).length,
      firstScorerLegCount: legs.filter((leg) => leg.market === "first_goalscorer").length,
      reusedSignalCount: 0,
      shortWindowFallback,
      bestAvailableFallback,
      ...placeability,
      returnStatus: placeability.directlyPlaceable ? "executable" : "research_only",
      thesis: `${modeText} Estimated slip chance ${round(combinedProbability * 100, 2)}%, average leg survival ${round(averageProbability * 100, 1)}%, independent edge ${round(averageIndependentEdge * 100, 2)}%, with ${round(averageNonMarketSignalCount, 1)} non-market signals per leg.${lineupText}${fallbackText} ${placeability.placeabilityReason} Legs: ${selections}.`
    };
  }

  function sameFixtureBetBuilderCompatible(legs) {
    if (legs.length < 2) {
      return true;
    }

    const bookmakerKeys = new Set(legs.map((leg) => normalizeName(leg.bookmakerKey || leg.components?.bookmakerKey)).filter(Boolean));
    const groups = new Set(legs.map(betBuilderGroup).filter(Boolean));
    return legs.every((leg) => (leg.bookmakerVerified === true || leg.components?.bookmakerVerified === true)
        && (leg.betBuilderCompatible === true || leg.components?.betBuilderCompatible === true)
        && Boolean(betBuilderGroup(leg)))
      && bookmakerKeys.size === 1
      && groups.size === 1;
  }

  function betBuilderGroup(leg) {
    return String(leg.betBuilderGroup
      || leg.betBuilderGroupId
      || leg.compatibilityGroup
      || leg.components?.betBuilderGroup
      || leg.components?.betBuilderGroupId
      || leg.components?.compatibilityGroup
      || "").trim();
  }

  function placeabilityForLegs(legs) {
    const bookmakerKeys = [...new Set(legs.map((leg) => String(leg.bookmakerKey || leg.components?.bookmakerKey || "").trim()).filter(Boolean))];
    const sourceBookmakers = [...new Set(legs.map((leg) => String(leg.bookmaker || "").trim()).filter(Boolean))];
    const sourcePublishers = [...new Set(legs.map((leg) => String(leg.pricePublisher || leg.source || "").trim()).filter(Boolean))];
    const verified = legs.every((leg) => leg.bookmakerVerified === true || leg.components?.bookmakerVerified === true);
    const groups = new Map();
    for (const leg of legs) {
      const key = fixtureKey(leg);
      groups.set(key, [...(groups.get(key) || []), leg]);
    }
    const sameFixtureCompatible = [...groups.values()].filter((group) => group.length > 1).every(sameFixtureBetBuilderCompatible);
    const directlyPlaceable = verified && bookmakerKeys.length === 1 && sameFixtureCompatible;
    const placeableBookmaker = directlyPlaceable ? (sourceBookmakers[0] || bookmakerKeys[0]) : null;

    return {
      placeabilityStatus: directlyPlaceable ? "verified_single_bookmaker" : "research_only",
      directlyPlaceable,
      placeableBookmaker,
      bookmakerKey: directlyPlaceable ? bookmakerKeys[0] : null,
      sourceBookmakers,
      sourcePublishers,
      sameFixtureBetBuilderVerified: sameFixtureCompatible,
      placeabilityReason: directlyPlaceable
        ? `All prices are verified at ${placeableBookmaker}; recheck the live price before placing.`
        : "Research-only price combination: one verified bookmaker could not be established, so no executable return is quoted."
    };
  }

  function starterDecision(team, playerName, teamName) {
    const starter = team.starters.find((name) => playerNamesMatch(name, playerName));
    return starter
      ? { status: "confirmed_starter", placeable: true, reason: `Confirmed starter for ${teamName}` }
      : { status: "confirmed_non_starter", placeable: false, reason: `Not in ${teamName} confirmed starting XI` };
  }

  function provisional(reason) {
    return { status: "provisional", placeable: false, reason };
  }

  function fixtureFromCandidate(candidate) {
    if (!candidate?.fixtureDate && !candidate?.date) {
      return null;
    }
    return {
      id: candidate.fixtureId,
      date: candidate.fixtureDate || candidate.date,
      dateKey: candidate.fixtureDateKey,
      homeTeam: candidate.homeTeam,
      awayTeam: candidate.awayTeam
    };
  }

  function isPlayerProp(candidate) {
    const market = String(candidate?.market || "").toLowerCase();
    return Boolean(candidate?.playerName)
      || playerMarkets.has(market)
      || market.startsWith("player_")
      || market.includes("goalscorer")
      || market.includes("assist");
  }

  function isLineupRequired(fixture, now, cutoffMinutes) {
    const kickoff = new Date(fixture?.date || fixture?.fixtureDate || 0).getTime();
    const current = new Date(now).getTime();
    if (!Number.isFinite(kickoff) || !Number.isFinite(current)) {
      return false;
    }
    const minutes = (kickoff - current) / 60000;
    return minutes >= -15 && minutes <= Number(cutoffMinutes || 75);
  }

  function lineupForFixture(feed, fixture) {
    const records = feed?.lineups || [];
    return records.find((record) => record.fixtureId === fixture.id)
      || records.find((record) => sameTeam(record.homeTeam, fixture.homeTeam)
        && sameTeam(record.awayTeam, fixture.awayTeam)
        && String(record.fixtureDate || "").slice(0, 10) === String(fixture.dateKey || fixture.date || "").slice(0, 10))
      || null;
  }

  function teamLineup(lineup, teamName) {
    if (!lineup?.teams || !teamName) {
      return null;
    }
    return lineup.teams[teamName]
      || Object.entries(lineup.teams).find(([name]) => sameTeam(name, teamName))?.[1]
      || null;
  }

  function isConfirmedLineup(team) {
    return team?.status === "confirmed" && plausibleStarters(team.starters);
  }

  function plausibleStarters(starters) {
    return Array.isArray(starters) && starters.length >= 7;
  }

  function playerNamesMatch(left, right) {
    const a = normalizeName(left);
    const b = normalizeName(right);
    if (!a || !b) {
      return false;
    }
    if (a === b || a.endsWith(` ${b}`) || b.endsWith(` ${a}`)) {
      return true;
    }
    const aTokens = a.split(" ");
    const bTokens = b.split(" ");
    const aSurname = aTokens.at(-1);
    const bSurname = bTokens.at(-1);
    if (!aSurname || aSurname.length <= 3 || aSurname !== bSurname || ["player", "unknown"].includes(aSurname)) {
      return false;
    }
    if (aTokens.length === 1 || bTokens.length === 1) {
      return true;
    }
    return aTokens[0][0] === bTokens[0][0];
  }

  function sameTeam(left, right) {
    const a = normalizeName(left);
    const b = normalizeName(right);
    return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
  }

  function fixtureKey(leg) {
    const home = normalizeName(leg.homeTeam);
    const away = normalizeName(leg.awayTeam);
    return home && away ? `${home}|${away}` : String(leg.fixtureId || leg.id || "");
  }

  function legSignalKey(leg) {
    return [fixtureKey(leg), normalizeName(leg.market), normalizeName(leg.outcome), normalizeName(leg.playerName), normalizeName(leg.selectionLabel)].join("|");
  }

  function marketFamily(leg) {
    const market = String(leg.market || "");
    if (market.includes("scorer") || market.includes("assist")) return "player_goal_action";
    if (market.includes("shot")) return "player_shots";
    if (market.includes("card")) return "cards";
    if (market.includes("goal") || market.includes("btts") || market.includes("both_teams")) return "goals";
    if (market.includes("winner") || market.includes("chance") || market.includes("handicap") || market === "draw_no_bet") return "result";
    return market || normalizeName(leg.selectionLabel);
  }

  function maximumSignalsPerFixture(legCount) {
    return legCount >= 6 ? 2 : 1;
  }

  function legCountForKey(key) {
    if (key === "single") return 1;
    if (key === "double") return 2;
    if (key === "trixie") return 3;
    return Number(String(key).match(/\d+/)?.[0] || 1);
  }

  function normalizeName(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function product(values) {
    return values.reduce((total, value) => total * Number(value || 0), 1);
  }

  function mean(values) {
    return values.length ? values.reduce((total, value) => total + Number(value || 0), 0) / values.length : 0;
  }

  function round(value, places = 2) {
    const multiplier = 10 ** places;
    return Math.round((Number(value || 0) + Number.EPSILON) * multiplier) / multiplier;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number(value || 0)));
  }

  return {
    buildBetslip,
    defaultPickSlip,
    defaultSlip,
    evaluatePlayerProp,
    isLineupRequired,
    isPlayerProp,
    prepareCandidates
  };
}));
