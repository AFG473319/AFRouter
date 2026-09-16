import fs from "fs/promises";
import path from "path";
import { getDataDir } from "@/lib/dataDir.js";

// Durable record of which ZCode model keys AFRouter wrote into the `AFRouter`
// provider entry, keyed by the ZCode config path (homedir varies per machine).
//
// It cannot live in ZCode's config: ZCode rewrites ~/.zcode/v2/config.json on
// exit and its model-entry normalizer rebuilds each model from a fixed key list
// (`modalitiesConfigured`, `reasoning`, `priority`, `modified`, `deleted`, …)
// that does not include our `afrouter` marker, so the marker is destroyed the
// first time ZCode closes. Observed on a real config: 7 marker-bearing models
// became 7 unmarked models with none removed.
const LEDGER_FILE = "zcode-model-ownership.json";

// Resolved per call (not at module load) so DATA_DIR overrides — and the test
// suite's temp dir — take effect without reloading the module.
const ledgerPath = () => path.join(getDataDir(), LEDGER_FILE);

const readLedger = async () => {
  try {
    const parsed = JSON.parse(await fs.readFile(ledgerPath(), "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

/**
 * @returns {Promise<{known: boolean, models: string[]}>} `known` distinguishes
 * "no ledger record yet" (migration pending) from "recorded as owning nothing".
 */
export async function readOwnership(configPath) {
  const record = (await readLedger())[configPath];
  if (record && Array.isArray(record.models)) {
    return {
      known: true,
      models: record.models.filter((m) => typeof m === "string" && m),
    };
  }
  return { known: false, models: [] };
}

export async function writeOwnership(configPath, models) {
  const file = ledgerPath();
  const ledger = await readLedger();
  ledger[configPath] = {
    models: [...new Set((models || []).filter((m) => typeof m === "string" && m))],
    updatedAt: new Date().toISOString(),
  };

  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(ledger, null, 2));
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (error) {
      // Windows file-lock races with AV/editors, same retry as the config write.
      if ((error.code === "EPERM" || error.code === "EACCES") && attempt < 2) {
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      throw error;
    }
  }
}
