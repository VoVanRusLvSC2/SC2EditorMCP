import type { PhysicalAssetEntry } from "./types.js";

interface AssetBucket {
  value: PhysicalAssetEntry;
  provenance?: {
    references: Set<string>;
    evidence: Set<PhysicalAssetEntry["evidence"][number]>;
  };
}

function appendReferences(
  target: PhysicalAssetEntry["referencedBy"],
  incoming: PhysicalAssetEntry["referencedBy"],
  seen: Set<string>,
): void {
  for (const reference of incoming) {
    const encoded = JSON.stringify(reference);
    if (seen.has(encoded)) continue;
    seen.add(encoded);
    // Copy merged provenance so frozen/shared source entries remain untouched.
    target.push(JSON.parse(encoded));
  }
}

/** Merge physical assets in source order, retaining the first source's metadata.
 * Each reference is visited once; shared assets can have thousands of consumers.
 */
export function mergeAssetEntries(entries: Iterable<PhysicalAssetEntry>): PhysicalAssetEntry[] {
  const assets = new Map<string, AssetBucket>();
  for (const asset of entries) {
    const key = `${asset.sourceLayer}:${asset.dependency}:${asset.path}`.toLowerCase();
    const bucket = assets.get(key);
    if (!bucket) {
      assets.set(key, { value: asset });
      continue;
    }

    if (!bucket.provenance) {
      // Allocate deduplication state only on collision. A lone entry retains its
      // original identity and duplicate provenance, matching the public contract.
      const first = bucket.value;
      bucket.provenance = { references: new Set(), evidence: new Set(first.evidence) };
      bucket.value = { ...first, referencedBy: [], evidence: [...bucket.provenance.evidence] };
      appendReferences(bucket.value.referencedBy, first.referencedBy, bucket.provenance.references);
    }

    const { references, evidence } = bucket.provenance;
    appendReferences(bucket.value.referencedBy, asset.referencedBy, references);
    for (const observation of asset.evidence) {
      if (evidence.has(observation)) continue;
      evidence.add(observation);
      bucket.value.evidence.push(observation);
    }
  }
  return [...assets.values()]
    .map(({ value }) => value)
    .sort((a, b) => a.path.localeCompare(b.path));
}
