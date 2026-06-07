import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const writableDataDir = process.env.WORLDCUPMAGIC_DATA_DIR || "";

export function projectPath(...parts) {
  if (writableDataDir && parts[0] === "data") {
    return join(writableDataDir, ...parts.slice(1));
  }

  return join(rootDir, ...parts);
}

export async function readJson(pathParts, fallback) {
  try {
    const content = await withRetries(() => readFile(projectPath(...pathParts), "utf8"));
    return JSON.parse(stripBom(content));
  } catch (error) {
    if (writableDataDir && pathParts[0] === "data" && error?.code === "ENOENT") {
      try {
        const seedContent = await withRetries(() => readFile(join(rootDir, ...pathParts), "utf8"));
        return JSON.parse(stripBom(seedContent));
      } catch (seedError) {
        if (arguments.length > 1 && seedError?.code === "ENOENT") {
          return fallback;
        }
        throw seedError;
      }
    }

    if (arguments.length > 1 && error?.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export async function writeJson(pathParts, value) {
  const targetPath = projectPath(...pathParts);
  await withJsonFileLock(targetPath, async () => writeJsonUnlocked(targetPath, value));
}

export async function writeText(pathParts, value) {
  const targetPath = projectPath(...pathParts);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, value, "utf8");
}

export async function appendJsonRecords(pathParts, records, maxRecords = 5000) {
  const targetPath = projectPath(...pathParts);

  return withJsonFileLock(targetPath, async () => {
    const existing = await readJsonUnlocked(targetPath).catch(() => []);
    const merged = [...records, ...existing].slice(0, maxRecords);
    await writeJsonUnlocked(targetPath, merged);
    return merged;
  });
}

export async function upsertJsonRecords(pathParts, records, keyFn, maxRecords = 5000) {
  const targetPath = projectPath(...pathParts);

  return withJsonFileLock(targetPath, async () => {
    const existing = await readJsonUnlocked(targetPath).catch(() => []);
    const byKey = new Map(existing.map((record) => [keyFn(record), record]));

    for (const record of records) {
      byKey.set(keyFn(record), record);
    }

    const merged = [...byKey.values()]
      .sort((left, right) => new Date(right.createdAt || right.capturedAt || right.publishedAt || 0) - new Date(left.createdAt || left.capturedAt || left.publishedAt || 0))
      .slice(0, maxRecords);

    await writeJsonUnlocked(targetPath, merged);
    return merged;
  });
}

export async function loadEngineState() {
  const [policy, providers, fixtures, oddsSnapshots, newsArticles, teamStats, bookmakerOffers, heatSnapshots] = await Promise.all([
    readJson(["config", "engine-policy.json"]),
    readJson(["config", "providers.json"]),
    readJson(["data", "fixtures.json"], []),
    readJson(["data", "odds-snapshots.json"], []),
    readJson(["data", "news-articles.json"], []),
    readJson(["data", "team-stats.json"], []),
    readJson(["data", "bookmaker-offers.json"], []),
    readJson(["data", "heat-snapshots.json"], [])
  ]);

  return {
    policy,
    providers,
    fixtures,
    oddsSnapshots,
    newsArticles,
    teamStats,
    bookmakerOffers,
    heatSnapshots
  };
}

async function readJsonUnlocked(targetPath) {
  const content = await withRetries(() => readFile(targetPath, "utf8"));
  return JSON.parse(stripBom(content));
}

async function writeJsonUnlocked(targetPath, value) {
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;

  await mkdir(dirname(targetPath), { recursive: true });
  await withRetries(() => writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8"));

  try {
    await withRetries(() => rename(tempPath, targetPath));
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function withJsonFileLock(targetPath, callback) {
  const lockPath = `${targetPath}.lock`;
  const handle = await acquireLock(lockPath);

  try {
    return await callback();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

async function acquireLock(lockPath, timeoutMs = 30000) {
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(dirname(lockPath), { recursive: true });
      return await open(lockPath, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      await removeStaleLock(lockPath, 120000);

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for data file lock: ${lockPath}`);
      }

      await wait(75);
    }
  }
}

async function removeStaleLock(lockPath, maxAgeMs) {
  const info = await stat(lockPath).catch(() => null);

  if (info && Date.now() - info.mtimeMs > maxAgeMs) {
    await unlink(lockPath).catch(() => {});
  }
}

async function withRetries(operation, attempts = 5) {
  let lastError;

  for (let index = 0; index < attempts; index += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isTransientFileError(error) || index === attempts - 1) {
        throw error;
      }

      await wait(75 * (index + 1));
    }
  }

  throw lastError;
}

function isTransientFileError(error) {
  return ["EBUSY", "EMFILE", "ENFILE", "EPERM", "EACCES"].includes(error?.code);
}

function stripBom(value) {
  return String(value || "").replace(/^\uFEFF/, "");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
