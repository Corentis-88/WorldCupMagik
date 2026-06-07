import { clamp, round } from "./utils.mjs";

export function rankBookmakerOffers(offers, policy, now = new Date()) {
  const offerPolicy = policy.bookmakerOfferPolicy || {};

  return offers
    .map((offer) => scoreOffer(offer, offerPolicy, now))
    .filter((offer) => !offer.hardBlocks.length)
    .sort((left, right) => right.score - left.score)
    .map((offer, index) => ({ ...offer, rank: index + 1 }));
}

export function scoreOffer(offer, offerPolicy, now = new Date()) {
  const hardBlocks = [];
  const region = offerPolicy.region || "GB";
  const expired = offer.expiresAt && new Date(offer.expiresAt) < now;
  const netPromoValue = Number(offer.advertisedValue || 0) * Number(offer.freeBetConversionRate || 0);
  const wageringPenalty = Math.max(0, Number(offer.wageringRequirement || 1) - 1) * 8;
  const minimumOddsPenalty = Math.max(0, Number(offer.minOddsDecimal || 1) - 1.5) * 8;
  const withdrawalPenalty = Number(offer.withdrawalRestrictionScore || 0) * 14;
  const frictionPenalty = Number(offer.accountFriction || 0) * 8;
  const coverageScore = Number(offer.worldCupMarketCoverage || 0) * 24 + Number(offer.oddsBoostCoverage || 0) * 8;
  const clarityScore = Number(offer.termsClarity || 0) * 18;
  const valueScore = clamp(netPromoValue / 2.4, 0, 30);
  const responsibleGamblingScore = offer.responsibleGamblingTools ? 8 : -18;
  const score = clamp(
    30 + valueScore + coverageScore + clarityScore + responsibleGamblingScore - wageringPenalty - minimumOddsPenalty - withdrawalPenalty - frictionPenalty,
    0,
    100
  );

  if (offer.available === false) {
    hardBlocks.push("offer_not_available");
  }

  if (offer.region !== region) {
    hardBlocks.push("region_mismatch");
  }

  if (expired && offerPolicy.excludeExpired !== false) {
    hardBlocks.push("offer_expired");
  }

  if (Number(offer.termsClarity || 0) < Number(offerPolicy.minTermsClarity || 0)) {
    hardBlocks.push("terms_clarity_below_policy_minimum");
  }

  if (offerPolicy.requireResponsibleGamblingTools && !offer.responsibleGamblingTools) {
    hardBlocks.push("missing_responsible_gambling_tools");
  }

  return {
    ...offer,
    score: round(score, 2),
    netPromoValue: round(netPromoValue, 2),
    hardBlocks,
    thesis: buildOfferThesis({ offer, score, netPromoValue, wageringPenalty, minimumOddsPenalty, withdrawalPenalty, frictionPenalty })
  };
}

function buildOfferThesis({ offer, score, netPromoValue, wageringPenalty, minimumOddsPenalty, withdrawalPenalty, frictionPenalty }) {
  return `${offer.bookmaker} scores ${round(score, 1)}. Estimated usable promo value ${round(netPromoValue, 2)}, World Cup coverage ${round(Number(offer.worldCupMarketCoverage || 0) * 100, 1)}%, terms clarity ${round(Number(offer.termsClarity || 0) * 100, 1)}%. Penalties: wagering ${round(wageringPenalty, 1)}, minimum odds ${round(minimumOddsPenalty, 1)}, withdrawals ${round(withdrawalPenalty, 1)}, account friction ${round(frictionPenalty, 1)}.`;
}
