import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  defineMissionPack,
  type MissionPlugin,
  type MissionPluginContext,
} from "../../mission-sdk.js";

export async function loadMissionPlugin(id: string, context: MissionPluginContext) {
  const configured = JSON.parse(process.env.SC2_MISSION_PLUGINS ?? "{}") as Record<string, unknown>;
  const file = Object.hasOwn(configured, id) ? configured[id] : undefined;
  if (typeof file !== "string" || !path.isAbsolute(file))
    throw Error("WORLD_PLUGIN_NOT_CONFIGURED: " + id);
  const plugin: MissionPlugin = (await import(pathToFileURL(file).href)).default;
  if (plugin?.apiVersion !== 1 || plugin.id !== id || typeof plugin.createPack !== "function")
    throw Error("WORLD_PLUGIN_CONTRACT_MISMATCH: " + id);
  const pack = defineMissionPack(await plugin.createPack(structuredClone(context)));
  if (pack.id !== id) throw Error("WORLD_PLUGIN_PACK_ID_MISMATCH: " + id);
  return pack;
}
