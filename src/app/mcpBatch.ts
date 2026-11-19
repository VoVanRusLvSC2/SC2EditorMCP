import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import type { BatchStep, BatchTool } from "./batchTypes.js";
import { BatchMediaCollector } from "./batchMedia.js";
import { resolveBatchReferences, hasBatchReference } from "./batchReferences.js";
import { compactResult } from "./toolResults.js";

// Keep the original import surface for existing SDK and internal consumers.
export type { BatchStep, BatchTool } from "./batchTypes.js";
export { BatchMediaCollector } from "./batchMedia.js";
export { resolveBatchReferences } from "./batchReferences.js";
export { compactResult } from "./toolResults.js";

// An uncertain native result must stop dependent edits and Save. Reuse the set
// across steps; this is recovery policy, not a list of ordinary tool errors.
const STOPPING_LIVE_STATUSES = new Set([
  "unknown",
  "stopped",
  "needs_parameters",
  "needs_validation",
  "partial",
  "save_unconfirmed",
  "save_confirmed_prepare_blocked",
  "prepare_failed",
  "compile_pending",
  "compile_stale",
  "compile_failed",
  "adopting",
  "adoption_unknown",
  "preparation_failed",
  "attention_required",
  "save_required",
  "recovery_required",
  "pending_native",
  "pending_open",
  "not_published",
  "context_changed",
  "conflict",
  "verification_failed",
]);

function jsonResult(result: unknown) {
  const structured = (result as { structuredContent?: unknown })?.structuredContent;
  if (structured !== undefined) return structured;
  const r = result as { content?: Array<{ type: string; text?: string }> };
  const text = r.content?.find((c) => c.type === "text")?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 1000) };
  }
}

/** Validate static arguments before invoking any step. Result-dependent arguments
 * are validated just before use; earlier committed steps are never rolled back. */
export async function runMcpBatch(
  steps: BatchStep[],
  tools: ReadonlyMap<string, BatchTool>,
  context: unknown,
  media?: BatchMediaCollector,
) {
  if (JSON.stringify(steps).length > 131072) throw new Error("MCP_BATCH_INPUT_BUDGET");
  const ids = new Set<string>();
  for (const s of steps) {
    if (ids.has(s.id) || !tools.has(s.tool) || s.tool === "modkit.batch")
      throw new Error("MCP_BATCH_PREFLIGHT: " + s.id + " " + s.tool);
    ids.add(s.id);
  }
  for (const s of steps) {
    // A refresh session handle is always a UUID. Validate every other static
    // field before the preceding begin can save the user's dirty document.
    const session = s.args.sessionId;
    const onlySessionReference =
      s.tool.startsWith("live.refresh.") &&
      session &&
      typeof session === "object" &&
      !Array.isArray(session) &&
      Object.keys(session).length === 1 &&
      typeof (session as Record<string, unknown>).$from === "string" &&
      !hasBatchReference(
        Object.fromEntries(Object.entries(s.args).filter(([k]) => k !== "sessionId")),
      );
    const staticArgs = onlySessionReference
      ? { ...s.args, sessionId: "00000000-0000-4000-8000-000000000000" }
      : s.args;
    if (!hasBatchReference(staticArgs)) {
      try {
        tools.get(s.tool)!.schema.parse(staticArgs);
      } catch (error) {
        return {
          ok: false,
          completed: 0,
          failed: s.id,
          steps: [
            {
              id: s.id,
              tool: s.tool,
              ok: false,
              preflight: true,
              error: error instanceof Error ? error.message : String(error),
            },
          ],
          scope: "No step was invoked; static arguments failed schema preflight.",
        };
      }
    }
  }
  const results = new Map<string, unknown>(),
    rows: Array<Record<string, unknown>> = [];
  for (const s of steps) {
    const start = performance.now();
    try {
      const tool = tools.get(s.tool)!,
        args = tool.schema.parse(resolveBatchReferences(s.args, results)),
        result = await tool.invoke(args, context),
        json = jsonResult(result);
      if (
        (result as { isError?: boolean })?.isError ||
        (json as { valid?: boolean; ok?: boolean })?.valid === false ||
        (json as { ok?: boolean })?.ok === false ||
        (json as { accepted?: boolean })?.accepted === false ||
        // Live providers can return a partial/unknown receipt without throwing.
        // Stop dependent steps; earlier native mutations cannot be rolled back
        // by treating this batch as an ordinary failed JSON request.
        (s.tool.startsWith("live.") &&
          STOPPING_LIVE_STATUSES.has(String((json as { status?: unknown })?.status)))
      ) {
        rows.push({
          id: s.id,
          tool: s.tool,
          ok: false,
          ms: Math.round(performance.now() - start),
          result: compactResult(json),
        });
        return {
          ok: false,
          completed: rows.length - 1,
          failed: s.id,
          steps: rows,
          scope: "Sequential tool calls; earlier committed changes are retained.",
        };
      }
      media?.collect(s, result);
      results.set(s.id, json);
      rows.push({
        id: s.id,
        tool: s.tool,
        ok: true,
        ms: Math.round(performance.now() - start),
        result: s.select
          ? Object.fromEntries(s.select.map((k) => [k, (json as Record<string, unknown>)?.[k]]))
          : compactResult(json),
      });
    } catch (e) {
      rows.push({
        id: s.id,
        tool: s.tool,
        ok: false,
        ms: Math.round(performance.now() - start),
        error: e instanceof Error ? e.message : String(e),
      });
      return {
        ok: false,
        completed: rows.length - 1,
        failed: s.id,
        steps: rows,
        scope: "Sequential tool calls; earlier committed changes are retained.",
      };
    }
  }
  return { ok: true, completed: rows.length, steps: rows };
}
export function registerMcpBatch(server: McpServer, tools: ReadonlyMap<string, BatchTool>) {
  server.registerTool(
    "modkit.batch",
    {
      description:
        'Run 1–20 existing SC2 MCP tools sequentially in one request. Exact original schemas/defaults/stale guards apply. Args can use {"$from":"stepId.planId"} from earlier JSON results. Stops on first failure; earlier saves remain committed. Returns compact summaries, not full XML/schemas. Use for plan→apply→save→validate→preview→export. No shell execution.',
      inputSchema: z
        .object({
          steps: z
            .array(
              z
                .object({
                  id: z
                    .string()
                    .regex(/^[A-Za-z_]\w*$/)
                    .max(32),
                  tool: z.string().min(1).max(128),
                  args: z.record(z.string(), z.unknown()).default({}),
                  select: z
                    .array(
                      z
                        .string()
                        .regex(/^[A-Za-z_]\w*$/)
                        .refine((k) => !["__proto__", "prototype", "constructor"].includes(k)),
                    )
                    .min(1)
                    .max(12)
                    .optional(),
                })
                .strict(),
            )
            .min(1)
            .max(20),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (a, context) => {
      const media = new BatchMediaCollector();
      const result = await runMcpBatch(a.steps, tools, context, media);
      return {
        isError: !result.ok,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ...result,
              ...(media.included || media.omitted ? { media: media.receipt() } : {}),
            }),
          },
          ...media.content,
        ],
      };
    },
  );
}
