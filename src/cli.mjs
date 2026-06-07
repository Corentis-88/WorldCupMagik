import { runAnalysisCycle, runDailyCycle, runOfferRanking, runSnapshotCycle, showStatus } from "./day-runner.mjs";

const command = process.argv[2] || "daily";
const flags = new Set(process.argv.slice(3));

if (command === "daily") {
  await runDailyCycle({ forceSnapshot: flags.has("--force-snapshot") });
} else if (command === "snapshot") {
  await runSnapshotCycle({ forceSnapshot: flags.has("--force") || flags.has("--force-snapshot") });
} else if (command === "analyse" || command === "analyze") {
  await runAnalysisCycle();
} else if (command === "offers") {
  await runOfferRanking();
} else if (command === "status") {
  await showStatus();
} else {
  console.error(`Unknown WorldCupMagic command: ${command}`);
  process.exitCode = 1;
}
