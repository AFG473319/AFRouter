import { NextResponse } from "next/server";
import { getCustomModels, addCustomModel, deleteCustomModel } from "@/models";
import { lookupCustomModelSpecs } from "@/lib/modelCatalog/customSpecs.js";
import { CAPACITY_META, REASONING_EFFORT_LEVELS, isSttTransport } from "@/shared/constants/models";

export const dynamic = "force-dynamic";

// Whitelist capability keys to boolean values — ignore anything else.
// `reasoningEfforts` is the one non-boolean: the per-model selectable levels a
// source declared (Kilo's variant map, models.dev's effort ladder). It rides in
// `caps` so a saved model keeps the levels the picker showed, and is validated
// against the canonical ladder rather than trusted verbatim.
function sanitizeCaps(caps) {
  if (!caps || typeof caps !== "object") return null;
  const clean = {};
  for (const key of Object.keys(CAPACITY_META)) {
    if (typeof caps[key] === "boolean") clean[key] = caps[key];
  }
  if (Array.isArray(caps.reasoningEfforts)) {
    const efforts = [...new Set(caps.reasoningEfforts.filter((l) => REASONING_EFFORT_LEVELS.includes(l)))];
    if (efforts.length) clean.reasoningEfforts = efforts;
  }
  return Object.keys(clean).length ? clean : null;
}

// Accepted STT transport markers live in the shared whitelist
// (src/shared/constants/models STT_TRANSPORT_META) — the dashboard transport
// select and this validator must agree on one set, so neither owns a copy.
// Unknown or mistyped values are silently dropped, the same policy
// sanitizeCaps applies to capability keys.
function sanitizeTransport(transport, type) {
  if (type !== "stt" || !isSttTransport(transport)) return null;
  return transport.trim();
}

// GET /api/models/custom - List all custom models
export async function GET() {
  try {
    const models = await getCustomModels();
    return NextResponse.json({ models });
  } catch (error) {
    console.log("Error fetching custom models:", error);
    return NextResponse.json({ error: "Failed to fetch custom models" }, { status: 500 });
  }
}

// POST /api/models/custom - Add custom model
export async function POST(request) {
  try {
    const { providerAlias, id, type, name, caps, transport } = await request.json();
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    // Providers that publish their own catalog own the specs for their models:
    // Kilo Code / Kilo Gateway (api.kilo.ai/api/gateway/v1/models), OpenRouter,
    // Nous and NVIDIA all answer with real context windows, output caps,
    // modalities and a reasoning vocabulary. Without this a model saved from any
    // of them keeps no caps and silently inherits the 200K/64K floor — including
    // the 1M-window ones. Media models (stt/tts/embedding) are excluded: those
    // catalogs are shaped for chat and would answer with nonsense.
    const catalog = (type || "llm") === "llm" ? await lookupCustomModelSpecs(providerAlias, id) : null;
    // Catalog specs win over the caller's flags: the Add-Model form always sends
    // every checkbox, so an unticked "vision" is a form default, not a
    // measurement. A field the catalog does not publish keeps what was sent.
    const mergedCaps = { ...sanitizeCaps(caps), ...catalog?.caps };
    const cleanCaps = Object.keys(mergedCaps).length ? mergedCaps : null;
    const cleanTransport = sanitizeTransport(transport, type || "llm");
    const added = await addCustomModel({
      providerAlias, id, type: type || "llm",
      name: name || catalog?.name,
      ...(cleanCaps ? { caps: cleanCaps } : {}),
      ...(cleanTransport ? { transport: cleanTransport } : {}),
    });
    return NextResponse.json({ success: true, added });
  } catch (error) {
    console.log("Error adding custom model:", error);
    return NextResponse.json({ error: "Failed to add custom model" }, { status: 500 });
  }
}

// DELETE /api/models/custom?providerAlias=xxx&id=yyy&type=zzz
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const providerAlias = searchParams.get("providerAlias");
    const id = searchParams.get("id");
    const type = searchParams.get("type") || "llm";
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    await deleteCustomModel({ providerAlias, id, type });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting custom model:", error);
    return NextResponse.json({ error: "Failed to delete custom model" }, { status: 500 });
  }
}
