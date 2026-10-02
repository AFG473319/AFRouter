import { NextResponse } from "next/server";
import { fetchClineFreeTierModels } from "open-sse/services/clinepassModels.js";

// GET /api/providers/cline/free-models - Free tier from Cline's public
// recommended-models feed (no auth; Cline's own SDK calls it unauthenticated).
// Powers the dashboard's "Add free models" button on the cline provider page.
export async function GET() {
  try {
    const models = await fetchClineFreeTierModels();
    if (!models) {
      return NextResponse.json({ error: "Failed to fetch Cline free models" }, { status: 502 });
    }
    return NextResponse.json({ models });
  } catch (error) {
    console.log("Error fetching Cline free models:", error?.message || error);
    return NextResponse.json({ error: "Failed to fetch Cline free models" }, { status: 502 });
  }
}
