import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { EditorWindow } from "./desktop.js";
import { AsyncLocalStorage } from "node:async_hooks";

interface SequenceLease {
  key: string;
  active: boolean;
  borrowed: boolean;
}
const sequences = new AsyncLocalStorage<SequenceLease>();
const processKey = (window: EditorWindow) => `${window.processId}-${window.processStart}`;

/** All visible native authoring clients serialize by process creation identity. */
export async function withEditorLease<T>(window: EditorWindow, work: () => Promise<T>) {
  const sequence = sequences.getStore();
  if (sequence?.active && sequence.key === processKey(window)) {
    if (sequence.borrowed) throw Error("LIVE_EDITOR_SEQUENCE_OVERLAP");
    sequence.borrowed = true;
    try {
      return await work();
    } finally {
      sequence.borrowed = false;
    }
  }
  const directory = path.join(os.tmpdir(), "SC2EditorToolkit-live-memory");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${window.processId}-${window.processStart}.lock`);
  const owner = randomUUID();
  const handle = await fs.open(file, "wx").catch(() => {
    throw Error("LIVE_MEMORY_EDITOR_LEASE_BUSY: " + file);
  });
  try {
    await handle.writeFile(owner);
    const building = await fs.lstat(path.join(directory, "build.lock")).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (building) throw Error("LIVE_RUNTIME_BUILD_BUSY");
    return await work();
  } finally {
    await handle.close();
    if ((await fs.readFile(file, "utf8").catch(() => "")) === owner)
      await fs.unlink(file).catch(() => {});
  }
}

/** Explicitly lend one process lease to serial existing providers in a logical edit. */
export async function withEditorSequenceLease<T>(window: EditorWindow, work: () => Promise<T>) {
  if (sequences.getStore()?.active) throw Error("LIVE_EDITOR_SEQUENCE_NESTED");
  return withEditorLease(window, async () => {
    const sequence: SequenceLease = { key: processKey(window), active: true, borrowed: false };
    try {
      return await sequences.run(sequence, work);
    } finally {
      sequence.active = false;
    }
  });
}
