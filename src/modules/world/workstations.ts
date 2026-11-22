import * as z from "zod/v4";

const placement = z
  .object({
    side: z.enum(["south", "east", "north", "west"]),
    offset: z.number().min(-24).max(24).default(0),
    setback: z.number().min(-1).max(6).default(0),
    flip: z.literal(true).optional(),
  })
  .strict();

export const workstation = placement.extend({
  kind: z.enum(["control", "experiment", "containment", "service"]),
});

export const roomComposition = z
  .object({
    focus: placement.extend({ kind: z.enum(["research", "observation", "briefing"]) }),
    support: z
      .array(placement.extend({ kind: z.enum(["bench", "wallConsole", "service"]) }))
      .max(3)
      .default([]),
  })
  .strict();

type Room = { id: string; width: number; height: number; shape: string };
type Position = z.output<typeof placement>;
type Module = {
  actor: string;
  along: number;
  inset: number;
  scale?: number;
  flush?: true;
};

const roles = {
  control: [
    { actor: "UmojanLabWallConsoles", along: 0, inset: 2.7 },
    { actor: "UmojanLabMonitorFloor", along: 2.6, inset: 5.4 },
    { actor: "UmojanLabConsoleSmall", along: -2.8, inset: 5.2 },
    { actor: "SpaceDockPowerLines", along: -3.2, inset: 2.2 },
  ],
  experiment: [
    { actor: "UmojanLabDissectionTable", along: 0, inset: 5 },
    { actor: "UmojanLabDissectionArm", along: -3.2, inset: 4.7 },
    { actor: "UmojanLabConsoleSmall", along: 3.1, inset: 2.6 },
    { actor: "UmojanLabCellTable", along: 1.45, inset: 8 },
  ],
  containment: [
    { actor: "UmojanLabTestTube", along: 0, inset: 5 },
    { actor: "UmojanLabConsoleSmall", along: 2.7, inset: 5 },
    { actor: "GenericSpacePipes", along: -3, inset: 4.3 },
    { actor: "SpaceDockPowerLines", along: -2, inset: 6.8 },
  ],
  service: [
    { actor: "GenericSpacePipes", along: -2.3, inset: 2.6 },
    { actor: "GenericSpacePipes", along: 0, inset: 2.6 },
    { actor: "GenericSpacePipes", along: 2.3, inset: 2.6 },
    { actor: "CompoundSewers_Fan", along: 4.55, inset: 3.1 },
    { actor: "UmojanLabConsoleSmall", along: -4.5, inset: 4.4 },
  ],
} as const;

const focalGroups = {
  research: [
    { actor: "UmojanLabDissectionTable", along: 0, inset: 5.8, scale: 1.16 },
    { actor: "UmojanLabWallConsoles", along: 0, inset: 2.3 },
    { actor: "UmojanLabDissectionArm", along: -3.8, inset: 5.8 },
    { actor: "UmojanLabCellTable", along: 4.25, inset: 5.8 },
  ],
  observation: [
    { actor: "UmojanLabTestTube", along: 0, inset: 4.8, scale: 1.5 },
    { actor: "UmojanLabMonitorFloor", along: -6.2, inset: 5.3 },
    { actor: "UmojanLabMonitorFloor", along: 6.2, inset: 5.3 },
    { actor: "SpaceDockPowerLines", along: -3.6, inset: 5.9 },
    { actor: "SpaceDockPowerLines", along: 3.6, inset: 5.9 },
  ],
  briefing: [
    { actor: "UmojanLabHoloProjector", along: 0, inset: 8, scale: 1.3 },
    { actor: "UmojanLabWallConsoles", along: -4.5, inset: 1.75, flush: true },
    { actor: "UmojanLabWallConsoles", along: 4.5, inset: 1.75, flush: true },
    { actor: "UmojanLabMonitorFloor", along: 0, inset: 2.05, flush: true },
  ],
} as const;

const supportGroups = {
  bench: [
    { actor: "UmojanLabDissectionTable", along: -5.4, inset: 6 },
    { actor: "UmojanLabDissectionTable", along: 5.4, inset: 6 },
    { actor: "UmojanLabWallConsoles", along: 0, inset: 2.5 },
    { actor: "UmojanLabDissectionArm", along: 0, inset: 6 },
  ],
  wallConsole: [
    { actor: "UmojanLabWallConsoles", along: 0, inset: 1.75, flush: true },
    { actor: "SpaceDockPowerLines", along: 1.8, inset: 5 },
  ],
  service: roles.service,
} as const;

export function workstationFixtures(space: Room, intent: z.output<typeof workstation>) {
  return groupFixtures(space, intent, intent.kind, roles[intent.kind]);
}

export function roomCompositionFixtures(space: Room, intent: z.output<typeof roomComposition>) {
  return [
    ...groupFixtures(space, intent.focus, intent.focus.kind, focalGroups[intent.focus.kind]),
    ...intent.support.flatMap((group) =>
      groupFixtures(space, group, group.kind, supportGroups[group.kind]),
    ),
  ];
}

const wallConsoleFacing = { north: 0, east: 270, south: 180, west: 90 } as const;

function groupFixtures(space: Room, position: Position, kind: string, modules: readonly Module[]) {
  const across = position.side === "north" || position.side === "south";
  const span = (across ? space.width : space.height) / 2;
  const depth = across ? space.height : space.width;
  const direction = position.flip ? -1 : 1;
  return modules.map(({ actor, along, inset: baseInset, scale, flush }) => {
    const offset = position.offset + along * direction;
    const inset = baseInset + (flush ? 0 : position.setback);
    if (space.shape !== "rectangle" || Math.abs(offset) >= span || inset < 1 || inset >= depth)
      throw Error("WORLD_WORKSTATION_CLEARANCE: " + space.id + "/" + kind);
    const rotation =
      actor === "GenericSpacePipes"
        ? across
          ? 0
          : 90
        : actor === "UmojanLabWallConsoles"
          ? wallConsoleFacing[position.side]
          : undefined;
    return {
      actor,
      side: position.side,
      offset,
      inset,
      count: 1,
      spacing: 1,
      ...(scale === undefined ? {} : { scale }),
      ...(rotation === undefined ? {} : { rotation }),
    };
  });
}
