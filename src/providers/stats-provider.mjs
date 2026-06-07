import { readFile } from "node:fs/promises";
import { projectPath, readJson } from "../db.mjs";

export async function fetchTeamStats({ providerConfig }) {
  const mode = providerConfig?.mode || "mock";

  if (mode === "mock") {
    return readJson(["data", "team-stats.json"], []);
  }

  if (mode === "file") {
    const filePath = providerConfig.filePath || "data/team-stats.json";
    const raw = await readFile(projectPath(...filePath.split(/[\\/]/)), "utf8");
    return JSON.parse(raw);
  }

  throw new Error(`Unsupported stats provider mode: ${mode}. Add a licensed stats adapter before live tournament use.`);
}
