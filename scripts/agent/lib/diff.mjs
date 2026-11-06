// Pixel diff of two PNGs (pure JS: pngjs + pixelmatch, no native binary).
import fs from "node:fs";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { HarnessError } from "./out.mjs";

export function diffPng(aPath, bPath, { out, threshold = 0.1, maxRatio = 0.002 } = {}) {
  let a;
  let b;
  try {
    a = PNG.sync.read(fs.readFileSync(aPath));
    b = PNG.sync.read(fs.readFileSync(bPath));
  } catch (e) {
    throw new HarnessError(`diff needs two PNG files: ${e.message}`);
  }
  if (a.width !== b.width || a.height !== b.height) {
    return { ok: false, sizeMismatch: true, a: `${a.width}x${a.height}`, b: `${b.width}x${b.height}` };
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const pixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold });
  const ratio = pixels / (a.width * a.height);
  if (out && pixels > 0) fs.writeFileSync(out, PNG.sync.write(diff));
  return { ok: ratio <= maxRatio, diffPixels: pixels, diffPercent: Math.round(ratio * 10000) / 100, size: `${a.width}x${a.height}`, ...(out && pixels > 0 ? { diffImage: out } : {}) };
}
