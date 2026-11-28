#!/usr/bin/env python3
"""Validate additive game-order fallback lines for every chapter."""
from __future__ import annotations

import json
import unittest
from pathlib import Path
import sys

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))

from audit_story_lines import (  # noqa: E402
    AM_NEW_DISPLAY,
    AM_ROUTE_ID,
    DEFAULT_ID_INVENTORY,
    DEFAULT_MAPPING,
    DEFAULT_RUNTIME,
    SNOWFIELD_ROUTE_ID,
    TL_STORY_ID,
    TL_UNASSIGNED_ID,
    existing_id_sets,
    load_json,
    stories_of,
    route_by_id,
)

MAPPINGS = REPO / "scripts" / "fixtures" / "all_game_order_mappings.json"
CLEANUP = REPO / "scripts" / "fixtures" / "attribution_cleanup.json"


class GameOrderLineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = load_json(DEFAULT_RUNTIME)
        cls.inventory = load_json(DEFAULT_ID_INVENTORY)
        cls.bundle = load_json(MAPPINGS)
        cls.mappings = {m["story_id"]: m for m in cls.bundle["mappings"]}
        cls.routes = route_by_id(cls.data)
        cls.stories = {s["story_id"]: s for s in stories_of(cls.data)}

    def test_every_catalog_chapter_has_a_game_order_line(self):
        self.assertEqual(len(self.stories), 119)
        self.assertEqual(len(self.mappings), 119)
        missing = []
        for sid, story in self.stories.items():
            rid = f"{sid}:route:game_order"
            if rid not in self.routes or sid not in self.mappings:
                missing.append(sid)
            else:
                self.assertIn(rid, story.get("route_ids") or [])
                self.assertEqual(self.routes[rid]["ordered_scene_ids"], self.mappings[sid]["ordered_scene_ids"])
        self.assertFalse(missing, missing)
        self.assertEqual(self.bundle.get("blocked") or [], [])

    def test_game_order_lines_are_unique_and_monotonic(self):
        for sid, mapping in self.mappings.items():
            ids = mapping["ordered_scene_ids"]
            self.assertEqual(len(ids), len(set(ids)), sid)
            self.assertEqual(len(ids), mapping["unique_playable_scenes"])
            seqs = [s["seq"] for s in mapping["scenes"]]
            self.assertEqual(seqs, sorted(seqs), sid)
            seen_unaligned = False
            for item in mapping["scenes"]:
                if item.get("stage_code") == "_unaligned":
                    seen_unaligned = True
                else:
                    self.assertFalse(seen_unaligned, f"aligned scene after unaligned in {sid}")
            # unique playable coverage
            playable = {
                n["scene_id"]
                for n in self.data["corpus"]["nodes"]
                if n.get("story_id") == sid and n.get("playable") and n.get("scene_id")
            }
            self.assertEqual(set(ids), playable, sid)

    APPROVED_ADDITIVE_CHARACTER_ROUTES = {
        "story_0f447c9b9b:route:AL",
        "story_0f447c9b9b:route:YZ",
        "story_c579b90d26:route:hellagur_lavrenty",
        "story_899cfa8775:route:rosmontis_ifrit",
        "story_899cfa8775:route:nasti_engineering",
    }

    def test_ids_are_additive_game_order_only(self):
        current = existing_id_sets(self.data)
        before_routes = set(self.inventory["route_ids"])
        extra = current["route_ids"] - before_routes
        game_order = {r for r in extra if r.endswith(":route:game_order")}
        character = extra - game_order
        self.assertTrue(extra)
        self.assertEqual(len(game_order), 119)
        self.assertEqual(character, self.APPROVED_ADDITIVE_CHARACTER_ROUTES)
        self.assertEqual(current["scene_ids"], set(self.inventory["scene_ids"]))
        self.assertEqual(current["node_ids"], set(self.inventory["node_ids"]))
        self.assertFalse(before_routes - current["route_ids"])

    def test_default_routes_were_not_switched_to_game_order(self):
        nav = self.data["navigation"]
        for bucket in (nav.get("entries") or [], nav.get("supplementary") or []):
            for entry in bucket:
                default = entry.get("default_route_id")
                if not default:
                    continue
                self.assertFalse(
                    str(default).endswith(":route:game_order"),
                    f"{entry.get('story_id')} default became game_order",
                )
        tl = next(e for e in nav["entries"] if e["story_id"] == TL_STORY_ID)
        # 1.9.6-pre2: approved cleanup made 塔露拉线 the main reading entry; must not be game_order.
        self.assertEqual(tl["default_route_id"], f"{TL_STORY_ID}:route:TL")
        ss = next(e for e in nav["entries"] if e["story_id"] == "story_0f447c9b9b")
        self.assertEqual(ss["default_route_id"], SNOWFIELD_ROUTE_ID)

    def test_tl_line_still_matches_frozen_mapping(self):
        baked = load_json(DEFAULT_MAPPING)
        route = self.routes[f"{TL_STORY_ID}:route:game_order"]
        self.assertEqual(route["ordered_scene_ids"], baked["ordered_scene_ids"])
        self.assertEqual(len(route["ordered_scene_ids"]), 136)
        un = self.routes[TL_UNASSIGNED_ID]
        self.assertEqual(len(un["ordered_scene_ids"]), 136)
        self.assertIn("兼容入口", un.get("display_label") or "")
        self.assertIn("服装", un.get("display_label_previous") or un.get("previous_display_label") or "")

    def test_am_and_snowfield_still_separate(self):
        am = self.routes[AM_ROUTE_ID]
        ss = self.routes[SNOWFIELD_ROUTE_ID]
        self.assertEqual(am["display_label"], AM_NEW_DISPLAY)
        self.assertEqual(len(am["ordered_scene_ids"]), 7)
        self.assertEqual(ss["display_label"], "塔露拉线")
        self.assertEqual(len(ss["ordered_scene_ids"]), 19)

    def test_no_local_script_routes_are_isolated_from_llm_queue(self):
        flagged = [r for r in self.data["routes"]["routes"] if r.get("no_local_script")]
        self.assertEqual(len(flagged), 346)
        for r in flagged:
            self.assertTrue(r.get("exclude_from_llm_queue"))
            self.assertEqual(r.get("llm_queue_exclusion_reason"), "official_prts_stage_order")

    def test_display_cleanup_is_additive_and_preserves_previous_label(self):
        cleanup = load_json(CLEANUP)
        relabeled = [c for c in cleanup["changes"] if c["action"] == "relabeled"]
        kept = [c for c in cleanup["changes"] if c["action"] == "kept_existing_verified_correction"]
        self.assertEqual(len(cleanup["changes"]), 75)
        self.assertEqual(len(relabeled) + len(kept), 75)
        # Eight approved three-chapter display revisions go past the Phase C cleanup label
        # but must still keep the original previous label and attribution flags.
        further_revised = {
            "story_899cfa8775:route:FK",
            "story_899cfa8775:route:KW",
            "story_899cfa8775:route:MI",
            "story_899cfa8775:route:OH",
            "story_899cfa8775:route:RD",
            "story_899cfa8775:route:SR",
            "story_c579b90d26:route:AL",
            "story_c579b90d26:route:ED",
        }
        for change in relabeled + kept:
            route = self.routes[change["route_id"]]
            if change["route_id"] in further_revised:
                self.assertNotEqual(route["display_label"], change["previous_display_label"])
                self.assertNotEqual(route["display_label"], change["new_display_label"])
            else:
                self.assertEqual(route["display_label"], change["new_display_label"])
            self.assertEqual(route.get("display_label_previous"), change["previous_display_label"])
            self.assertNotEqual(change["new_display_label"], change["previous_display_label"])
            self.assertTrue(route.get("attribution_suspect"))
            self.assertTrue(route.get("attribution", {}).get("block_summary_injection"))

    def test_low_confidence_or_unaligned_chapters_are_flagged_not_silent(self):
        flagged = []
        for mapping in self.bundle["mappings"]:
            unaligned = sum(1 for s in mapping["scenes"] if s.get("stage_code") == "_unaligned")
            if mapping["confidence"] in {"low", "reconstructed"} or unaligned:
                flagged.append(mapping["story_id"])
                self.assertTrue(
                    mapping.get("notes") or mapping["confidence"] == "reconstructed",
                    mapping["story_title"],
                )
        # Lone Light / Operation Originium Dust / compilation are the known hard leftovers
        self.assertIn(next(m["story_id"] for m in self.bundle["mappings"] if m["story_title"] == "孤星"), flagged)
        self.assertIn(next(m["story_id"] for m in self.bundle["mappings"] if m["story_title"] == "源石尘行动"), flagged)

        lonestar = next(m for m in self.bundle["mappings"] if m["story_title"] == "孤星")
        route = self.routes[lonestar["new_route_id"]]
        self.assertEqual(route["ordered_scene_ids"], lonestar["ordered_scene_ids"])
        self.assertTrue(route.get("pending_human_stage_review"))
        self.assertEqual(route.get("chrono_confidence"), "low")

    def test_structural_placements_use_an_aligned_anchor_stage(self):
        for mapping in self.bundle["mappings"]:
            by_scene = {item["scene_id"]: item for item in mapping["scenes"]}
            for item in mapping["scenes"]:
                if not item.get("structural_placement"):
                    continue
                anchor = by_scene[item["placement_anchor_scene_id"]]
                self.assertFalse(anchor.get("structural_placement"), item["scene_id"])
                self.assertNotEqual(item["stage_code"], "_unaligned")
                self.assertEqual(item["stage_code"], anchor["stage_code"])
                self.assertEqual(item.get("avg_tag"), anchor.get("avg_tag"))
                self.assertEqual(item["seq"], anchor["seq"])
                self.assertEqual(item.get("placement_source"), "chapter_original")


if __name__ == "__main__":
    unittest.main()
