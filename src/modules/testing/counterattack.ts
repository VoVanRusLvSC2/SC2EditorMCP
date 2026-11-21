import * as z from "zod/v4";
import { gameBody } from "../../integrations/game/actionEvents.js";
import type { GameResult } from "../../integrations/game/transport.js";
import type { TestCheck } from "./schemas.js";

const point = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const unitType = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/);
export const counterattackSchema = z
  .object({
    attacker: unitType,
    guard: unitType,
    wave: unitType,
    count: z.number().int().min(1).max(12),
    delay: z.number().min(1).max(90),
    hold: z.number().min(4).max(180),
    goal: point,
    spawn: point,
    approach: point,
  })
  .strict();
type Counterattack = z.infer<typeof counterattackSchema>;
type Point = z.infer<typeof point>;
type Event = { unit: string; time: number; position?: Point };
interface Harness {
  call: (method: string, args: Record<string, unknown>) => Promise<GameResult>;
  record: (name: string, evidence: unknown) => Promise<string>;
  checkCancel: () => void;
  pollMs?: number;
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const area = (p: Point, r: number) => ({
  xmin: p.x - r,
  ymin: p.y - r,
  xmax: p.x + r,
  ymax: p.y + r,
});
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** An owned attacker triggers the real capture condition. Event pages prove the
 * cohort and retained history. Position readback independently proves arrival. */
export async function runCounterattack(spec: Counterattack, h: Harness): Promise<TestCheck[]> {
  const checks: TestCheck[] = [];
  const report = (
    id: string,
    status: TestCheck["status"],
    reason?: string,
    evidence?: Record<string, unknown>,
  ) => {
    checks.push({ id: "counterattack:" + id, status, required: true, reason, evidence });
  };
  let calls = 0;
  async function call(method: string, args: Record<string, unknown> = {}) {
    h.checkCancel();
    const result = await h.call(method, args);
    const file = await h.record(
      String(++calls).padStart(3, "0") + "_" + method.replaceAll(".", "_"),
      result,
    );
    const body = gameBody(result);
    if (result.isError || body.status !== "ok")
      throw Error(method + " did not return an accepted response. See " + file);
    return body;
  }
  const waves = new Map<string, Event>();
  let guard: string | undefined;
  let destroyed: Event | undefined;
  let cursor: string | undefined;
  let stream: string | undefined;
  let pages = 0;
  let reached: Point | undefined;
  let reachedUnit: string | undefined;
  let createdFixture = false;
  async function readPage() {
    if (++pages > 256) throw Error("Counterattack observation exceeded its event page budget");
    const page = await call("game.events", cursor ? { cursor } : {});
    if (
      typeof page.session !== "string" ||
      typeof page.runtimeEpoch !== "string" ||
      !Number.isSafeInteger(page.mapLoadSerial) ||
      !Array.isArray(page.events) ||
      typeof page.cursor !== "string" ||
      !page.cursor ||
      typeof page.hasMore !== "boolean" ||
      page.dropped !== false ||
      !Number.isFinite(page.gameTime) ||
      (page.hasMore && cursor === page.cursor)
    )
      throw Error("Counterattack observation could not confirm complete event history");
    const identity = JSON.stringify([page.session, page.runtimeEpoch, page.mapLoadSerial]);
    if (stream && identity !== stream)
      throw Error("The game changed sessions during counterattack observation");
    stream = identity;
    cursor = page.cursor;
    for (const item of page.events) {
      if (
        item?.source !== "galaxy" ||
        typeof item.unit !== "string" ||
        !Number.isFinite(item.gameTime)
      )
        continue;
      if (item.kind === "unit_died" && guard && item.unit === guard)
        destroyed ??= { unit: item.unit, time: item.gameTime };
      if (
        item.kind === "unit_created" &&
        item.unitMetadataCurrent &&
        item.owner === 15 &&
        item.unitType === spec.wave &&
        item.position &&
        distance(item.position, spec.spawn) <= 4
      )
        waves.set(item.unit, { unit: item.unit, time: item.gameTime, position: item.position });
    }
    return page;
  }
  const drain = async () => {
    let page = await readPage();
    while (page.hasMore) page = await readPage();
    return page;
  };

  try {
    const guards = await call("game.units.find", {
      owner: 15,
      type: spec.guard,
      area: area(spec.goal, 3),
      limit: 8,
    });
    if (
      guards.units?.length !== 1 ||
      !guards.units[0].alive ||
      typeof guards.units[0].id !== "string"
    ) {
      report("setup", "inconclusive", "The authored capture guard could not be uniquely bound");
      return checks;
    }
    guard = guards.units[0].id;
    await drain();
    const baseline = await call("game.units.find", {
      owner: 15,
      type: spec.wave,
      area: area(spec.spawn, 4),
      limit: 16,
    });
    if (!Array.isArray(baseline.units))
      throw Error("The runtime did not return a population at the spawn site");
    report("before_capture", waves.size || baseline.units.length ? "failed" : "passed", undefined, {
      matchingCreations: waves.size,
      initialUnits: baseline.units.length,
    });
    if (checks.at(-1)!.status !== "passed") return checks;

    const attacker = await call("game.fixture", {
      action: "create",
      type: spec.attacker,
      owner: 1,
      ...spec.approach,
    });
    createdFixture = true;
    if (typeof attacker.unit?.id !== "string")
      throw Error("The private attacker fixture was not identified");
    const order = await call("game.order", {
      unit: attacker.unit.id,
      action: "attack",
      target_unit: guard,
    });
    if (order.accepted !== true) throw Error("The attack order was not accepted");
    const deathDeadline = Date.now() + 24000;
    while (!destroyed && Date.now() < deathDeadline) {
      await drain();
      if (!destroyed) await delay(h.pollMs ?? 120);
    }
    if (!destroyed) {
      report(
        "capture",
        "inconclusive",
        "The exact guard death was not observed during the combat probe",
      );
      return checks;
    }
    report("capture", "passed", undefined, { death: destroyed });
    // Clear the probe unit so a successful shot cannot stop the approaching wave.
    await call("game.fixture", { action: "cleanup" });
    createdFixture = false;

    const windowEnd = destroyed.time + spec.delay + Math.min(spec.hold - 0.8, 6);
    const waveDeadline = Date.now() + Math.min(150, 20 + (spec.delay + 6) * 3) * 1000;
    let complete = false;
    let observedThrough = destroyed.time;
    while (Date.now() < waveDeadline) {
      const page = await drain();
      observedThrough = page.gameTime;
      if (!reached && waves.size) {
        const arrivals = await call("game.units.find", {
          owner: 15,
          type: spec.wave,
          area: area(spec.goal, 5),
          limit: 16,
        });
        const member = arrivals.units?.find((unit: { id: string; position: Point }) => {
          const initial = waves.get(unit.id)?.position;
          return (
            initial &&
            unit.position &&
            distance(unit.position, initial) >= 1 &&
            distance(unit.position, spec.goal) <= 5
          );
        });
        if (member) {
          reached = member.position;
          reachedUnit = member.id;
        }
      }
      if (observedThrough >= windowEnd) {
        complete = true;
        break;
      }
      await delay(h.pollMs ?? 120);
    }
    const events = [...waves.values()];
    const timing = events.every(({ time }) => Math.abs(time - destroyed!.time - spec.delay) <= 0.5);
    report(
      "spawn",
      !complete ? "inconclusive" : events.length === spec.count && timing ? "passed" : "failed",
      complete ? undefined : "The bounded post-spawn interval could not be observed",
      {
        expectedCount: spec.count,
        expectedDelay: spec.delay,
        observedThrough,
        windowEnd,
        windowComplete: complete,
        events,
      },
    );
    report(
      "arrival",
      reached ? "passed" : "inconclusive",
      reached ? undefined : "No live member of the created cohort was observed at the objective",
      { goal: spec.goal, radius: 5, position: reached, unit: reachedUnit },
    );
  } catch (error) {
    if (error instanceof Error && error.message === "TEST_CANCEL_REQUESTED") throw error;
    report("observation", "inconclusive", String(error).slice(0, 700));
  } finally {
    if (createdFixture) {
      try {
        await h.record("fixture_cleanup", await h.call("game.fixture", { action: "cleanup" }));
      } catch {
        /* Owned session disposal also removes its fixture. */
      }
    }
  }
  return checks;
}
