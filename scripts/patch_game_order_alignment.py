#!/usr/bin/env python3
"""Incrementally place leftover game-order scenes using chapter originals.

Does not rebuild the product. Does not rewrite route_id / scene_id / node_id.
A scene moves off `_unaligned` only when the chapter original anchors it to
exactly one official stage that an already-aligned scene already occupies:

- same source_locator as that scene (title/body split of one node)
- a logic-index line whose referenced node codes all sit on that one stage
- both document neighbors in the same original entry are on that one stage
- a pure header line immediately introducing the next aligned scene

Everything else stays `_unaligned`.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import statistics
import struct
import sys
import zlib
import base64
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))

from audit_story_lines import (  # noqa: E402
    compute_data_version,
    dump_compact,
    dump_pretty,
    load_json,
    sha256_file,
)
from build_complete_product import (  # noqa: E402
    VERSION,
    pack_runtime,
    stage_tables_from,
)

ORIGINALS = Path("/workspace/official-chapter-originals/from-desktop-pack")
MAP_PATH = REPO / "scripts" / "fixtures" / "all_game_order_mappings.json"
RUNTIME_PATH = REPO / "data" / "story_runtime.json"
OLD_PACKED_VERSION = "3ca13ec30ffd"
OLD_GZ_NAME = "story_runtime.384c0498cb3b5c8d.json.gz"
OLD_SCRIPT_SHA = "6ba8549979c7cff86925d33c5e8897366b4d6dbfba369e53ab4cab2ecd14e1b4"
RECONSTRUCTED_IDS = ("story_0f447c9b9b", "story_8d59ecb165")
CN_DIGITS = {"零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def now_iso() -> str:
    return datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")


def stage_key(scene: dict) -> tuple:
    return (
        scene.get("seq"),
        scene.get("stage_code") or "",
        scene.get("avg_tag") or "",
        scene.get("stage_name") or "",
    )


def cn_to_int(text: str) -> int | None:
    if not text:
        return None
    if text == "十":
        return 10
    if text.startswith("十") and len(text) == 2 and text[1] in CN_DIGITS:
        return 10 + CN_DIGITS[text[1]]
    if "十" in text:
        left, right = text.split("十", 1)
        if left in CN_DIGITS and (right == "" or right in CN_DIGITS):
            return CN_DIGITS[left] * 10 + (CN_DIGITS[right] if right else 0)
    if text in CN_DIGITS:
        return CN_DIGITS[text]
    return None


def act_number(comment: str) -> int | None:
    match = re.search(r"第([一二三四五六七八九十]+)幕", comment or "")
    if not match:
        return None
    return cn_to_int(match.group(1))


def node_body(node: dict, texts: dict[str, str]) -> str:
    text = texts.get(node.get("entry_id") or "", "")
    start, end = node.get("start"), node.get("end")
    if isinstance(start, int) and isinstance(end, int) and isinstance(text, str) and end >= start:
        return text[start:end] if end <= len(text) else text[start:]
    return ""


def is_pure_header(text: str, node_code: str) -> bool:
    compact = re.sub(r"\s+", "", text or "")
    if not compact or not node_code:
        return False
    allowed = {
        node_code,
        f"剧情节点{node_code}",
        f"{node_code}剧情节点",
        f"剧情节点{node_code}：",
        f"剧情节点{node_code}:",
    }
    match = re.match(r"^(.*?)(\d+)$", node_code)
    if match:
        name, num = match.group(1), match.group(2)
        allowed.add(f"{name}剧情节点{num}")
        allowed.add(f"剧情节点{name}{num}")
    return compact in allowed


def codes_in_text(text: str, codes: list[str]) -> list[str]:
    found = []
    remaining = text or ""
    for code in sorted((c for c in codes if c), key=len, reverse=True):
        if code in remaining:
            found.append(code)
            remaining = remaining.replace(code, " ")
    return found


def expand_ranges(text: str, known: set[str]) -> list[str]:
    out = []
    pattern = re.compile(
        r"([\u4e00-\u9fffA-Za-z]*?)(\d+)\s*[至到—－\-~]+\s*(?:([\u4e00-\u9fffA-Za-z]*?)(\d+)|(\d+))"
    )
    for match in pattern.finditer(text or ""):
        raw_prefix, start_s, prefix2, end_s, end_bare = match.groups()
        start_n = int(start_s)
        end_n = int(end_s or end_bare)
        candidates = []
        for prefix in (prefix2, raw_prefix):
            if not prefix:
                continue
            candidates.append(prefix)
            if prefix.startswith("剧情节点"):
                candidates.append(prefix[len("剧情节点"):])
        chosen = None
        for prefix in candidates:
            if f"{prefix}{start_n}" in known or f"{prefix}{end_n}" in known:
                chosen = prefix
                break
        if not chosen or end_n == start_n:
            continue
        step = 1 if end_n >= start_n else -1
        if abs(end_n - start_n) > 80:
            continue
        for number in range(start_n, end_n + step, step):
            code = f"{chosen}{number}"
            if code in known:
                out.append(code)
    return out


def verify_original(source: dict) -> str | None:
    rel = source.get("relative_path") or ""
    path = ORIGINALS / rel
    if not path.is_file():
        return f"missing_original:{rel}"
    original = json.loads(path.read_text(encoding="utf-8"))
    by_uid = {str(entry.get("uid")): entry.get("content") or "" for entry in original.get("entries", {}).values()}
    texts = source.get("_texts") or {}
    matched = 0
    for entry in source.get("entries") or []:
        body = texts.get(entry.get("text_sha256") or "")
        uid = str(entry.get("uid"))
        if uid not in by_uid:
            return f"uid_missing:{rel}#uid{uid}"
        if body != by_uid[uid]:
            return f"entry_text_mismatch:{rel}#uid{uid}"
        matched += 1
    if matched != len(by_uid):
        return f"entry_count_mismatch:{rel}:{matched}!={len(by_uid)}"
    return None


def attach_texts(data: dict) -> dict[str, dict]:
    texts = data["corpus"]["texts"]
    out = {}
    for source in data["corpus"]["sources"]:
        copied = dict(source)
        copied["_texts"] = {}
        for entry in source.get("entries") or []:
            sha = entry.get("text_sha256")
            if isinstance(texts.get(sha), str):
                copied["_texts"][sha] = texts[sha]
                copied["_texts"][entry.get("entry_id")] = texts[sha]
        out[source["story_id"]] = copied
    return out


def entry_text_by_id(source: dict) -> dict[str, str]:
    return {k: v for k, v in (source.get("_texts") or {}).items() if isinstance(v, str)}


def plan_story(mapping: dict, nodes: list[dict], texts: dict[str, str]) -> dict:
    scenes = mapping["scenes"]
    by_id = {scene["scene_id"]: scene for scene in scenes}
    by_loc = defaultdict(list)
    by_code = defaultdict(list)
    order_index = {scene["scene_id"]: index for index, scene in enumerate(scenes)}
    known_codes = {scene.get("node_code") or "" for scene in scenes}
    known_codes.discard("")
    for scene in scenes:
        by_loc[scene.get("source_locator") or ""].append(scene)
        by_code[scene.get("node_code") or ""].append(scene)
    node_by_id = {node["node_id"]: node for node in nodes}
    by_uid = defaultdict(list)
    for node in nodes:
        if node.get("playable") and node.get("scene_id") in by_id:
            by_uid[node.get("source_uid")].append(node)
    uid_lists = {}
    pos = {}
    for uid, group in by_uid.items():
        ordered = sorted(group, key=lambda n: (n.get("start") is None, n.get("start") or 0, n["node_id"]))
        uid_lists[uid] = ordered
        for index, node in enumerate(ordered):
            pos[node["node_id"]] = index

    decisions = []
    remaining = []
    for scene in scenes:
        if scene.get("stage_code") != "_unaligned":
            continue
        node = node_by_id[scene["node_id"]]
        text = node_body(node, texts).strip()
        decision = None
        loc = scene.get("source_locator") or ""
        aligned_loc = [
            other for other in by_loc.get(loc, [])
            if other["scene_id"] != scene["scene_id"] and other.get("stage_code") != "_unaligned"
        ]
        loc_stages = {stage_key(other) for other in aligned_loc}
        if loc and aligned_loc and len(loc_stages) == 1:
            decision = placement_against_siblings(scene, aligned_loc, node_by_id, order_index, "same_source_locator")
        else:
            act = node.get("act_name") or ""
            logic = "逻辑" in act
            mentioned = []
            if logic:
                mentioned = codes_in_text(text, list(known_codes))
                for code in expand_ranges(text, known_codes):
                    if code not in mentioned:
                        mentioned.append(code)
            own = scene.get("node_code") or ""
            if own and own not in mentioned and not re.search(r"[至到—－]", text or ""):
                mentioned = mentioned  # own code is handled by the unique-stage rule below
            range_like = bool(re.search(r"[至到—－]|依次", text or "")) or len(mentioned) >= 2
            if logic and range_like and mentioned:
                decision = placement_for_codes(mentioned, by_code, order_index, "logic_index_single_stage")
            if decision is None and logic and not range_like:
                same = [other for other in by_code.get(own, []) if other.get("stage_code") != "_unaligned"]
                stages = {stage_key(other) for other in same}
                if len(stages) == 1:
                    decision = placement_against_siblings(scene, same, node_by_id, order_index, "logic_index_single_code")
                    decision["place"] = "before"
                    decision["anchor_scene_id"] = min(same, key=lambda item: order_index[item["scene_id"]])["scene_id"]
                    anchor = by_id[decision["anchor_scene_id"]]
                    decision.update(stage_fields(anchor))
            if decision is None:
                uid = node.get("source_uid")
                group = uid_lists.get(uid) or []
                index = pos.get(node["node_id"])
                prev = by_id[group[index - 1]["scene_id"]] if index is not None and index > 0 else None
                nxt = by_id[group[index + 1]["scene_id"]] if index is not None and index + 1 < len(group) else None
                if (
                    prev and nxt
                    and prev.get("stage_code") != "_unaligned"
                    and nxt.get("stage_code") != "_unaligned"
                    and stage_key(prev) == stage_key(nxt)
                    and between_starts(node, group[index - 1], group[index + 1])
                ):
                    decision = {
                        "method": "same_stage_document_neighbors",
                        "anchor_scene_id": prev["scene_id"],
                        "place": "after" if order_index[prev["scene_id"]] <= order_index[nxt["scene_id"]] else "before",
                        **stage_fields(prev),
                    }
                    if decision["place"] == "before":
                        decision["anchor_scene_id"] = nxt["scene_id"]
                elif nxt and nxt.get("stage_code") != "_unaligned" and is_pure_header(text, scene.get("node_code") or ""):
                    gap = gap_between(node, group[index + 1] if index is not None else None)
                    if gap is not None and 0 <= gap <= 4:
                        decision = {
                            "method": "header_introduces_next_scene",
                            "anchor_scene_id": nxt["scene_id"],
                            "place": "before",
                            **stage_fields(nxt),
                        }
        if decision is None:
            remaining.append(remain_record(scene, node, text, by_id, uid_lists, pos, by_code))
        else:
            decision["sort_start"] = node.get("start") if isinstance(node.get("start"), int) else 0
            decision["scene_id"] = scene["scene_id"]
            decision["node_id"] = scene["node_id"]
            decision["node_code"] = scene.get("node_code")
            decision["chars"] = scene.get("chars")
            decisions.append(decision)
    return {"decisions": decisions, "remaining": remaining}


def stage_fields(anchor: dict) -> dict:
    return {
        "seq": anchor["seq"],
        "stage_code": anchor.get("stage_code") or "",
        "avg_tag": anchor.get("avg_tag") or "",
        "stage_name": anchor.get("stage_name") or "",
        "official_story_txt": anchor.get("official_story_txt") or "",
    }


def placement_against_siblings(scene, siblings, node_by_id, order_index, method) -> dict:
    def start_of(item):
        value = node_by_id[item["node_id"]].get("start")
        return value if isinstance(value, int) else None

    own = start_of(scene)
    later = [item for item in siblings if (start_of(item) is not None and own is not None and start_of(item) >= own)]
    earlier = [item for item in siblings if (start_of(item) is not None and own is not None and start_of(item) < own)]
    if later:
        anchor = min(later, key=lambda item: order_index[item["scene_id"]])
        place = "before"
    elif earlier:
        anchor = max(earlier, key=lambda item: order_index[item["scene_id"]])
        place = "after"
    else:
        anchor = min(siblings, key=lambda item: order_index[item["scene_id"]])
        place = "before"
    return {"method": method, "anchor_scene_id": anchor["scene_id"], "place": place, **stage_fields(anchor)}


def placement_for_codes(codes, by_code, order_index, method) -> dict | None:
    aligned = []
    for code in codes:
        hits = [item for item in by_code.get(code, []) if item.get("stage_code") != "_unaligned"]
        if not hits:
            return None
        aligned.extend(hits)
    stages = {stage_key(item) for item in aligned}
    if len(stages) != 1:
        return None
    anchor = min(aligned, key=lambda item: order_index[item["scene_id"]])
    return {
        "method": method,
        "anchor_scene_id": anchor["scene_id"],
        "place": "before",
        **stage_fields(anchor),
    }


def between_starts(node, prev, nxt) -> bool:
    values = [prev.get("start"), node.get("start"), nxt.get("start")]
    if not all(isinstance(value, int) for value in values):
        return True
    return values[0] <= values[1] <= values[2]


def gap_between(node, nxt) -> int | None:
    if nxt is None:
        return None
    end, start = node.get("end"), nxt.get("start")
    if isinstance(end, int) and isinstance(start, int):
        return start - end
    return None


def remain_record(scene, node, text, by_id, uid_lists, pos, by_code) -> dict:
    uid = node.get("source_uid")
    group = uid_lists.get(uid) or []
    index = pos.get(node["node_id"])
    prev = by_id[group[index - 1]["scene_id"]] if index is not None and index > 0 else None
    nxt = by_id[group[index + 1]["scene_id"]] if index is not None and index + 1 < len(group) else None

    def label(item):
        if not item:
            return None
        if item.get("stage_code") == "_unaligned":
            return "_unaligned"
        return f"{item.get('stage_code')}/{item.get('avg_tag')}"

    act = node.get("act_name") or ""
    if "逻辑" in act:
        reason = "logic_index_spans_more_than_one_official_stage"
    elif prev and nxt and prev.get("stage_code") != "_unaligned" and nxt.get("stage_code") != "_unaligned" and stage_key(prev) != stage_key(nxt):
        reason = "sits_between_two_different_official_stages"
    elif prev and prev.get("stage_code") != "_unaligned" and nxt is None:
        reason = "end_of_original_entry_without_a_following_anchor"
    elif nxt and nxt.get("stage_code") != "_unaligned" and prev is None:
        reason = "start_of_original_entry_not_a_pure_header"
    elif (prev is None or prev.get("stage_code") == "_unaligned") and (nxt is None or nxt.get("stage_code") == "_unaligned"):
        reason = "no_aligned_neighbor_in_the_same_original_entry"
    else:
        reason = "no_single_official_stage"
    same = [item for item in by_code.get(scene.get("node_code") or "", []) if item.get("stage_code") != "_unaligned"]
    return {
        "scene_id": scene["scene_id"],
        "node_id": scene["node_id"],
        "node_code": scene.get("node_code"),
        "chars": scene.get("chars"),
        "act_name": act,
        "reason": reason,
        "prev_stage": label(prev),
        "next_stage": label(nxt),
        "same_code_stages": sorted({f"{item.get('stage_code')}/{item.get('avg_tag')}" for item in same}),
        "excerpt": re.sub(r"\s+", " ", text)[:120],
    }


def apply_decisions(mapping: dict, decisions: list[dict]) -> None:
    by_id = {scene["scene_id"]: scene for scene in mapping["scenes"]}
    order_index = {scene["scene_id"]: index for index, scene in enumerate(mapping["scenes"])}
    placed = {item["scene_id"]: item for item in decisions}
    keyed = []
    for scene in mapping["scenes"]:
        if scene["scene_id"] in placed:
            continue
        keyed.append((scene["seq"], order_index[scene["scene_id"]], 0, 0, scene["scene_id"], scene))
    for item in decisions:
        scene = by_id[item["scene_id"]]
        anchor = by_id[item["anchor_scene_id"]]
        if anchor.get("stage_code") == "_unaligned":
            raise SystemExit(f"anchor still unaligned: {item['anchor_scene_id']}")
        for field in ("seq", "stage_code", "avg_tag", "stage_name", "official_story_txt"):
            scene[field] = item[field]
        scene["structural_placement"] = True
        scene["placement_method"] = item["method"]
        scene["placement_anchor_scene_id"] = item["anchor_scene_id"]
        scene["placement_source"] = "chapter_original"
        scene["coverage"] = None
        scene["jaccard"] = None
        scene["shingle_overlap"] = None
        scene["margin_vs_second"] = None
        scene["second_stage_code"] = None
        scene["second_avg_tag"] = None
        scene["second_coverage"] = None
        sub = -1 if item["place"] == "before" else 1
        start = item.get("sort_start") or 0
        keyed.append((scene["seq"], order_index[anchor["scene_id"]], sub, start, scene["scene_id"], scene))
    keyed.sort()
    ordered = [item[-1] for item in keyed]
    ids = [scene["scene_id"] for scene in ordered]
    if len(ids) != len(set(ids)):
        raise SystemExit(f"duplicate scenes in {mapping['story_id']}")
    if [scene["seq"] for scene in ordered] != sorted(scene["seq"] for scene in ordered):
        raise SystemExit(f"non-monotonic stages in {mapping['story_id']}")
    seen_unaligned = False
    for scene in ordered:
        if scene.get("stage_code") == "_unaligned":
            seen_unaligned = True
        elif seen_unaligned:
            raise SystemExit(f"aligned scene after unaligned in {mapping['story_id']}")
    mapping["scenes"] = ordered
    mapping["ordered_scene_ids"] = ids
    mapping["ordered_node_ids"] = [scene["node_id"] for scene in ordered]
    mapping["stages"] = stage_tables_from(ordered)
    covs = [
        scene["coverage"] for scene in ordered
        if isinstance(scene.get("coverage"), (int, float)) and scene.get("stage_code") != "_unaligned"
    ]
    if covs:
        mapping["min_coverage"] = min(covs)
        mapping["median_coverage"] = statistics.median(covs)
    mapping["low_margin_count"] = sum(
        1 for scene in ordered
        if not scene.get("structural_placement") and (scene.get("margin_vs_second") or 1) < 0.05
    )


def update_notes(mapping: dict, placed: int, remain: int, relative_path: str, extra: str | None = None) -> None:
    notes = [note for note in (mapping.get("notes") or []) if note != "has_unaligned_local_scenes"]
    if relative_path:
        notes.append(f"chapter_original:{relative_path}")
    if placed:
        notes.append(f"chapter_original_structural_placement:{placed}")
    elif extra:
        notes.append(extra)
    if remain:
        notes.append("has_unaligned_local_scenes")
        notes.append(f"remaining_unaligned_after_chapter_original:{remain}")
    # preserve order, drop exact duplicates
    deduped = []
    for note in notes:
        if note not in deduped:
            deduped.append(note)
    mapping["notes"] = deduped


def sync_route(data: dict, mapping: dict, placed_ids: set[str]) -> None:
    rid = mapping["new_route_id"]
    route = next(item for item in data["routes"]["routes"] if item["route_id"] == rid)
    before_ids = set(route["ordered_scene_ids"])
    if before_ids != set(mapping["ordered_scene_ids"]):
        raise SystemExit(f"scene set changed on {rid}")
    route["ordered_scene_ids"] = list(mapping["ordered_scene_ids"])
    route["node_count"] = len(mapping["ordered_scene_ids"])
    route["chrono_notes"] = list(mapping.get("notes") or [])
    route["chrono_confidence"] = mapping.get("confidence")

    line = next(item for item in data["corpus"]["lines"] if item["route_id"] == rid)
    line["ordered_scene_ids"] = list(mapping["ordered_scene_ids"])
    line["ordered_legacy_scene_ids"] = list(mapping["ordered_scene_ids"])
    line["ordered_node_ids"] = list(mapping["ordered_node_ids"])
    line["ordered_codes"] = [scene.get("node_code") for scene in mapping["scenes"]]

    guide = next(item for item in data["route_guides"]["guides"] if item["route_id"] == rid)
    acts = {act["node_id"]: act for act in guide.get("acts") or []}
    briefs = {brief["node_id"]: brief for brief in guide.get("act_briefs") or []}
    new_acts = []
    new_briefs = []
    codes = [scene.get("node_code") for scene in mapping["scenes"]]
    for index, scene in enumerate(mapping["scenes"]):
        act = acts.get(scene["node_id"])
        if act is None:
            raise SystemExit(f"missing guide act {scene['node_id']}")
        act = dict(act)
        act["next_node_code"] = codes[index + 1] if index + 1 < len(codes) else None
        new_acts.append(act)
        brief = briefs.get(scene["node_id"])
        if brief is not None:
            new_briefs.append(brief)
    if len(new_acts) != len(acts):
        raise SystemExit(f"guide act set changed on {rid}")
    guide["acts"] = new_acts
    guide["act_briefs"] = new_briefs
    guide["order"] = list(mapping["ordered_node_ids"])

    summary = next(item for item in data["player_summaries"]["routes"] if item["route_id"] == rid)
    by_scene = {}
    for entry in summary.get("entries") or []:
        by_scene[entry.get("scene_id")] = entry
    new_entries = []
    for index, scene in enumerate(mapping["scenes"], start=1):
        entry = by_scene.get(scene["scene_id"])
        if entry is None:
            raise SystemExit(f"missing summary {scene['scene_id']}")
        entry = dict(entry)
        entry["order"] = index
        if scene["scene_id"] in placed_ids:
            entry["title"] = f"{scene.get('stage_code') or ''} {scene.get('avg_tag') or ''} {scene.get('stage_name') or ''}".strip()
        new_entries.append(entry)
    summary["entries"] = new_entries


def reconstructed_note(mapping: dict, nodes: list[dict]) -> dict:
    """Compare the rebuilt unique-scene order with the chapter original's act order.

    These chapters have no official stage table. The comparison is evidence only.
    """
    by_scene = {}
    for node in nodes:
        if node.get("playable") and node.get("scene_id"):
            by_scene.setdefault(node["scene_id"], node)
    groups = defaultdict(list)
    for scene in mapping["scenes"]:
        node = by_scene.get(scene["scene_id"])
        if not node:
            continue
        comment = ""
        groups[node.get("source_uid")].append(node)
    # act numbers come back from the caller via node act_name
    def sort_key(node):
        number = act_number(node.get("act_name") or "")
        logic = 0 if "逻辑" in (node.get("act_name") or "") else 1
        return (logic, number is None, number or 0, node.get("start") is None, node.get("start") or 0, node["node_id"])
    original_order = [node["node_id"] for node in sorted(by_scene.values(), key=sort_key) if "逻辑" not in (node.get("act_name") or "")]
    current = list(mapping["ordered_node_ids"])
    return {
        "story_id": mapping["story_id"],
        "story_title": mapping["story_title"],
        "matching_method": mapping.get("matching_method"),
        "confidence": mapping.get("confidence"),
        "original_act_order_matches_game_order": original_order == current,
        "original_act_count": len(original_order),
        "game_order_count": len(current),
        "decision": "left_reconstructed_no_official_stage_table",
    }


def read_card(data: bytes) -> dict:
    blocks = {}
    offset = 8
    while offset + 12 <= len(data):
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        kind = data[offset + 4:offset + 8]
        part = data[offset + 8:offset + 8 + length]
        offset += length + 12
        if kind == b"tEXt" and b"\0" in part:
            key, value = part.split(b"\0", 1)
            if key in (b"ccv3", b"chara"):
                blocks[key.decode()] = json.loads(base64.b64decode(value))
    return blocks.get("ccv3") or blocks.get("chara")


def write_card(data: bytes, card: dict) -> bytes:
    value = base64.b64encode(json.dumps(card, ensure_ascii=False, separators=(",", ":")).encode())
    out = bytearray(data[:8])
    offset = 8
    while offset + 12 <= len(data):
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        kind = data[offset + 4:offset + 8]
        part = data[offset + 8:offset + 8 + length]
        offset += length + 12
        if kind == b"tEXt" and part.split(b"\0", 1)[0] in (b"ccv3", b"chara"):
            part = part.split(b"\0", 1)[0] + b"\0" + value
            chunk = struct.pack(">I", len(part)) + kind + part + struct.pack(">I", zlib.crc32(kind + part) & 0xffffffff)
            out.extend(chunk)
        else:
            out.extend(data[offset - length - 12:offset])
    return bytes(out)


def stamp_release(new_version: str, manifest: dict, script_sha: str, card_sha: str, card_bytes: int) -> None:
    release_path = REPO / "release.json"
    release = load_json(release_path)
    release["data_version"] = new_version
    release["build_id"] = manifest["build_id"]
    release["card_script_sha256"] = script_sha
    release["data"] = {
        "path": "data/story_runtime.json",
        "bytes": manifest["bytes"],
        "sha256": manifest["sha256"],
    }
    release["packed_data"] = {
        "path": manifest["packed"]["path"],
        "bytes": manifest["packed"]["bytes"],
        "sha256": manifest["packed"]["sha256"],
    }
    release["card"]["sha256"] = card_sha
    release["card"]["bytes"] = card_bytes
    release["card"]["script_sha256"] = script_sha
    note = "增量补丁：用章节原文把能诚实挂上官方关卡的 _unaligned 场景放进既有年表保底线；放不上的仍留在线末。未部署。"
    changes = release.get("changes") or []
    if note not in changes:
        release["changes"] = [note] + list(changes)
    dump_pretty(release_path, release)

    index = REPO / "index.js"
    text = index.read_text(encoding="utf-8")
    text = text.replace(OLD_GZ_NAME, Path(manifest["packed"]["path"]).name)
    text = text.replace(f"version: '{OLD_PACKED_VERSION}'", f"version: '{new_version}'")
    index.write_text(text, encoding="utf-8")

    installer = REPO / "maintenance" / "install_1_9_6_pre.py"
    inst = installer.read_text(encoding="utf-8")
    inst = inst.replace(OLD_GZ_NAME, Path(manifest["packed"]["path"]).name)
    old_known = """KNOWN_SCRIPT = {
    # previous live 1.9.5 card script, plus this pre runtime
    '8d1dc8575857f49134efa051666ea571b6debd18b884eb856adacdccef7f1280',
    meta['card']['script_sha256'],
}"""
    new_known = """KNOWN_SCRIPT = {
    # previous live 1.9.5 card script, the 1.9.6-pre card before this alignment patch, and the current card
    '8d1dc8575857f49134efa051666ea571b6debd18b884eb856adacdccef7f1280',
    '6ba8549979c7cff86925d33c5e8897366b4d6dbfba369e53ab4cab2ecd14e1b4',
    meta['card']['script_sha256'],
}"""
    if old_known not in inst:
        raise SystemExit("install script KNOWN_SCRIPT block not found")
    installer.write_text(inst.replace(old_known, new_known, 1), encoding="utf-8")

    mjs_path = REPO / "runtime-v1.9.6-pre.mjs"
    mjs = mjs_path.read_text(encoding="utf-8")
    if mjs.count(OLD_PACKED_VERSION) != 1:
        raise SystemExit(f"expected one {OLD_PACKED_VERSION} in runtime mjs, found {mjs.count(OLD_PACKED_VERSION)}")
    mjs = mjs.replace(OLD_PACKED_VERSION, new_version, 1)
    mjs_path.write_text(mjs, encoding="utf-8")
    if hashlib.sha256(mjs.encode()).hexdigest() != script_sha:
        raise SystemExit("script sha drift while stamping runtime")

    card_path = REPO / "cards" / "ark-story-v1.9.6-pre.png"
    raw = card_path.read_bytes()
    card = read_card(raw)
    data = card.get("data", card)
    script = next(item for item in data["extensions"]["tavern_helper"]["scripts"] if item["name"].startswith("ARK_UI"))
    current = hashlib.sha256(script["content"].encode()).hexdigest()
    if current != OLD_SCRIPT_SHA:
        raise SystemExit(f"card script hash {current} != {OLD_SCRIPT_SHA}")
    script["content"] = mjs
    card_path.write_bytes(write_card(raw, card))
    written = hashlib.sha256(card_path.read_bytes()).hexdigest()
    if written != card_sha:
        raise SystemExit("card sha drift while stamping card")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)

    data = load_json(RUNTIME_PATH)
    bundle = load_json(MAP_PATH)
    before_routes = {route["route_id"] for route in data["routes"]["routes"]}
    before_scenes = {node["scene_id"] for node in data["corpus"]["nodes"] if node.get("scene_id")}
    before_nodes = {node["node_id"] for node in data["corpus"]["nodes"]}
    sources = attach_texts(data)
    nodes_by_story = defaultdict(list)
    for node in data["corpus"]["nodes"]:
        nodes_by_story[node.get("story_id")].append(node)

    chapters = []
    blockers = []
    reconstructed = []
    total_before = 0
    total_placed = 0
    for mapping in bundle["mappings"]:
        sid = mapping["story_id"]
        source = sources.get(sid)
        if sid in RECONSTRUCTED_IDS:
            mismatch = verify_original(source) if source else "missing_source"
            reconstructed.append({
                **reconstructed_note(mapping, nodes_by_story[sid]),
                "original_check": mismatch or "exact_entry_match",
                "original": (source or {}).get("relative_path"),
            })
            if not mismatch:
                update_notes(
                    mapping, 0, 0, source.get("relative_path") or "",
                    extra="chapter_original_has_local_acts_but_no_official_stage_table",
                )
            else:
                blockers.append({"story_id": sid, "story_title": mapping["story_title"], "reason": mismatch})
            continue
        before = sum(1 for scene in mapping["scenes"] if scene.get("stage_code") == "_unaligned")
        if not before:
            continue
        total_before += before
        mismatch = verify_original(source) if source else "missing_source"
        if mismatch:
            blockers.append({"story_id": sid, "story_title": mapping["story_title"], "reason": mismatch})
            chapters.append({
                "story_id": sid,
                "story_title": mapping["story_title"],
                "before_unaligned": before,
                "placed": 0,
                "after_unaligned": before,
                "blocked": mismatch,
            })
            continue
        texts = entry_text_by_id(source)
        # node_body looks up entry_id; entry_text_by_id stored both sha and entry_id
        plan = plan_story(mapping, nodes_by_story[sid], texts)
        by_method = defaultdict(int)
        for decision in plan["decisions"]:
            by_method[decision["method"]] += 1
        placed = len(plan["decisions"])
        remain = len(plan["remaining"])
        if placed + remain != before:
            raise SystemExit(f"{mapping['story_title']} placed {placed} + remain {remain} != before {before}")
        chapters.append({
            "story_id": sid,
            "story_title": mapping["story_title"],
            "route_id": mapping["new_route_id"],
            "before_aligned": mapping["unique_playable_scenes"] - before,
            "before_unaligned": before,
            "placed": placed,
            "after_aligned": mapping["unique_playable_scenes"] - remain,
            "after_unaligned": remain,
            "unique": mapping["unique_playable_scenes"],
            "confidence": mapping.get("confidence"),
            "matching_method": mapping.get("matching_method"),
            "original": source.get("relative_path"),
            "by_method": dict(by_method),
            "decisions": plan["decisions"],
            "remaining": plan["remaining"],
        })
        total_placed += placed
        if args.apply and (placed or True):
            if placed:
                apply_decisions(mapping, plan["decisions"])
            update_notes(mapping, placed, remain, source.get("relative_path") or "")

    if args.apply:
        for chapter in chapters:
            if chapter.get("blocked") or not chapter["placed"]:
                mapping = next(item for item in bundle["mappings"] if item["story_id"] == chapter["story_id"])
                if not chapter.get("blocked"):
                    sync_route(data, mapping, set())
                continue
            mapping = next(item for item in bundle["mappings"] if item["story_id"] == chapter["story_id"])
            placed_ids = {item["scene_id"] for item in chapter["decisions"]}
            sync_route(data, mapping, placed_ids)
        for mapping in bundle["mappings"]:
            if mapping["story_id"] in RECONSTRUCTED_IDS and not any(
                b["story_id"] == mapping["story_id"] for b in blockers
            ):
                sync_route(data, mapping, set())
        after_routes = {route["route_id"] for route in data["routes"]["routes"]}
        after_scenes = {node["scene_id"] for node in data["corpus"]["nodes"] if node.get("scene_id")}
        after_nodes = {node["node_id"] for node in data["corpus"]["nodes"]}
        if after_routes != before_routes or after_scenes != before_scenes or after_nodes != before_nodes:
            raise SystemExit("route/scene/node id set changed")
        bundle["alignment_patch"] = {
            "generated_at": now_iso(),
            "originals": str(ORIGINALS),
            "before_unaligned": total_before,
            "placed": total_placed,
            "after_unaligned": total_before - total_placed,
            "method": "chapter_original_anchor_to_existing_official_stage",
            "blocked": blockers,
        }
        bundle["generated_at"] = bundle["alignment_patch"]["generated_at"]
        dump_pretty(MAP_PATH, bundle)
        dump_pretty(REPO / "scripts" / "fixtures" / "game_order_alignment_patch.json", {
            "schema": "ark_game_order_alignment_patch_v1",
            "generated_at": bundle["generated_at"],
            "originals": str(ORIGINALS),
            "before_unaligned": total_before,
            "placed": total_placed,
            "after_unaligned": total_before - total_placed,
            "chapters": [
                {k: v for k, v in chapter.items() if k != "decisions"} | {
                    "decisions": [
                        {kk: dd[kk] for kk in (
                            "scene_id", "node_id", "node_code", "chars", "method",
                            "anchor_scene_id", "place", "seq", "stage_code", "avg_tag", "stage_name",
                        ) if kk in dd}
                        for dd in chapter.get("decisions") or []
                    ],
                }
                for chapter in chapters
            ],
            "reconstructed": reconstructed,
            "blocked": blockers,
        })
        data["data_version"] = data.get("data_version")
        dump_compact(RUNTIME_PATH, data)
        new_version = compute_data_version(RUNTIME_PATH)
        data["data_version"] = new_version
        dump_compact(RUNTIME_PATH, data)
        stamped = compute_data_version(RUNTIME_PATH)
        if stamped != new_version:
            raise SystemExit(f"data_version unstable {new_version} != {stamped}")
        manifest = pack_runtime(RUNTIME_PATH, new_version, len(data["route_guides"]["guides"]))
        mjs = (REPO / "runtime-v1.9.6-pre.mjs").read_text(encoding="utf-8").replace(OLD_PACKED_VERSION, new_version, 1)
        script_sha = hashlib.sha256(mjs.encode()).hexdigest()
        # card sha is computed after write; precompute by writing to a buffer inside stamp
        card_path = REPO / "cards" / "ark-story-v1.9.6-pre.png"
        raw_card = card_path.read_bytes()
        card = read_card(raw_card)
        body = card.get("data", card)
        script = next(item for item in body["extensions"]["tavern_helper"]["scripts"] if item["name"].startswith("ARK_UI"))
        script["content"] = mjs
        new_card = write_card(raw_card, card)
        card_sha = hashlib.sha256(new_card).hexdigest()
        # stamp_release writes mjs and card again; pass hashes of that intended content
        stamp_release(new_version, manifest, script_sha, card_sha, len(new_card))
        meta_path = REPO / "scripts" / "fixtures" / "product_pack_meta.json"
        meta = load_json(meta_path)
        meta["data_version"] = new_version
        meta["manifest"] = manifest
        meta["alignment_patch"] = bundle["alignment_patch"]
        dump_pretty(meta_path, meta)
        print(json.dumps({
            "ok": True,
            "data_version": new_version,
            "build_id": manifest["build_id"],
            "placed": total_placed,
            "after_unaligned": total_before - total_placed,
            "packed": manifest["packed"]["path"],
            "packed_sha256": manifest["packed"]["sha256"],
            "runtime_sha256": manifest["sha256"],
            "script_sha256": script_sha,
            "card_sha256": card_sha,
        }, ensure_ascii=False))
        return 0

    summary = {
        "before_unaligned": total_before,
        "placed": total_placed,
        "after_unaligned": total_before - total_placed,
        "blocked": blockers,
        "chapters": [
            {k: chapter[k] for k in (
                "story_title", "before_unaligned", "placed", "after_unaligned", "confidence", "by_method", "original",
            ) if k in chapter}
            for chapter in chapters
        ],
        "reconstructed": reconstructed,
        "remaining_reasons": defaultdict_count(chapters),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


def defaultdict_count(chapters: list[dict]) -> dict:
    counts = defaultdict(int)
    for chapter in chapters:
        for item in chapter.get("remaining") or []:
            counts[item["reason"]] += 1
    return dict(counts)


if __name__ == "__main__":
    raise SystemExit(main())
