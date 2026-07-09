export const DEFAULT_LINEUP_MIN_MINUTES_BEFORE = -10;
export const DEFAULT_LINEUP_MAX_MINUTES_BEFORE = 125;
export const DEFAULT_LINEUP_FINAL_PASS_MINUTES_BEFORE = 28;
export const DEFAULT_LINEUP_FINAL_PASS_TOLERANCE_MINUTES = 4;

export function lineupWindowFromEnv(env = process.env) {
  return {
    minMinutesBefore: numberFromEnv(env.LINEUP_MIN_MINUTES_BEFORE, DEFAULT_LINEUP_MIN_MINUTES_BEFORE),
    maxMinutesBefore: numberFromEnv(env.LINEUP_MAX_MINUTES_BEFORE, DEFAULT_LINEUP_MAX_MINUTES_BEFORE)
  };
}

export function lineupFinalPassFromEnv(env = process.env) {
  return {
    targetMinutesBefore: numberFromEnv(env.LINEUP_FINAL_PASS_MINUTES_BEFORE, DEFAULT_LINEUP_FINAL_PASS_MINUTES_BEFORE),
    toleranceMinutes: numberFromEnv(env.LINEUP_FINAL_PASS_TOLERANCE_MINUTES, DEFAULT_LINEUP_FINAL_PASS_TOLERANCE_MINUTES)
  };
}

export function isInsideLineupWindow(fixture, currentTime, window = lineupWindowFromEnv()) {
  const minutes = minutesUntilKickoff(fixture, currentTime);
  return minutes >= window.minMinutesBefore && minutes <= window.maxMinutesBefore;
}

export function isInsideFinalLineupPass(fixture, currentTime, finalPass = lineupFinalPassFromEnv()) {
  const minutes = minutesUntilKickoff(fixture, currentTime);
  return Math.abs(minutes - finalPass.targetMinutesBefore) <= finalPass.toleranceMinutes;
}

export function minutesUntilKickoff(fixture, currentTime) {
  return (new Date(fixture.date).getTime() - currentTime.getTime()) / 60000;
}

function numberFromEnv(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}
