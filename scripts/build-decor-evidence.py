"""Derive decor statistics and placement roles from the bundled source catalog."""

import gzip
import json
import re
import sys
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1] / "resources" / "authoring-catalog"
OUTPUT = ROOT / "decor-evidence.json.gz"

EXACT_ROLES = {
    "Decal": "marking",
    "AgriaCrops": "ground_detail",
    "UmojanLabRoom": "structure",
    "UmojanLabZergChamberLarge": "structure",
    "UmojanLabWallCap": "wall",
    "UmojanLabCliffWallsTall": "wall",
    "LandingLights": "light",
    "SpaceDockEquipment": "utility",
    "CompoundSewers_Fan": "utility",
    "CompoundSewers_Tank": "utility",
    "UmojanLabHoloProjector": "fixture",
}

NAME_ROLES = [
    ("technical", r"invisible|blocker|dummy|editoronly|pathing|unbuildable|unwalkable"),
    ("damage", r"wreck|debris|corpse|destroyed|crashsite|crashing|wallbroken|catwalkbroken|^ruin|^rubble|ruined|_damaged"),
    ("marking", r"decal|groundmark|floorstripe|^tarsonisarrow"),
    ("light", r"lightomni|floodlight|landinglight|lightboard|alarm|streetlight|walllight"),
    ("effect", r"electric(al)?arc|^smoke|^wind|^fire|^fog|^fx_|tracershot|^particle|fallingrock|acidburst|lavasplash"),
    ("cargo", r"crate(?!r)|barrel|pallet|(^|_)supplies|militarysupplies"),
    ("connection", r"door|gate|catwalk|bridge|stair|^spaceelevatorramp|tramrail"),
    ("wall", r"wallpanel|glasswall|wallcap|fence|barricade|barrier|wallpillar|cliffgapfiller"),
    ("fixture", r"console|monitor|dissection|testtube|stasis|specimen|labtable|celltable|holoprojector|zergcage|hybridcapsule|roboarm"),
    ("utility", r"powerline|conduit|generator|vent(ilation)?(small|large|_|$)|sewers|pipe|waterTank"),
    ("cliff", r"cliff|escarp"),
    ("shore", r"waterfall|icefloe|geyser|lavaflow|lavalake|riverweed"),
    ("canopy", r"canopy|(?<!street)tree(?!base|bark|log|stump|root)"),
    ("understory", r"shrub|bush|fern|vine|underbrush|sapling"),
    ("rock", r"rock|boulder|stalagmit|stalactit|basalt"),
    ("ground_detail", r"foliage|moss|plant|reed|flower|grass|fungus|mushroom|root"),
    ("structure", r"temple|bldg|building|bunker|silo|labpillar|dockingbay|tower|archway|roof|chamber"),
    ("yard_prop", r"vehicle|street|antenna|bench|metalplate|trashbin"),
]

TAG_ROLES = {
    "technical/blockers": "technical",
    "effects/atmosphere": "effect",
    "nature/trees": "canopy",
    "nature/ground_plants": "ground_detail",
    "nature/rocks": "rock",
    "nature/water_ice": "shore",
    "buildings/ruins": "damage",
    "buildings/structures": "structure",
    "architecture/temples": "structure",
    "infrastructure/fences_gates": "wall",
    "infrastructure/roads_bridges": "connection",
    "infrastructure/pipes_power": "utility",
    "infrastructure/lights": "light",
    "props/storage": "cargo",
    "props/vehicles": "yard_prop",
    "props/agriculture": "ground_detail",
}

DESCRIPTION_ROLES = {
    "cliff": "cliff",
    "decal": "marking",
    "effect": "effect",
    "foliage": "understory",
    "structure": "structure",
}
NATURAL_ROLES = {"canopy", "understory", "ground_detail", "rock", "cliff", "shore"}


def read(name):
    path = ROOT / name
    if path.suffix == ".gz":
        with gzip.open(path, "rt", encoding="utf-8") as file:
            return json.load(file)
    return json.loads(path.read_text(encoding="utf-8"))


def actor_profile(identifier, catalog, description, rules, override):
    tags = catalog.get("roles", [])
    state = catalog.get("states", [])
    role = override[0] if override else EXACT_ROLES.get(identifier)
    evidence = "curated"
    if role is None:
        role = next((role for role, rule in NAME_ROLES if re.search(rule, identifier, re.I)), None)
        evidence = "name"
    if role is None:
        role = next((TAG_ROLES[tag] for tag in tags if tag in TAG_ROLES), None)
        evidence = "catalog_role"
    if role is None:
        role = DESCRIPTION_ROLES.get(description.get("role", ""))
        evidence = "description"
    if role is None:
        role, evidence = "review", "unclassified"
    if role not in rules:
        raise ValueError(f"Missing placement rule for {identifier}: {role}")
    kind = description.get("kind", "natural" if role in NATURAL_ROLES else "built")
    if role in {"wall", "connection", "fixture", "cargo", "utility", "light", "marking"}:
        kind = "built"
    if override:
        kind = override[1]
    entry = {"role": role, "kind": kind, "evidence": evidence}
    if state:
        entry["states"] = state
    if catalog.get("explicit_tilesets"):
        entry["tilesets"] = catalog["explicit_tilesets"]
    if description.get("biome"):
        entry["biomes"] = description["biome"]
    if catalog.get("factions"):
        entry["factions"] = catalog["factions"]
    if description.get("size"):
        entry["size"] = description["size"]
    if identifier not in EXACT_ROLES and role in {"cliff", "wall", "connection", "structure"} and "ruined" in state:
        entry["states"] = sorted(set(state + ["damaged"]))
    return entry


def build():
    styles = read("world-mission-styles.json")["tilesets"]
    composition = read("style_rules/decor_composition.json")
    rules = composition["rules"]
    overrides = composition["actorOverrides"]
    definitions = {entry["id"]: entry for entry in read("indexes/doodads.json.gz")}
    descriptions = read("team-antioch/doodad-descriptions.json")
    ids = set(definitions) | set(descriptions)
    actors = {
        key: actor_profile(key, definitions.get(key, {}), descriptions.get(key, {}), rules, overrides.get(key))
        for key in sorted(ids)
    }
    missions = {}
    for entry in read("indexes/maps.json.gz"):
        data = read(entry["file"])
        counts = {item["id"]: item["count"] for item in data.get("doodads", [])}
        if counts.keys() - ids:
            raise ValueError(f"Unclassified placed Actor IDs in {entry['id']}: {counts.keys() - ids}")
        role_counts = Counter(actors[key]["role"] for key in counts)
        role_instances = Counter()
        for key, count in counts.items():
            role_instances[actors[key]["role"]] += count
        tileset = entry["tileset"]
        missions[entry["id"]] = {
            "name": entry["name"]["text"],
            "campaign": entry["campaign"],
            "mapRole": entry["role"],
            "tileset": tileset,
            "profile": styles.get(tileset, {}).get("profile"),
            "source": data.get("source") or entry["source"],
            "status": "measured" if counts else "missing_objects",
            "instances": sum(counts.values()),
            "types": len(counts),
            "roles": {
                role: {"types": types, "instances": role_instances[role]}
                for role, types in role_counts.items()
            },
            "actors": counts,
        }
    for entry in read("coverage/maps_without_objects.json"):
        identifier = Path(entry["map"]).stem
        missions.setdefault(identifier, {"source": entry["map"], "status": "missing_objects"})
    return {
        "version": 1,
        "sourceCommit": read("manifest.json")["commit"],
        "actors": actors,
        "missions": missions,
    }


if __name__ == "__main__":
    raw = (json.dumps(build(), ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
    if sys.argv[1:] == ["--check"]:
        if gzip.decompress(OUTPUT.read_bytes()) != raw:
            raise SystemExit("Decor evidence is stale. Run python scripts/build-decor-evidence.py.")
    elif not sys.argv[1:]:
        OUTPUT.write_bytes(gzip.compress(raw, compresslevel=9, mtime=0))
    else:
        raise SystemExit("Usage: python scripts/build-decor-evidence.py [--check]")
