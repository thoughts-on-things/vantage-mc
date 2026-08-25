#!/usr/bin/env python3
"""Fail when a client JAR adds an unclassified zero-element block model.

Usage: python scripts/audit-special-models.py path/to/client.jar [...]

This is a compatibility gate, not a visual-fidelity test. It detects blocks
whose selected JSON models cannot render ordinary cuboids and requires each
family to be explicitly classified as a Vantage special model or as geometry
handled elsewhere/intentionally absent.
"""

from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path
from typing import Any

WOODS = {
    "oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove",
    "cherry", "pale_oak", "bamboo", "crimson", "warped",
}
DYES = {
    "white", "orange", "magenta", "light_blue", "yellow", "lime", "pink",
    "gray", "light_gray", "cyan", "purple", "blue", "brown", "green", "red",
    "black",
}
HEADS = {"skeleton", "wither_skeleton", "zombie", "creeper", "piglin", "dragon", "player"}
COPPER_PREFIXES = {
    "", "exposed_", "weathered_", "oxidized_",
    "waxed_", "waxed_exposed_", "waxed_weathered_", "waxed_oxidized_",
}


class AuditFailure(Exception):
    """The JAR could not be classified with certainty."""

# These are rendered by Vantage's fluid path or intentionally have no reusable
# static block geometry. pitcher_crop is the one mixed family: its early upper
# halves are empty while later stages use normal JSON cuboids.
HANDLED_ELSEWHERE = {
    "air", "cave_air", "void_air", "water", "lava", "bubble_column",
    "barrier", "light", "structure_void", "moving_piston", "end_gateway",
    "end_portal", "nether_portal", "pitcher_crop",
}


def supported_special(name: str) -> bool:
    if name in {"chest", "trapped_chest", "ender_chest", "shulker_box", "decorated_pot", "conduit"}:
        return True
    for suffix in ("copper_chest", "copper_golem_statue"):
        if name.endswith(suffix) and name[:-len(suffix)] in COPPER_PREFIXES:
            return True
    if name.endswith("_bed") and name[:-4] in DYES:
        return True
    for suffix in ("_wall_hanging_sign", "_hanging_sign", "_wall_sign", "_sign"):
        if name.endswith(suffix) and name[:-len(suffix)] in WOODS:
            return True
    if name.endswith("_shulker_box") and name[:-12] in DYES:
        return True
    if name.endswith("_wall_banner") and name[:-12] in DYES:
        return True
    if name.endswith("_banner") and name[:-7] in DYES:
        return True
    for suffix in ("_wall_skull", "_skull", "_wall_head", "_head"):
        if name.endswith(suffix) and name[:-len(suffix)] in HEADS:
            return True
    return False


def audit(jar_path: Path) -> dict[str, Any]:
    with zipfile.ZipFile(jar_path) as jar:
        entries = set(jar.namelist())
        model_cache: dict[str, bool] = {}


        def load_json(path: str, kind: str) -> dict[str, Any]:
            try:
                raw = jar.read(path)
            except KeyError as exc:
                raise AuditFailure(f"missing {kind}: {path}") from exc
            try:
                value = json.loads(raw)
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                raise AuditFailure(f"invalid {kind} JSON: {path}: {exc}") from exc
            if not isinstance(value, dict):
                raise AuditFailure(f"{kind} is not an object: {path}")
            return value

        def has_elements(model_ref: str, seen: tuple[str, ...] = ()) -> bool:
            if ":" in model_ref and not model_ref.startswith("minecraft:"):
                raise AuditFailure(f"unsupported model namespace: {model_ref}")
            model = model_ref.removeprefix("minecraft:")
            if model in model_cache:
                return model_cache[model]
            if model in seen:
                raise AuditFailure(f"model parent loop: {' -> '.join(seen + (model,))}")
            path = f"assets/minecraft/models/{model}.json"
            data = load_json(path, "model")
            if "elements" in data:
                if not isinstance(data["elements"], list):
                    raise AuditFailure(f"model elements is not an array: {path}")
                for index, element in enumerate(data["elements"]):
                    if not isinstance(element, dict):
                        raise AuditFailure(f"model element {index} is not an object: {path}")
                    for endpoint in ("from", "to"):
                        vector = element.get(endpoint)
                        if not (
                            isinstance(vector, list)
                            and len(vector) == 3
                            and all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in vector)
                        ):
                            raise AuditFailure(f"model element {index} has invalid {endpoint}: {path}")
                result = bool(data["elements"])
            elif "parent" in data:
                if not isinstance(data["parent"], str):
                    raise AuditFailure(f"model parent is not a string: {path}")
                result = has_elements(data["parent"], seen + (model,))
            else:
                result = False
            model_cache[model] = result
            return result

        all_zero: list[str] = []
        mixed_zero: list[str] = []
        zero_models: dict[str, list[str]] = {}
        prefix = "assets/minecraft/blockstates/"
        blockstate_paths = sorted(p for p in entries if p.startswith(prefix) and p.endswith(".json"))
        if not blockstate_paths:
            raise AuditFailure("JAR contains no minecraft blockstates")
        for path in blockstate_paths:
            state = load_json(path, "blockstate")
            refs: list[str] = []

            def collect_apply(value: Any, where: str) -> None:
                choices = value if isinstance(value, list) else [value]
                if not choices:
                    raise AuditFailure(f"empty model choice list at {where}: {path}")
                for choice in choices:
                    if not isinstance(choice, dict):
                        raise AuditFailure(f"model choice is not an object at {where}: {path}")
                    unknown = set(choice) - {"model", "x", "y", "uvlock", "weight"}
                    if unknown:
                        raise AuditFailure(f"unknown model choice keys at {where}: {sorted(unknown)}: {path}")
                    model_ref = choice.get("model")
                    if not isinstance(model_ref, str):
                        raise AuditFailure(f"model choice lacks string model at {where}: {path}")
                    refs.append(model_ref)

            if set(state) == {"variants"}:
                variants = state["variants"]
                if not isinstance(variants, dict) or not variants:
                    raise AuditFailure(f"variants is not a non-empty object: {path}")
                for key, apply in variants.items():
                    collect_apply(apply, f"variant {key!r}")
            elif set(state) == {"multipart"}:
                multipart = state["multipart"]
                if not isinstance(multipart, list) or not multipart:
                    raise AuditFailure(f"multipart is not a non-empty array: {path}")
                for index, part in enumerate(multipart):
                    if not isinstance(part, dict):
                        raise AuditFailure(f"multipart entry {index} is not an object: {path}")
                    unknown = set(part) - {"when", "apply"}
                    if unknown or "apply" not in part:
                        raise AuditFailure(f"invalid multipart entry {index}: {path}")
                    if "when" in part and not isinstance(part["when"], dict):
                        raise AuditFailure(f"multipart when {index} is not an object: {path}")
                    collect_apply(part["apply"], f"multipart {index}")
            else:
                raise AuditFailure(f"unrecognized blockstate schema: {path}")
            if not refs:
                raise AuditFailure(f"blockstate has no model references: {path}")
            empty = sorted({ref for ref in refs if not has_elements(ref)})
            if not empty:
                continue
            name = path.rsplit("/", 1)[-1][:-5]
            zero_models[name] = empty
            if len(empty) == len(set(refs)):
                all_zero.append(name)
            else:
                mixed_zero.append(name)

        zero_names = sorted(zero_models)
        supported = sorted(name for name in zero_names if supported_special(name))
        handled = sorted(name for name in zero_names if name in HANDLED_ELSEWHERE)
        unsupported = sorted(name for name in zero_names if name not in supported and name not in handled)
        return {
            "jar": str(jar_path),
            "all_zero": all_zero,
            "mixed_zero": mixed_zero,
            "supported": supported,
            "handled_elsewhere": handled,
            "unsupported": unsupported,
        }


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: audit-special-models.py <client.jar> [...]", file=sys.stderr)
        return 2
    failed = False
    for raw_path in argv:
        path = Path(raw_path)
        try:
            result = audit(path)
        except (OSError, zipfile.BadZipFile, AuditFailure) as exc:
            print(f"{path}: audit failed: {exc}", file=sys.stderr)
            failed = True
            continue
        print(
            f"{path.name}: all-zero={len(result['all_zero'])} "
            f"mixed-zero={len(result['mixed_zero'])} "
            f"supported={len(result['supported'])} "
            f"handled={len(result['handled_elsewhere'])} "
            f"unsupported={len(result['unsupported'])}"
        )
        if result["mixed_zero"]:
            print("  mixed-zero:", ", ".join(result["mixed_zero"]))
        if result["unsupported"]:
            print("  UNSUPPORTED:", ", ".join(result["unsupported"]))
            failed = True

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
