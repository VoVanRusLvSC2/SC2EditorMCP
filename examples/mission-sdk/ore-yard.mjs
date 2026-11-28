import { defineMissionPlugin } from "sc2editor-mcp/mission-sdk";

export default defineMissionPlugin({
  apiVersion: 1,
  id: "OreYard",
  createPack({ width }) {
    const approachWidth = width >= 96 ? 10 : 7;
    return {
      apiVersion: 1, id: "OreYard", facings: [],
      mechanics: [
        { id: "Power", seconds: 1, radius: 4, approachWidth: 3, landform: "overlook" },
        { id: "Load", seconds: 4, radius: 4, approachWidth, landform: "levelPad", onComplete: [{
          kind: "Action", function: "UIDisplayMessage", args: {
            players: { kind: "call", function: "PlayerGroupSingle", args: { p: { kind: "literal", type: "int", value: 1 } } },
            messageArea: { kind: "preset", name: "Chat" }, message: { kind: "text", value: "Cargo loaded." },
          },
        }] },
        { id: "Leave", seconds: 1, radius: 4, approachWidth },
      ],
    };
  },
});
