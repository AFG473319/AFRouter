import { NextResponse } from "next/server";
import { FILTERS } from "./filters.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  const type = searchParams.get("type");

  if (!url || !type) {
    return NextResponse.json({ error: "Missing url or type" }, { status: 400 });
  }

  const filter = FILTERS[type];
  if (!filter) {
    return NextResponse.json({ error: "Unknown filter type" }, { status: 400 });
  }

  try {
    const res = await fetch(url);
    if (!res.ok) {
      return NextResponse.json({ data: [] });
    }
    const json = await res.json();
    const raw = json.data ?? json.models ?? json;
    // Most provider catalogs are arrays. models.dev is a provider map, so pass
    // that object as a single item and let the provider filter unwrap it.
    const data = filter(Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? [raw] : []));
    return NextResponse.json({ data });
  } catch {
    return NextResponse.json({ data: [] });
  }
}
