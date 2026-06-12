import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMobilePayload } from "../src/mobile-web-data.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(rootDir, "web", "data");
const latestPath = join(dataDir, "latest.json");
const mobilePath = join(dataDir, "mobile-latest.json");
const latest = JSON.parse(await readFile(latestPath, "utf8"));
const mobile = buildMobilePayload(latest);

await writeFile(mobilePath, `${JSON.stringify(mobile)}\n`, "utf8");
console.log(`Wrote ${mobilePath}`);
