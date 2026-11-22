import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ProjectTestWorkspace } from "../testing/workspace.js";
import { worldSpec } from "./plan.js";
import type { WorldWorkspace } from "./workspace.js";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
async function response(task: Promise<unknown>) {
  try {
    return { content: [{ type: "text" as const, text: JSON.stringify(await task) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text" as const, text: String(error) }] };
  }
}
export function registerWorldTools(
  server: McpServer,
  world: WorldWorkspace,
  tests: () => ProjectTestWorkspace,
) {
  server.registerTool(
    "world.plan",
    {
      description:
        "Resolve palettes and plan a seeded mission, ladder or arcade world with spatial zones and reserved connections. Anchors are normalized west to east and south to north.",
      inputSchema: z.object({ spec: worldSpec }).strict(),
    },
    (a) => response(world.plan(a.spec)),
  );
  server.registerTool(
    "world.build",
    {
      description:
        "Build a packed candidate from the exact resolved world plan. Returns archive path, revision, actual painted textures and placed decor.",
      inputSchema: z.object({ planId: hash }).strict(),
    },
    (a) => response(world.build(a.planId)),
  );
  server.registerTool(
    "world.verify",
    {
      description:
        "Check the archive hash. Optionally plan or run original Editor and ground-route tests on that revision. Poll project.test.status/report for native results.",
      inputSchema: z
        .object({
          planId: hash,
          revision: hash,
          editor: z.boolean().default(false),
          game: z.boolean().default(false),
          run: z.boolean().default(false),
        })
        .strict(),
    },
    (a) =>
      response(
        (async () => {
          const receipt = await world.verify(a.planId, a.revision);
          if (!a.editor && !a.game) return receipt;
          const layout = await world.layout(a.planId);
          if (a.game && layout.routes.length > 16)
            throw Error("WORLD_TEST_ROUTE_LIMIT: use project.test.plan to select up to 16 routes");
          const suite = await tests().plan({
            version: 1,
            map: receipt.archive,
            label: "World " + receipt.mode,
            ...(a.editor ? { editor: { checks: ["load", "compile", "save_reopen"] } } : {}),
            ...(a.game
              ? {
                  game: {
                    points: Object.fromEntries(layout.zones.map((z) => [z.id, z.center])),
                    routes: layout.routes.map((r, i) => ({
                      id: "route" + i,
                      from: r.from,
                      to: r.to,
                      mobility: "ground",
                      type: "Marine",
                      owner: 1,
                      timeout: 60,
                    })),
                    views: layout.zones
                      .slice(0, 8)
                      .map((z, i) => ({
                        id: "zone" + i,
                        camera: { ...z.center, pitch: 55, yaw: 0, distance: 28 },
                      })),
                  },
                }
              : {}),
          });
          if (suite.sourceSha256 !== a.revision) throw Error("WORLD_REVISION_CHANGED");
          const job = a.run && suite.ready ? await tests().run(suite.planId) : undefined;
          return { receipt, suite, job };
        })(),
      ),
  );
}
