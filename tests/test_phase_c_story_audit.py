#!/usr/bin/env python3
"""Phase C validations: ID stability, TL chronological line, AM display fix."""
from __future__ import annotations

import json
import unittest
from pathlib import Path
import sys

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))

from audit_story_lines import (  # noqa: E402
    AM_NEW_DISPLAY,
    AM_OLD_DISPLAY,
    AM_ROUTE_ID,
    NEW_ROUTE_ID,
    SNOWFIELD_ROUTE_ID,
    TL_STORY_ID,
    TL_UNASSIGNED_ID,
    DEFAULT_ID_INVENTORY,
    DEFAULT_MAPPING,
    DEFAULT_RUNTIME,
    load_json,
    existing_id_sets,
)

OFFICIAL_INDEX = REPO / "scripts" / "fixtures" / "act55side_official_index.json"


class PhaseCStoryAuditTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = load_json(DEFAULT_RUNTIME)
        cls.inventory = load_json(DEFAULT_ID_INVENTORY)
        cls.mapping = load_json(DEFAULT_MAPPING)
        cls.official = load_json(OFFICIAL_INDEX)
        cls.routes = {r["route_id"]: r for r in cls.data["routes"]["routes"]}
        cls.nodes = {n["node_id"]: n for n in cls.data["corpus"]["nodes"]}
        cls.scenes = {s["scene_id"]: s for s in cls.data["scenes"]["scenes"]}

    def test_v195_route_scene_node_ids_were_not_removed_or_renamed(self):
        current = existing_id_sets(self.data)
        for kind, key in (("route_ids", "route_ids"), ("scene_ids", "scene_ids"), ("node_ids", "node_ids")):
            before = set(self.inventory[key])
            missing = before - current[kind]
            self.assertFalse(missing, f"{kind} missing from runtime: {sorted(missing)[:10]}")

    APPROVED_ADDITIVE_CHARACTER_ROUTES = {
        "story_0f447c9b9b:route:AL",
        "story_0f447c9b9b:route:YZ",
        "story_c579b90d26:route:hellagur_lavrenty",
        "story_899cfa8775:route:rosmontis_ifrit",
        "story_899cfa8775:route:nasti_engineering",
    }

    def test_no_existing_id_was_mutated_and_only_game_order_route_was_added(self):
        current = existing_id_sets(self.data)
        before_routes = set(self.inventory["route_ids"])
        extra_routes = current["route_ids"] - before_routes
        game_order = {r for r in extra_routes if r.endswith(":route:game_order")}
        character = extra_routes - game_order
        self.assertIn(NEW_ROUTE_ID, game_order)
        self.assertEqual(len(game_order), 119)
        self.assertEqual(character, self.APPROVED_ADDITIVE_CHARACTER_ROUTES)
        self.assertEqual(current["scene_ids"], set(self.inventory["scene_ids"]))
        self.assertEqual(current["node_ids"], set(self.inventory["node_ids"]))

    def test_am_display_fix_preserves_ids_and_does_not_merge_snowfield(self):
        am = self.routes[AM_ROUTE_ID]
        ss = self.routes[SNOWFIELD_ROUTE_ID]
        self.assertEqual(am["route_id"], AM_ROUTE_ID)
        self.assertEqual(len(am["ordered_scene_ids"]), 7)
        self.assertEqual(
            am["ordered_scene_ids"],
            [
                "scene:story_49947c64bb:AM1",
                "scene:story_49947c64bb:AM2",
                "scene:story_49947c64bb:AM3",
                "scene:story_49947c64bb:AM4",
                "scene:story_49947c64bb:AM5",
                "scene:story_49947c64bb:AM6",
                "scene:story_49947c64bb:AM7",
            ],
        )
        self.assertEqual(am["display_label"], AM_NEW_DISPLAY)
        self.assertNotEqual(am["display_label"], AM_OLD_DISPLAY)
        self.assertEqual(am.get("display_label_previous"), AM_OLD_DISPLAY)
        self.assertTrue(am.get("attribution_suspect"))
        self.assertEqual(am.get("attribution", {}).get("do_not_merge_with"), SNOWFIELD_ROUTE_ID)
        self.assertEqual(ss["display_label"], "塔露拉线")
        self.assertEqual(len(ss["ordered_scene_ids"]), 19)
        self.assertTrue(NEW_ROUTE_ID not in ss["ordered_scene_ids"])

    def test_tl_unassigned_and_all_37_original_lines_untouched(self):
        original = [r for r in self.inventory["route_ids"] if r.startswith(TL_STORY_ID + ":")]
        self.assertEqual(len(original), 37)
        for rid in original:
            self.assertIn(rid, self.routes)
        un = self.routes[TL_UNASSIGNED_ID]
        self.assertEqual(len(un["ordered_scene_ids"]), 136)
        self.assertEqual(un.get("order_source"), "full_script_fallback")
        self.assertTrue(un.get("attribution_suspect"))
        self.assertIn("兼容入口", un.get("display_label") or "")
        self.assertIn("服装", un.get("display_label_previous") or un.get("previous_display_label") or "")

    def test_chrono_line_covers_136_unique_scenes_without_duplicates(self):
        route = self.routes[NEW_ROUTE_ID]
        ids = route["ordered_scene_ids"]
        self.assertEqual(len(ids), 136)
        self.assertEqual(len(set(ids)), 136)
        self.assertEqual(ids, self.mapping["ordered_scene_ids"])
        playable = [
            n["scene_id"]
            for n in self.data["corpus"]["nodes"]
            if n.get("story_id") == TL_STORY_ID and n.get("playable")
        ]
        self.assertEqual(set(ids), set(playable))
        self.assertEqual(len(playable), 136)
        for sid in ids:
            self.assertIn(sid, self.scenes)
        for nid in self.mapping["ordered_node_ids"]:
            self.assertIn(nid, self.nodes)

    def test_chrono_stages_are_monotonically_non_decreasing(self):
        seq_by_scene = {item["scene_id"]: item["seq"] for item in self.mapping["scenes"]}
        seqs = [seq_by_scene[sid] for sid in self.mapping["ordered_scene_ids"]]
        self.assertEqual(seqs, sorted(seqs))
        self.assertEqual(min(seqs), 1)
        self.assertEqual(max(seqs), 24)
        self.assertEqual(len(self.official["segments"]), 24)
        # official TL-1..TL-10 plus ST bookends all appear
        codes = [st["stage_code"] for st in self.mapping["stage_tables"]]
        for expected in ["TL-ST-1", "TL-1", "TL-2", "TL-3", "TL-4", "TL-ST-2",
                         "TL-5", "TL-6", "TL-7", "TL-ST-3", "TL-8", "TL-9", "TL-10", "TL-ST-4"]:
            self.assertIn(expected, codes)
        # family order TL-ST-1, then TL-1..4, ST-2, 5..7, ST-3, 8..10, ST-4
        family_rank = {
            "TL-ST-1": 0, "TL-1": 1, "TL-2": 2, "TL-3": 3, "TL-4": 4, "TL-ST-2": 5,
            "TL-5": 6, "TL-6": 7, "TL-7": 8, "TL-ST-3": 9, "TL-8": 10, "TL-9": 11,
            "TL-10": 12, "TL-ST-4": 13,
        }
        family = [family_rank[item["stage_code"]] for item in self.mapping["scenes"]]
        self.assertEqual(family, sorted(family))

    def test_chrono_route_is_marked_as_new_id_draft(self):
        route = self.routes[NEW_ROUTE_ID]
        self.assertEqual(route["line_code"], "game_order")
        self.assertEqual(route["order_source"], "game_chronological_fallback")
        self.assertTrue(route.get("pending_human_stage_review"))
        # default must not become game_order; 1.9.6-pre2 uses the approved 塔露拉线 entry.
        nav = next(e for e in self.data["navigation"]["entries"] if e["story_id"] == TL_STORY_ID)
        self.assertEqual(nav["default_route_id"], f"{TL_STORY_ID}:route:TL")
        self.assertFalse(str(nav["default_route_id"]).endswith(":route:game_order"))
        self.assertIn(NEW_ROUTE_ID, nav["route_ids"])


if __name__ == "__main__":
    unittest.main()
