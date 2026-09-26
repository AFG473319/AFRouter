import fs from "fs/promises";
import path from "path";
import { getDataDir } from "@/lib/dataDir.js";

// Durable record of which Pi model ids AFRouter wrote into the `afrouter`
// provider in models.json, keyed by the models.json path (the agent dir moves
// with $PI_CODING_AGENT_DIR, and homedir varies per machine).
//
// It cannot live in Pi's own config, and unlike ZCode there is no in-file marker
// either. A model entry is the one place in models.json a future Pi version is
// most likely to start validating strictly, so injecting a foreign key there to
// record ownership risks breaking the user's whole config to protect a delete.
// The ledger keeps that risk out of Pi's file entirely.
//
// `known` distinguishes "no record yet" from "recorded as owning nothing": the
// two need different pre-ledger behaviour, see readOwnership's callers.
const LEDGER_FILE = "pi-model-ownership.json";

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
export async function readOwnership(modelsPath) {
  const record = (await readLedger())[modelsPath];
  if (record && Array.isArray(record.models)) {
    return {
      known: true,
      models: record.models.filter((m) => typeof m === "string" && m),
    };
  }
  return { known: false, models: [] };
}

export async function writeOwnership(modelsPath, models) {
  const file = ledgerPath();
  const ledger = await readLedger();
  ledger[modelsPath] = {
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
