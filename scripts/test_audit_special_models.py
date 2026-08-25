#!/usr/bin/env python3
"""Synthetic fail-closed tests for audit-special-models.py."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

AUDIT = Path(__file__).with_name("audit-special-models.py")
COPPER_PREFIXES = (
    "", "exposed_", "weathered_", "oxidized_",
    "waxed_", "waxed_exposed_", "waxed_weathered_", "waxed_oxidized_",
)


class AuditTests(unittest.TestCase):
    def run_jar(self, entries: dict[str, str | bytes]) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as tmp:
            jar_path = Path(tmp) / "client.jar"
            with zipfile.ZipFile(jar_path, "w") as jar:
                for path, data in entries.items():
                    jar.writestr(path, data)
            return subprocess.run(
                [sys.executable, str(AUDIT), str(jar_path)],
                capture_output=True,
                text=True,
                check=False,
            )

    @staticmethod
    def blockstate(model: str) -> str:
        return json.dumps({"variants": {"": {"model": model}}})

    def assert_rejected(self, entries: dict[str, str | bytes]) -> None:
        result = self.run_jar(entries)
        self.assertNotEqual(0, result.returncode, result.stdout + result.stderr)

    def test_invalid_blockstate_json_is_rejected(self) -> None:
        self.assert_rejected({"assets/minecraft/blockstates/bad.json": "{"})

    def test_jar_without_blockstates_is_rejected(self) -> None:
        self.assert_rejected({"assets/minecraft/models/block/unused.json": "{}"})

    def test_non_array_elements_is_rejected(self) -> None:
        self.assert_rejected({
            "assets/minecraft/blockstates/bad.json": self.blockstate("minecraft:block/bad"),
            "assets/minecraft/models/block/bad.json": json.dumps({"elements": {}}),
        })

    def test_malformed_members_of_elements_are_rejected(self) -> None:
        for elements in ([42], [None], [{}]):
            with self.subTest(elements=elements):
                self.assert_rejected({
                    "assets/minecraft/blockstates/bad.json": self.blockstate("minecraft:block/bad"),
                    "assets/minecraft/models/block/bad.json": json.dumps({"elements": elements}),
                })

    def test_valid_element_structure_counts_as_geometry(self) -> None:
        result = self.run_jar({
            "assets/minecraft/blockstates/cube.json": self.blockstate("minecraft:block/cube"),
            "assets/minecraft/models/block/cube.json": json.dumps({
                "elements": [{"from": [0, 0, 0], "to": [16, 16, 16]}],
            }),
        })
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_model_reference_under_unknown_blockstate_key_is_rejected(self) -> None:
        self.assert_rejected({
            "assets/minecraft/blockstates/bad.json": json.dumps({
                "garbage": {"model": "minecraft:block/cube"},
            }),
            "assets/minecraft/models/block/cube.json": json.dumps({
                "elements": [{"from": [0, 0, 0], "to": [16, 16, 16]}],
            }),
        })

    def test_missing_model_is_rejected(self) -> None:
        self.assert_rejected({
            "assets/minecraft/blockstates/bad.json": self.blockstate("minecraft:block/missing"),
        })

    def test_parent_loop_is_rejected(self) -> None:
        self.assert_rejected({
            "assets/minecraft/blockstates/bad.json": self.blockstate("minecraft:block/a"),
            "assets/minecraft/models/block/a.json": json.dumps({"parent": "minecraft:block/b"}),
            "assets/minecraft/models/block/b.json": json.dumps({"parent": "minecraft:block/a"}),
        })

    def test_model_less_blockstate_is_rejected(self) -> None:
        self.assert_rejected({
            "assets/minecraft/blockstates/bad.json": json.dumps({"variants": {"": {}}}),
        })

    def test_unknown_copper_prefix_is_unsupported(self) -> None:
        result = self.run_jar({
            "assets/minecraft/blockstates/future_copper_chest.json": self.blockstate("minecraft:block/future_copper_chest"),
            "assets/minecraft/models/block/future_copper_chest.json": "{}",
        })
        self.assertEqual(1, result.returncode)
        self.assertIn("UNSUPPORTED: future_copper_chest", result.stdout)

    def test_every_renderer_supported_copper_prefix_passes(self) -> None:
        for suffix in ("copper_chest", "copper_golem_statue"):
            for prefix in COPPER_PREFIXES:
                with self.subTest(suffix=suffix, prefix=prefix):
                    name = prefix + suffix
                    result = self.run_jar({
                        f"assets/minecraft/blockstates/{name}.json": self.blockstate(f"minecraft:block/{name}"),
                        f"assets/minecraft/models/block/{name}.json": "{}",
                    })
                    self.assertEqual(0, result.returncode, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
