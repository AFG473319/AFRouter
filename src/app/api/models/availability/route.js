import { NextResponse } from "next/server";
import {
  getProviderConnections,
  updateProviderConnection,
} from "@/lib/localDb";
import { listRetiredModels } from "open-sse/services/retiredModels.js";

const MODEL_LOCK_PREFIX = "modelLock_";

function getActiveModelLocks(connection) {
  const now = Date.now();
  return Object.entries(connection)
    .filter(([key, value]) => key.startsWith(MODEL_LOCK_PREFIX) && value)
    .map(([key, value]) => ({
      key,
      model: key.slice(MODEL_LOCK_PREFIX.length) || "__all",
      until: value,
      active: new Date(value).getTime() > now,
    }))
    .filter((lock) => lock.active);
}

export async function GET() {
  try {
    const connections = await getProviderConnections();
    const models = [];

    for (const connection of connections) {
      const locks = getActiveModelLocks(connection);
      // Retired ids carry a long model lock, so they must not also be reported
      // as a plain cooldown — the dashboard shows a distinct "retired" state.
      const retired = listRetiredModels(connection);
      const retiredModels = new Set(retired.map((r) => r.model));

      for (const entry of retired) {
        models.push({
          provider: connection.provider,
          model: entry.model,
          status: "retired",
          until: entry.until,
          strikes: entry.strikes,
          connectionId: connection.id,
          connectionName: connection.name || connection.email || connection.id,
          lastError: connection.lastError || null,
        });
      }

      for (const lock of locks) {
        if (retiredModels.has(lock.model)) continue;
        models.push({
          provider: connection.provider,
          model: lock.model,
          status: "cooldown",
          until: lock.until,
          connectionId: connection.id,
          connectionName: connection.name || connection.email || connection.id,
          lastError: connection.lastError || null,
        });
      }

      if (locks.length === 0 && connection.testStatus === "unavailable") {
        models.push({
          provider: connection.provider,
          model: "__all",
          status: "unavailable",
          connectionId: connection.id,
          connectionName: connection.name || connection.email || connection.id,
          lastError: connection.lastError || null,
        });
      }
    }

    return NextResponse.json({
      models,
      unavailableCount: models.length,
    });
  } catch (error) {
    console.error("[API] Failed to get model availability:", error);
    return NextResponse.json(
      { error: "Failed to fetch model availability" },
      { status: 500 },
    );
  }
}

export async function POST(request) {
  try {
    const { action, provider, model } = await request.json();

    if (action !== "clearCooldown" || !provider || !model) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const connections = await getProviderConnections({ provider });
    const lockKey = `${MODEL_LOCK_PREFIX}${model}`;

    await Promise.all(
      connections
        .filter((connection) => connection[lockKey] || connection[`retiredModel_${model}`])
        .map((connection) =>
          updateProviderConnection(connection.id, {
            [lockKey]: null,
            // Clearing a retirement must drop the strike count too, or the next
            // retirement of the same id resumes at the escalated horizon.
            [`retiredModel_${model}`]: null,
            [`retiredStrikes_${model}`]: null,
            ...(connection.testStatus === "unavailable"
              ? {
                  testStatus: "active",
                  lastError: null,
                  lastErrorAt: null,
                  backoffLevel: 0,
                }
              : {}),
          }),
        ),
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[API] Failed to clear model cooldown:", error);
    return NextResponse.json(
      { error: "Failed to clear cooldown" },
      { status: 500 },
    );
  }
}
