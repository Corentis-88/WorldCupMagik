import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const maxFileBytes = Number(process.env.WORLDCUPMAGIC_MAX_DATA_FILE_BYTES || 70 * 1024 * 1024);
const scannedRoots = ["data", join("web", "data")];
const files = [];

for (const root of scannedRoots) {
  await walk(join(rootDir, root), files);
}

const oversized = files
  .filter((file) => file.bytes > maxFileBytes)
  .sort((left, right) => right.bytes - left.bytes);

if (oversized.length) {
  console.error(`Data size guard failed. ${oversized.length} file(s) exceed ${formatBytes(maxFileBytes)}:`);
  for (const file of oversized) {
    console.error(`- ${file.relativePath}: ${formatBytes(file.bytes)}`);
  }
  process.exit(1);
}

const largest = [...files]
  .sort((left, right) => right.bytes - left.bytes)
  .slice(0, 8);

console.log(`Data size guard passed. Max allowed per file: ${formatBytes(maxFileBytes)}.`);
for (const file of largest) {
  console.log(`- ${file.relativePath}: ${formatBytes(file.bytes)}`);
}

async function walk(directory, out) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const fullPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      await walk(fullPath, out);
      continue;
    }

    if (!entry.isFile() || entry.name.endsWith(".lock")) {
      continue;
    }

    const info = await stat(fullPath);
    out.push({
      relativePath: relative(rootDir, fullPath).replace(/\\/g, "/"),
      bytes: info.size
    });
  }
}

function formatBytes(value) {
  const bytes = Number(value || 0);

  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  }

  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }

  return `${bytes} B`;
}
