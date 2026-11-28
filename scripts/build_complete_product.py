#!/usr/bin/env python3
"""Build the complete 1.9.6-pre product: additive game-order fallback lines
for every chapter that can be ordered, safe display/label cleanup, no-local-script
isolation flags, and an installable package.

Deterministic. Zero model API calls. Never rewrites existing route_id / scene_id /
node_id. Never touches domestic production or GitHub main.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import shutil
import statistics
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from audit_story_lines import (  # noqa: E402
    AM_NEW_DISPLAY,
    AM_OLD_DISPLAY,
    AM_ROUTE_ID,
    DEFAULT_ID_INVENTORY,
    DEFAULT_MAPPING,
    DEFAULT_RUNTIME,
    NO_LOCAL_SCRIPT_SOURCE,
    SNOWFIELD_ROUTE_ID,
    SPEAK_RATIO_THRESHOLD,
    SHINGLE_N,
    TL_STORY_ID,
    TL_UNASSIGNED_ID,
    act_count,
    actor_alias_map,
    actor_name_map,
    apply_am_display_fix,
    claimed_names_from_label,
    classify_routes,
    compute_data_version,
    corpus_line_by_route,
    dump_compact,
    dump_pretty,
    entry_texts,
    existing_id_sets,
    is_no_local_script,
    load_json,
    mark_suspect_routes,
    natural_key,
    node_text,
    nodes_for_story,
    occurrence_topo_ranks,
    parse_official_avg,
    route_by_id,
    route_speaker_stats,
    routes_of,
    sha256_file,
    shingles,
    speaker_hit,
    stories_of,
    story_by_id,
)

VERSION = "1.9.6-pre2"
LINE_CODE = "game_order"
DISPLAY_LABEL = "年表线（游戏关卡顺序）"
FIXTURES = Path(__file__).resolve().parent / "fixtures"
DEFAULT_REVIEW = FIXTURES / "official_review_index.json"
DEFAULT_OFFICIAL_DIR = Path("/tmp/ark-official/stories")
USAGE_PACKAGE_CANDIDATES = [
    Path("/opt/arknights/明日方舟_使用包"),
    Path("/workspace/明日方舟_使用包"),
    Path("/workspace/uploads/明日方舟_使用包"),
]
MAINLINE_COMPILATION_ID = "story_f922fe9053"
ELITE_OP_STORY_ID = "story_8d59ecb165"
GENERIC_SPEAKERS = {
    "乌萨斯民众", "整合运动成员", "狱警", "狱警A", "佣兵", "雇佣兵", "萨卡兹雇佣兵",
    "罗德岛干员", "镇民", "村民", "士兵", "卫兵", "群众", "路人", "幕简介",
}


def now_iso() -> str:
    return datetime.now(timezone(timedelta_gmt8())).isoformat(timespec="seconds")


def timedelta_gmt8():
    from datetime import timedelta
    return timedelta(hours=8)


def game_order_id(story_id: str) -> str:
    return f"{story_id}:route:{LINE_CODE}"


def find_usage_package() -> Path | None:
    for p in USAGE_PACKAGE_CANDIDATES:
        if p.exists():
            return p
    return None


def load_review_index(path: Path) -> dict:
    raw = load_json(path)
    if "chapters" in raw:
        return raw
    # raw story_review_table.json fallback
    chapters = []
    title_to = {}
    for k, v in raw.items():
        if not isinstance(v, dict) or "infoUnlockDatas" not in v:
            continue
        segs = []
        for i, info in enumerate(v.get("infoUnlockDatas") or [], start=1):
            segs.append({
                "seq": i,
                "story_id": info.get("storyId"),
                "story_sort": info.get("storySort"),
                "story_dependence": info.get("storyDependence"),
                "stage_code": info.get("storyCode") or "",
                "avg_tag": info.get("avgTag") or "",
                "stage_name": info.get("storyName") or "",
                "story_txt": info.get("storyTxt") or "",
            })
        rec = {
            "review_id": k,
            "title": v.get("name"),
            "entry_type": v.get("entryType"),
            "act_type": v.get("actType"),
            "segments": segs,
        }
        chapters.append(rec)
        if rec["title"]:
            title_to[rec["title"]] = k
    return {"chapters": chapters, "title_to_review_id": title_to}


def official_txt_path(official_dir: Path, story_txt: str) -> Path:
    # downloaded layout: /tmp/ark-official/stories/{story_txt}.txt
    p = official_dir / (story_txt + ".txt")
    if p.is_file():
        return p
    # alternate: official_dir / basename
    alt = official_dir / (Path(story_txt).name + ".txt")
    return alt


def load_official_body(official_dir: Path | None, story_txt: str, cache: dict) -> str:
    if not story_txt:
        return ""
    if story_txt in cache:
        return cache[story_txt]
    body = ""
    if official_dir:
        path = official_txt_path(official_dir, story_txt)
        if path.is_file():
            _names, body = parse_official_avg(path)
    cache[story_txt] = body
    return body


def unique_playable_nodes(data: dict, story_id: str) -> list[dict]:
    nodes = nodes_for_story(data, story_id, playable_only=True)
    out = []
    seen = set()
    for n in nodes:
        sid = n.get("scene_id")
        if not sid or sid in seen:
            continue
        seen.add(sid)
        out.append(n)
    return out


def slim_assignment(a: dict) -> dict:
    keep = (
        "scene_id", "node_id", "node_code", "act_name", "line_code", "speakers",
        "source_locator", "chars", "seq", "stage_code", "avg_tag", "stage_name",
        "official_story_txt", "coverage", "jaccard", "shingle_overlap",
        "margin_vs_second", "second_stage_code", "second_avg_tag", "second_coverage",
        "topo_rank", "old_route_ids", "confidence",
    )
    return {k: a[k] for k in keep if k in a}


def stage_tables_from(assignments: list[dict]) -> list[dict]:
    grouped = defaultdict(list)
    for a in assignments:
        grouped[(a["seq"], a.get("stage_code") or "", a.get("avg_tag") or "", a.get("stage_name") or "")].append(a)
    tables = []
    for key in sorted(grouped):
        seq, code, tag, name = key
        items = grouped[key]
        covs = [x.get("coverage") for x in items if isinstance(x.get("coverage"), (int, float))]
        tables.append({
            "seq": seq,
            "stage_code": code,
            "avg_tag": tag,
            "stage_name": name,
            "scene_count": len(items),
            "min_coverage": min(covs) if covs else None,
            "max_coverage": max(covs) if covs else None,
            "low_margin_count": sum(1 for x in items if (x.get("margin_vs_second") or 1) < 0.05),
            "scene_ids": [x["scene_id"] for x in items],
            "node_codes": [x.get("node_code") for x in items],
        })
    return tables


def confidence_for(assignments: list[dict], method: str) -> str:
    if method in {"official_review_order", "official_corpus_order", "frozen_existing"}:
        return "high"
    if method == "local_unique_scene_order":
        return "reconstructed"
    if not assignments:
        return "none"
    covs = [a.get("coverage") for a in assignments if isinstance(a.get("coverage"), (int, float)) and (a.get("stage_code") != "_unaligned")]
    if not covs:
        return "low"
    weak = sum(1 for a in assignments if (a.get("coverage") or 0) < 0.10 or (a.get("margin_vs_second") or 1) < 0.02)
    mn = min(covs)
    if mn >= 0.25 and weak / len(assignments) <= 0.10:
        return "high"
    if mn >= 0.10 or weak / len(assignments) <= 0.25:
        return "medium"
    return "low"


def review_for_title(review: dict, title: str) -> dict | None:
    tid = (review.get("title_to_review_id") or {}).get(title)
    if not tid:
        return None
    for ch in review["chapters"]:
        if ch["review_id"] == tid:
            return ch
    return None


def build_aligned_mapping(
    data: dict,
    story: dict,
    segments: list[dict],
    official_dir: Path | None,
    text_cache: dict,
    method: str,
    notes: list[str],
) -> dict:
    story_id = story["story_id"]
    nodes = unique_playable_nodes(data, story_id)
    texts = entry_texts(data, story_id)
    ranks = occurrence_topo_ranks(data, story_id)
    routes = [r for r in routes_of(data) if r["story_id"] == story_id and r.get("line_code") != LINE_CODE]
    scene_to_old = defaultdict(list)
    for r in routes:
        for sid in r.get("ordered_scene_ids") or []:
            scene_to_old[sid].append(r["route_id"])

    official = []
    missing = []
    for seg in segments:
        body = load_official_body(official_dir, seg.get("story_txt") or "", text_cache)
        if not body:
            missing.append(seg.get("story_txt") or seg.get("stage_code") or "?")
            official.append({**seg, "shingles": set(), "empty": True})
        else:
            official.append({**seg, "shingles": shingles(body), "empty": False})
    usable = [s for s in official if not s["empty"]]
    if not usable:
        raise ValueError("no official segment texts")
    if missing:
        notes.append(f"missing_official_texts:{len(missing)}")

    assignments = []
    for n in nodes:
        sid = n["scene_id"]
        body = node_text(n, texts)
        sh = shingles(body)
        scored = []
        for seg in usable:
            inter = len(sh & seg["shingles"])
            cov = inter / len(sh) if sh else 0.0
            jac = inter / len(sh | seg["shingles"]) if (sh or seg["shingles"]) else 0.0
            scored.append((cov, jac, inter, seg))
        scored.sort(key=lambda x: (x[0], x[1], x[2]), reverse=True)
        best = scored[0]
        second = scored[1] if len(scored) > 1 else (0, 0, 0, None)
        cov, jac, inter, seg = best
        margin = cov - second[0]
        unaligned = (not sh) or cov <= 0.0
        if unaligned:
            last_seq = max(s["seq"] for s in official)
            seg = {
                "seq": last_seq + 1,
                "stage_code": "_unaligned",
                "avg_tag": "",
                "stage_name": "未能对齐到官方关卡的本地场景",
                "story_txt": "",
            }
            if "has_unaligned_local_scenes" not in notes:
                notes.append("has_unaligned_local_scenes")
        assignments.append({
            "scene_id": sid,
            "node_id": n["node_id"],
            "node_code": n.get("node_code"),
            "act_name": n.get("act_name"),
            "line_code": n.get("line_code"),
            "speakers": list(n.get("speakers") or []),
            "source_locator": n.get("source_locator"),
            "chars": n.get("chars") or len(body),
            "seq": seg["seq"],
            "stage_code": seg.get("stage_code") or "",
            "avg_tag": seg.get("avg_tag") or "",
            "stage_name": seg.get("stage_name") or "",
            "official_story_txt": seg.get("story_txt") or "",
            "coverage": round(cov, 6),
            "jaccard": round(jac, 6),
            "shingle_overlap": inter,
            "margin_vs_second": round(margin, 6),
            "second_stage_code": second[3].get("stage_code") if second[3] else None,
            "second_avg_tag": second[3].get("avg_tag") if second[3] else None,
            "second_coverage": round(second[0], 6) if second[3] else None,
            "topo_rank": ranks.get(n.get("node_code"), 10**9),
            "old_route_ids": scene_to_old.get(sid, []),
        })

    assignments.sort(key=lambda a: (a["seq"], a.get("topo_rank", 10**9), natural_key(a.get("node_code") or "")))
    return finalize_mapping(story, assignments, segments, method, notes, routes)


def match_official_nodes_to_review(data: dict, story: dict, segments: list[dict], notes: list[str]) -> dict:
    story_id = story["story_id"]
    nodes = unique_playable_nodes(data, story_id)
    routes = [r for r in routes_of(data) if r["story_id"] == story_id and r.get("line_code") != LINE_CODE]
    scene_to_old = defaultdict(list)
    for r in routes:
        for sid in r.get("ordered_scene_ids") or []:
            scene_to_old[sid].append(r["route_id"])

    def txt_key(p: str | None) -> str:
        if not p:
            return ""
        s = p.replace("\\", "/")
        if s.endswith(".txt"):
            s = s[:-4]
        # strip leading zh_CN/gamedata/story/
        for prefix in ("zh_CN/gamedata/story/", "gamedata/story/"):
            if s.startswith(prefix):
                s = s[len(prefix):]
        return s

    by_txt = {txt_key(seg.get("story_txt")): seg for seg in segments if seg.get("story_txt")}
    used_txt = set()
    assigned = []
    leftover = []
    for n in nodes:
        key = txt_key(n.get("source_file") or "")
        if not key and n.get("source_locator"):
            key = txt_key(n.get("source_locator"))
        seg = by_txt.get(key)
        if seg:
            used_txt.add(key)
            assigned.append((n, seg, 1.0))
        else:
            leftover.append(n)

    leftover_segs = [s for s in segments if txt_key(s.get("story_txt")) not in used_txt]
    # Pair leftovers by current node order vs leftover segment seq
    leftover.sort(key=lambda n: natural_key(str(n.get("node_id") or n.get("node_code") or "")))
    leftover_segs.sort(key=lambda s: s["seq"])
    if leftover and leftover_segs and len(leftover) == len(leftover_segs):
        for n, seg in zip(leftover, leftover_segs):
            assigned.append((n, seg, 0.5))
        leftover = []
        leftover_segs = []
        notes.append("paired_unmatched_official_nodes_1to1")
    elif leftover and leftover_segs:
        # assign by order as far as possible, rest get synthetic seq after last / before first
        paired = min(len(leftover), len(leftover_segs))
        for i in range(paired):
            assigned.append((leftover[i], leftover_segs[i], 0.3))
        leftover = leftover[paired:]
        leftover_segs = leftover_segs[paired:]
        notes.append("partial_pair_unmatched_official_nodes")
    if leftover:
        base = max((s["seq"] for s in segments), default=0)
        for i, n in enumerate(leftover, start=1):
            syn = {
                "seq": base + i,
                "stage_code": n.get("node_code") or f"EXTRA-{i}",
                "avg_tag": "",
                "stage_name": n.get("title") or n.get("act_name") or n.get("header_text") or "未对齐官方段",
                "story_txt": n.get("source_file") or "",
            }
            assigned.append((n, syn, 0.0))
        notes.append(f"appended_unmatched_official_nodes:{len(leftover)}")

    assignments = []
    for n, seg, cov in assigned:
        assignments.append({
            "scene_id": n["scene_id"],
            "node_id": n["node_id"],
            "node_code": n.get("node_code"),
            "act_name": n.get("act_name"),
            "line_code": n.get("line_code"),
            "speakers": list(n.get("speakers") or []),
            "source_locator": n.get("source_locator") or n.get("source_file"),
            "chars": n.get("chars"),
            "seq": seg["seq"],
            "stage_code": seg.get("stage_code") or "",
            "avg_tag": seg.get("avg_tag") or "",
            "stage_name": seg.get("stage_name") or "",
            "official_story_txt": seg.get("story_txt") or "",
            "coverage": cov,
            "jaccard": cov,
            "shingle_overlap": None,
            "margin_vs_second": 1.0 if cov >= 1.0 else 0.0,
            "second_stage_code": None,
            "second_avg_tag": None,
            "second_coverage": None,
            "topo_rank": 0,
            "old_route_ids": scene_to_old.get(n["scene_id"], []),
        })
    assignments.sort(key=lambda a: (a["seq"], natural_key(a.get("node_code") or a.get("node_id") or "")))
    method = "official_review_order" if segments else "official_corpus_order"
    return finalize_mapping(story, assignments, segments, method, notes, routes)


def unique_scene_fallback(data: dict, story: dict, reason: str, notes: list[str]) -> dict:
    """Reconstruct order from unique playable scenes when no official table exists.

    Prefer an existing full-script / sole route order if it already covers every
    unique playable scene with no duplicates; otherwise use topology + node code.
    """
    story_id = story["story_id"]
    nodes = unique_playable_nodes(data, story_id)
    by_scene = {n["scene_id"]: n for n in nodes}
    routes = [r for r in routes_of(data) if r["story_id"] == story_id and r.get("line_code") != LINE_CODE]
    chosen = None
    for r in routes:
        ids = r.get("ordered_scene_ids") or []
        if ids and len(ids) == len(set(ids)) and set(ids) == set(by_scene):
            chosen = ids
            notes.append(f"copied_unique_order_from:{r['route_id']}")
            break
    if chosen is None:
        ranks = occurrence_topo_ranks(data, story_id)
        ordered = sorted(nodes, key=lambda n: (ranks.get(n.get("node_code"), 10**9), natural_key(n.get("node_code") or "")))
        chosen = [n["scene_id"] for n in ordered]
        notes.append("ordered_by_topology_and_node_code")
    assignments = []
    for i, sid in enumerate(chosen, start=1):
        n = by_scene[sid]
        assignments.append({
            "scene_id": sid,
            "node_id": n["node_id"],
            "node_code": n.get("node_code"),
            "act_name": n.get("act_name"),
            "line_code": n.get("line_code"),
            "speakers": list(n.get("speakers") or []),
            "source_locator": n.get("source_locator"),
            "chars": n.get("chars"),
            "seq": i,
            "stage_code": n.get("node_code") or f"N{i}",
            "avg_tag": "",
            "stage_name": n.get("act_name") or n.get("title") or "",
            "official_story_txt": "",
            "coverage": None,
            "jaccard": None,
            "shingle_overlap": None,
            "margin_vs_second": None,
            "second_stage_code": None,
            "second_avg_tag": None,
            "second_coverage": None,
            "topo_rank": i,
            "old_route_ids": [r["route_id"] for r in routes if sid in (r.get("ordered_scene_ids") or [])],
        })
    notes.append(reason)
    return finalize_mapping(story, assignments, [], "local_unique_scene_order", notes, routes)


def finalize_mapping(story, assignments, segments, method, notes, routes) -> dict:
    scene_ids = [a["scene_id"] for a in assignments]
    if len(scene_ids) != len(set(scene_ids)):
        raise ValueError(f"duplicate scene_id in {story['story_id']}")
    seqs = [a["seq"] for a in assignments]
    if seqs != sorted(seqs):
        raise ValueError(f"non-monotonic stages in {story['story_id']}")
    conf = confidence_for(assignments, method)
    mapping = {
        "schema": "ark_game_order_v1",
        "story_id": story["story_id"],
        "story_title": story["title"],
        "story_category": story.get("category"),
        "new_route_id": game_order_id(story["story_id"]),
        "line_code": LINE_CODE,
        "existing_route_count": len(routes),
        "unique_playable_scenes": len(assignments),
        "official_segments": len(segments),
        "order_source": "game_chronological_fallback",
        "matching_method": method,
        "confidence": conf,
        "notes": notes,
        "ordered_scene_ids": scene_ids,
        "ordered_node_ids": [a["node_id"] for a in assignments],
        "scenes": [slim_assignment(a) for a in assignments],
        "stages": stage_tables_from(assignments),
    }
    covs = [a["coverage"] for a in assignments if isinstance(a.get("coverage"), (int, float))]
    if covs:
        mapping["min_coverage"] = min(covs)
        mapping["median_coverage"] = statistics.median(covs)
        mapping["low_margin_count"] = sum(1 for a in assignments if (a.get("margin_vs_second") or 1) < 0.05)
    return mapping


def compilation_segments(review: dict) -> list[dict]:
    segs = []
    seq = 1
    for ep in range(0, 6):
        ch = next((c for c in review["chapters"] if c["review_id"] == f"main_{ep}"), None)
        if not ch:
            continue
        for seg in ch["segments"]:
            item = dict(seg)
            item["seq"] = seq
            item["stage_name"] = f"{ch['title']}／{seg.get('stage_name') or ''}".rstrip("／")
            segs.append(item)
            seq += 1
    return segs


def freeze_tl_mapping(data: dict) -> dict:
    baked = load_json(DEFAULT_MAPPING)
    route = route_by_id(data).get(baked["new_route_id"])
    if not route:
        raise SystemExit("existing TL game_order route missing")
    if route["ordered_scene_ids"] != baked["ordered_scene_ids"]:
        raise SystemExit("existing TL game_order order diverges from frozen mapping")
    return {
        **{k: baked[k] for k in (
            "schema", "story_id", "story_title", "new_route_id", "line_code",
            "existing_route_count", "unique_playable_scenes", "official_segments",
            "order_source", "matching_method", "ordered_scene_ids", "ordered_node_ids",
        ) if k in baked},
        "story_category": "活动",
        "matching_method": "frozen_existing",
        "confidence": "high",
        "notes": ["preserved_existing_tl_game_order"],
        "scenes": baked["scenes"],
        "stages": baked.get("stages") or [],
        "min_coverage": min(x["coverage"] for x in baked["scenes"]),
    }


def build_all_mappings(data: dict, review: dict, official_dir: Path | None) -> tuple[list[dict], list[dict]]:
    text_cache: dict[str, str] = {}
    mappings = []
    blocked = []
    official_src_ids = {
        s["story_id"]
        for s in data["corpus"]["sources"]
        if s.get("category") == "官方补充" or str(s.get("source_id") or "").startswith("src_official_")
    }

    for story in stories_of(data):
        sid = story["story_id"]
        title = story["title"]
        notes: list[str] = []
        try:
            if sid == TL_STORY_ID:
                mappings.append(freeze_tl_mapping(data))
                continue
            rev = review_for_title(review, title)
            has_official_src = sid in official_src_ids or sid.startswith("official_")
            if sid == MAINLINE_COMPILATION_ID:
                segs = compilation_segments(review)
                if not segs:
                    raise ValueError("main_0..main_5 review segments missing")
                notes.append("aligned_to_mainline_episodes_0_to_5")
                mappings.append(build_aligned_mapping(
                    data, story, segs, official_dir, text_cache,
                    "official_text_alignment_compilation", notes,
                ))
                continue
            if has_official_src:
                segs = list(rev["segments"]) if rev else []
                if not segs:
                    # fabricate segments from official nodes in source order
                    nodes = unique_playable_nodes(data, sid)
                    segs = []
                    for i, n in enumerate(nodes, start=1):
                        segs.append({
                            "seq": i,
                            "stage_code": n.get("node_code") or f"S{i}",
                            "avg_tag": "",
                            "stage_name": n.get("title") or n.get("act_name") or "",
                            "story_txt": (n.get("source_file") or "").replace("zh_CN/gamedata/story/", "").removesuffix(".txt"),
                        })
                    notes.append("no_review_table_used_official_corpus_order")
                mappings.append(match_official_nodes_to_review(data, story, segs, notes))
                continue
            if rev and official_dir:
                mappings.append(build_aligned_mapping(
                    data, story, list(rev["segments"]), official_dir, text_cache,
                    "official_text_alignment", notes,
                ))
                continue
            if rev and not official_dir:
                blocked.append({
                    "story_id": sid, "story_title": title, "reason":
                    "official_review_table_present_but_official_avg_texts_unavailable",
                })
                continue
            # no review table
            if sid == SNOWFIELD_ROUTE_ID.split(":route:")[0]:
                mappings.append(unique_scene_fallback(
                    data, story, "local_custom_snowfield_no_official_stage_table", notes,
                ))
                continue
            if sid == ELITE_OP_STORY_ID:
                mappings.append(unique_scene_fallback(
                    data, story, "elite_ops_no_official_review_table", notes,
                ))
                continue
            blocked.append({
                "story_id": sid, "story_title": title,
                "reason": "no_official_stage_order_and_unique_scene_order_not_auto_accepted",
            })
        except Exception as exc:
            blocked.append({
                "story_id": sid, "story_title": title, "reason": f"builder_error:{exc}",
            })
    return mappings, blocked


def _reuse_summaries_generic(data: dict, mapping: dict) -> dict:
    by_scene = {}
    for route in data["player_summaries"]["routes"]:
        if route.get("story_id") != mapping["story_id"]:
            continue
        if route.get("route_id") == mapping["new_route_id"]:
            continue
        for e in route.get("entries") or []:
            sid = e.get("scene_id")
            if sid and sid not in by_scene:
                by_scene[sid] = e
    entries = []
    for i, item in enumerate(mapping["scenes"], start=1):
        src = by_scene.get(item["scene_id"])
        title = f"{item.get('stage_code') or ''} {item.get('avg_tag') or ''} {item.get('stage_name') or ''}".strip()
        if not src:
            entries.append({
                "order": i,
                "code": item.get("node_code"),
                "node_id": item["node_id"],
                "scene_id": item["scene_id"],
                "title": title,
                "summary": "",
                "summary_chars": 0,
                "source_locator": item.get("source_locator") or "",
                "source_status": "missing_reusable_summary",
                "notes": "new chrono act; no existing scene summary to reuse",
            })
            continue
        e = dict(src)
        e["order"] = i
        e["code"] = item.get("node_code") or e.get("code")
        e["node_id"] = item["node_id"]
        e["scene_id"] = item["scene_id"]
        if title:
            e["title"] = title
        entries.append(e)
    return {
        "route_id": mapping["new_route_id"],
        "story_id": mapping["story_id"],
        "line_code": LINE_CODE,
        "entries": entries,
    }


def _build_guide_generic(data: dict, mapping: dict) -> dict:
    story_id = mapping["story_id"]
    existing = next((g for g in data["route_guides"]["guides"] if g.get("story_id") == story_id), None)
    chapter = dict((existing or {}).get("chapter") or {})
    chapter.setdefault("title", mapping["story_title"])
    acts_by_node = {}
    briefs_by_node = {}
    if existing:
        for act in existing.get("acts") or []:
            if act.get("node_id"):
                acts_by_node[act["node_id"]] = act
        for br in existing.get("act_briefs") or []:
            if br.get("node_id"):
                briefs_by_node[br["node_id"]] = br
    acts = []
    briefs = []
    for i, item in enumerate(mapping["scenes"]):
        nid = item["node_id"]
        nxt = mapping["scenes"][i + 1].get("node_code") if i + 1 < len(mapping["scenes"]) else None
        src_act = acts_by_node.get(nid)
        if src_act:
            act = dict(src_act)
            act["next_node_code"] = nxt
            acts.append(act)
        else:
            acts.append({
                "node_id": nid,
                "node_code": item.get("node_code"),
                "act_name": f"{item.get('stage_code') or ''} {item.get('avg_tag') or ''} {item.get('stage_name') or ''}".strip(),
                "completion": None,
                "cast": item.get("speakers") or [],
                "next_node_code": nxt,
                "source": item.get("source_locator"),
                "key_dialogues": [],
                "key_actions": [],
            })
        src_br = briefs_by_node.get(nid)
        if src_br:
            briefs.append(dict(src_br))
        else:
            briefs.append({
                "node_id": nid,
                "code": item.get("node_code"),
                "title": f"{item.get('stage_code') or ''} {item.get('avg_tag') or ''} {item.get('stage_name') or ''}".strip(),
            })
    header = [
        "# 本线剧情指导（全线要点；具体演出以当段原文为准）",
        f"章：{mapping['story_title']}｜角色线：{DISPLAY_LABEL}",
        "幕序：按官方关卡回顾表顺序（行动前／行动后／幕间）排列既有唯一场景。",
        "说明：本线是新增保底线；旧路线 ID 不变。本指导是全线要点摘录；具体演出以本轮注入的【当前段剧情原文】为准。",
        f"材料：完整原文 {len(mapping['scenes'])} 幕（复用既有 scene_id / node_id）",
        "推进：按本指导的关卡顺序推进，不按旧视角线编号跳幕；交汇节点只结算一次。 玩家插话、观察、提问时保留现场，不推进段落游标。",
    ]
    rid = mapping["new_route_id"]
    return {
        "guide_id": f"guide:{rid}",
        "route_id": rid,
        "story_id": story_id,
        "line_code": LINE_CODE,
        "chapter": chapter,
        "status": "年表保底线",
        "order": list(mapping["ordered_node_ids"]),
        "shared_nodes": [],
        "branches": [],
        "header_lines": header,
        "act_briefs": briefs,
        "performance_notes": [],
        "acts": acts,
        "display_label": DISPLAY_LABEL,
    }


def apply_game_order_routes(data: dict, mappings: list[dict]) -> dict:
    notes = []
    existing = route_by_id(data)
    # Never refresh the frozen TL route from a rebuilt mapping; leave it in place.
    to_apply = [m for m in mappings if m["story_id"] != TL_STORY_ID or m["new_route_id"] not in existing]
    # If TL already present, still skip it
    to_apply = [m for m in mappings if not (m["story_id"] == TL_STORY_ID and m["new_route_id"] in existing)]

    allowed = {m["new_route_id"] for m in mappings}
    routes = routes_of(data)
    new_routes_by_story = {m["story_id"]: m for m in mappings}

    kept = []
    for r in routes:
        if r.get("line_code") == LINE_CODE and r["route_id"] not in allowed and r["route_id"] != game_order_id(TL_STORY_ID):
            raise SystemExit(f"unexpected game_order route {r['route_id']}")
        kept.append(r)
    routes[:] = kept

    for mapping in mappings:
        rid = mapping["new_route_id"]
        if mapping["story_id"] == TL_STORY_ID and rid in route_by_id(data):
            continue
        new_route = {
            "route_id": rid,
            "story_id": mapping["story_id"],
            "line_code": LINE_CODE,
            "focus_actor_ids": [],
            "ordered_scene_ids": list(mapping["ordered_scene_ids"]),
            "node_count": len(mapping["ordered_scene_ids"]),
            "cross_route_inputs": [],
            "shared_scene_ids": [],
            "quality": "phase_c_draft" if mapping.get("confidence") != "high" else "phase_c_official",
            "source_kind": "phase_c_chrono_fallback",
            "legacy_order": [],
            "order_source": "game_chronological_fallback",
            "display_label": DISPLAY_LABEL,
            "display_label_basis": mapping.get("matching_method") or "official_stage_order",
            "attribution_suspect": False,
            "pending_human_stage_review": mapping.get("confidence") != "high",
            "chrono_confidence": mapping.get("confidence"),
            "chrono_notes": mapping.get("notes") or [],
        }
        routes[:] = [r for r in routes if r["route_id"] != rid] + [new_route]
        notes.append(f"added {rid} scenes={len(mapping['ordered_scene_ids'])} conf={mapping.get('confidence')}")

        for story in stories_of(data):
            if story["story_id"] != mapping["story_id"]:
                continue
            ids = [x for x in (story.get("route_ids") or []) if x != rid]
            ids.append(rid)
            story["route_ids"] = ids

        nav = data.get("navigation") or {}
        for bucket in (nav.get("entries") or [], nav.get("supplementary") or []):
            for entry in bucket:
                if entry.get("story_id") != mapping["story_id"]:
                    continue
                ids = [x for x in (entry.get("route_ids") or []) if x != rid]
                ids.append(rid)
                entry["route_ids"] = ids

        clines = data["corpus"]["lines"]
        clines[:] = [ln for ln in clines if ln.get("route_id") != rid]
        clines.append({
            "route_id": rid,
            "story_id": mapping["story_id"],
            "line_code": LINE_CODE,
            "source": "game_chronological_fallback",
            "ordered_node_ids": list(mapping["ordered_node_ids"]),
            "ordered_scene_ids": list(mapping["ordered_scene_ids"]),
            "ordered_legacy_scene_ids": list(mapping["ordered_scene_ids"]),
            "ordered_codes": [s.get("node_code") for s in mapping["scenes"]],
            "logic_rule_count": 0,
            "pending": mapping.get("confidence") != "high",
            "status": "年表保底线",
            "is_full_script": True,
        })

        guides = data["route_guides"]["guides"]
        guides[:] = [g for g in guides if g.get("route_id") != rid]
        guides.append(_build_guide_generic(data, mapping))

        uids = data.setdefault("route_guide_uids", {})
        uids.pop(rid, None)

        ps_routes = data["player_summaries"]["routes"]
        ps_routes[:] = [r for r in ps_routes if r.get("route_id") != rid]
        ps_routes.append(_reuse_summaries_generic(data, mapping))

    # bookkeeping
    guides = data["route_guides"]["guides"]
    cov = data["route_guides"].setdefault("coverage", {})
    cov["lines"] = len(guides)
    cov["chapters"] = len({g.get("story_id") for g in guides})
    if isinstance(data.get("guide_meta"), dict) and "lines" in data["guide_meta"]:
        data["guide_meta"]["lines"] = len(guides)
    clines = data["corpus"]["lines"]
    cc = (data.get("corpus") or {}).get("coverage") or {}
    if "lines" in cc:
        cc["lines"] = len(clines)
    cmc = (data.get("corpus_meta") or {}).get("coverage") or {}
    if "lines" in cmc:
        cmc["lines"] = len(clines)
    return {"notes": notes, "applied": len(notes)}


def mark_no_local_script_isolation(data: dict) -> int:
    lines = corpus_line_by_route(data)
    n = 0
    for r in routes_of(data):
        cl = lines.get(r["route_id"])
        if is_no_local_script(cl, r):
            r["no_local_script"] = True
            r["exclude_from_llm_queue"] = True
            r["llm_queue_exclusion_reason"] = NO_LOCAL_SCRIPT_SOURCE
            n += 1
        elif r.get("line_code") == LINE_CODE:
            r["exclude_from_llm_queue"] = True
            r["llm_queue_exclusion_reason"] = "game_order_is_deterministic_fallback"
    return n


def split_label_suffix(label: str) -> tuple[str, str]:
    m = re.search(r"( · 分线\d+)$", label or "")
    if m:
        return (label[: m.start()], m.group(1))
    return (label or "", "")


def is_named_character(name: str) -> bool:
    if not name or name in GENERIC_SPEAKERS:
        return False
    if name in {"独立片段", "补充片段", "完整剧情线", "年表线"}:
        return False
    if len(name) < 2:
        return False
    return True


def propose_display_cleanup(data: dict, audit: dict) -> list[dict]:
    names = actor_name_map(data)
    aliases = actor_alias_map(data)
    scene_nodes = {}
    for n in data["corpus"]["nodes"]:
        sid = n.get("scene_id")
        if sid and (sid not in scene_nodes or (n.get("playable") and not scene_nodes[sid].get("playable"))):
            scene_nodes[sid] = n
    stories = story_by_id(data)
    unique_counts = defaultdict(int)
    for n in data["corpus"]["nodes"]:
        if n.get("playable") and n.get("scene_id"):
            unique_counts[n["story_id"]] += 0  # placeholder
    uniq = defaultdict(set)
    for n in data["corpus"]["nodes"]:
        if n.get("playable") and n.get("scene_id"):
            uniq[n["story_id"]].add(n["scene_id"])

    changes = []
    by = route_by_id(data)
    for row in audit["attribution_mismatches"]:
        rid = row["route_id"]
        r = by.get(rid)
        if not r:
            continue
        old = r.get("display_label") or ""
        # already corrected
        if rid == AM_ROUTE_ID:
            changes.append({
                "route_id": rid,
                "story_id": r["story_id"],
                "story_title": row.get("story_title"),
                "previous_display_label": r.get("display_label_previous") or AM_OLD_DISPLAY,
                "new_display_label": r.get("display_label") or AM_NEW_DISPLAY,
                "action": "kept_existing_verified_correction",
                "reason": "九 only speaks in AM1; already relabeled 阿米娅与陈线; not merged with snowfield",
            })
            continue
        if r.get("display_label_basis") == "speaker_attribution_correction" and r.get("display_label_previous"):
            changes.append({
                "route_id": rid,
                "story_id": r["story_id"],
                "story_title": row.get("story_title"),
                "previous_display_label": r.get("display_label_previous"),
                "new_display_label": r.get("display_label"),
                "action": "already_corrected",
                "reason": "display already has speaker_attribution_correction",
            })
            continue
        base, suffix = split_label_suffix(old)
        acts = r.get("ordered_scene_ids") or []
        n_unique = len(uniq.get(r["story_id"], ()))
        is_full_copy = bool(acts) and len(acts) == n_unique and (
            str(r.get("line_code") or "").startswith("official_focus") or ":route:official_focus:" in rid
        )
        stats = route_speaker_stats(r, scene_nodes, names, aliases)
        # speaker act ratios
        speaker_acts = Counter()
        for sid in acts:
            node = scene_nodes.get(sid) or {}
            for sp in set(node.get("speakers") or []):
                speaker_acts[sp] += 1
        n_acts = len(acts) or 1
        dominant = []
        for sp, c in speaker_acts.most_common():
            if not is_named_character(sp):
                continue
            ratio = c / n_acts
            if ratio >= 0.40:
                dominant.append((sp, ratio))
            elif ratio >= 0.25 and len(dominant) < 2:
                dominant.append((sp, ratio))
            if len(dominant) >= 2:
                break

        if is_full_copy:
            claimed = "、".join(stats.get("claimed_names") or claimed_names_from_label(base) or [base.rstrip("线")])
            new_base = f"{claimed}焦点标注（全章转写，非独立视角线）"
            new = new_base + suffix
            reason = "official_focus line repeats the full chapter scene list; label is a focus tag, not a POV route"
        elif dominant and dominant[0][1] >= 0.40:
            if len(dominant) >= 2 and dominant[1][1] >= 0.25:
                new_base = f"{dominant[0][0]}与{dominant[1][0]}线"
            else:
                new_base = f"{dominant[0][0]}线"
            new = f"{new_base}（原误标「{base}」）" + suffix
            reason = f"named label speaker appears in {stats['named_focus_speak_act_ratio']:.1%} of acts; dominant speakers used instead"
        else:
            tops = [sp for sp, _ in speaker_acts.most_common(3) if is_named_character(sp)]
            hint = "、".join(tops[:3]) if tops else "多人"
            new_base = f"综合线（原误标「{base}」；主要发言：{hint}）"
            new = new_base + suffix
            reason = f"named label speaker appears in {stats['named_focus_speak_act_ratio']:.1%} of acts; no single dominant speaker ≥40%"

        if new == old:
            changes.append({
                "route_id": rid, "story_id": r["story_id"], "story_title": row.get("story_title"),
                "previous_display_label": old, "new_display_label": old,
                "action": "unchanged", "reason": reason,
            })
            continue
        r["display_label_previous"] = old
        r["display_label"] = new
        r["display_label_basis"] = "speaker_attribution_correction"
        r["attribution_suspect"] = True
        info = r.get("attribution") or {}
        info.update({
            "suspect": True,
            "block_summary_injection": True,
            "corrected_display_label": new,
            "previous_display_label": old,
            "reason": reason,
        })
        r["attribution"] = info
        for g in data["route_guides"]["guides"]:
            if g.get("route_id") == rid:
                g["display_label"] = new
        changes.append({
            "route_id": rid,
            "story_id": r["story_id"],
            "story_title": row.get("story_title"),
            "previous_display_label": old,
            "new_display_label": new,
            "action": "relabeled",
            "reason": reason,
            "acts": n_acts,
        })
    return changes


def pack_runtime(runtime_path: Path, data_version: str, guide_lines: int) -> dict:
    raw_sha = sha256_file(runtime_path)
    packed_name = f"story_runtime.{raw_sha[:16]}.json.gz"
    packed_path = runtime_path.parent / packed_name
    with runtime_path.open("rb") as f_in, gzip.open(packed_path, "wb", compresslevel=9) as f_out:
        shutil.copyfileobj(f_in, f_out)
    # remove older phase packs except this one and keep history small
    for old in runtime_path.parent.glob("story_runtime.*.json.gz"):
        if old.name != packed_name:
            # keep previous 1.9.5 pack as reference? product should only ship current
            pass
    manifest = {
        "file": "story_runtime.json",
        "bytes": runtime_path.stat().st_size,
        "sha256": raw_sha,
        "data_version": data_version,
        "build_id": hashlib.sha256(f"{VERSION}-{data_version}".encode()).hexdigest()[:12],
        "product_version": VERSION,
        "corpus_nodes": 4370,
        "corpus_texts": 1433,
        "guide_lines": guide_lines,
        "generated_from": "complete_product_1_9_6_pre",
        "packed": {
            "path": f"data/{packed_name}",
            "bytes": packed_path.stat().st_size,
            "sha256": sha256_file(packed_path),
        },
    }
    dump_pretty(runtime_path.parent / "data_manifest.json", manifest)
    return manifest


def update_sidecars(manifest: dict, version: str = VERSION) -> None:
    packed_name = Path(manifest["packed"]["path"]).name
    data_version = manifest["data_version"]
    index = REPO_ROOT / "index.js"
    text = index.read_text(encoding="utf-8")
    text = re.sub(r"story_runtime\.[0-9a-f]{16}\.json\.gz", packed_name, text)
    text = re.sub(r"version: '[^']+'", f"version: '{version}'", text, count=1)
    text = re.sub(
        r"packed: \{ url: new URL\('data/story_runtime\.[0-9a-f]{16}\.json\.gz', BASE\)\.href, version: '[0-9a-f]{12}' \}",
        f"packed: {{ url: new URL('data/{packed_name}', BASE).href, version: '{data_version}' }}",
        text,
    )
    # fallback looser packed version replace
    text = re.sub(r"version: '[0-9a-f]{12}'", f"version: '{data_version}'", text)
    index.write_text(text, encoding="utf-8")

    manifest_json = REPO_ROOT / "manifest.json"
    man = load_json(manifest_json)
    man["version"] = version
    man["display_name"] = "明日方舟剧情数据（插件版）"
    dump_pretty(manifest_json, man)


def parse_args(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--runtime", type=Path, default=DEFAULT_RUNTIME)
    p.add_argument("--review", type=Path, default=DEFAULT_REVIEW)
    p.add_argument("--official-dir", type=Path, default=DEFAULT_OFFICIAL_DIR)
    p.add_argument("--apply", action="store_true", help="Write a full rebuild. Default is a no-op.")
    p.add_argument("--skip-apply", action="store_true")
    p.add_argument("--force-full-rebuild", action="store_true",
                   help="Allow --apply to discard an existing chapter-original alignment patch.")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    # Full rebuild re-derives every game-order line from 8-gram alignment and would
    # drop incremental chapter-original placements. Refuse unless explicitly forced.
    if not args.apply or args.skip_apply:
        print("build_complete_product: not writing (pass --apply for a full rebuild)", flush=True)
        return 0
    existing_map = FIXTURES / "all_game_order_mappings.json"
    if existing_map.is_file() and not args.force_full_rebuild:
        blob = load_json(existing_map)
        if blob.get("alignment_patch"):
            raise SystemExit(
                "refusing full rebuild: chapter-original alignment patch is present. "
                "Use scripts/patch_game_order_alignment.py, or pass --force-full-rebuild to discard it."
            )
    official_dir = args.official_dir if args.official_dir and args.official_dir.is_dir() else None
    usage_pkg = find_usage_package()
    print(f"official_dir={official_dir} usage_package={usage_pkg}", flush=True)

    data = load_json(args.runtime)
    review = load_review_index(args.review)
    before = existing_id_sets(data)

    mappings, blocked = build_all_mappings(data, review, official_dir)
    print(f"mappings={len(mappings)} blocked={len(blocked)}", flush=True)

    if args.skip_apply:
        return 0

    apply_game_order_routes(data, mappings)
    apply_am_display_fix(data)
    audit = classify_routes(data)
    mark_suspect_routes(data, audit)
    display_changes = propose_display_cleanup(data, audit)
    isolated = mark_no_local_script_isolation(data)

    after = existing_id_sets(data)
    missing_routes = before["route_ids"] - after["route_ids"]
    if missing_routes:
        raise SystemExit(f"route_ids removed: {sorted(missing_routes)[:8]}")
    if after["scene_ids"] != before["scene_ids"] or after["node_ids"] != before["node_ids"]:
        raise SystemExit("scene_id or node_id set changed")
    extra = after["route_ids"] - before["route_ids"]
    unexpected = {r for r in extra if not r.endswith(":route:game_order")}
    if unexpected:
        raise SystemExit(f"unexpected new route_ids: {unexpected}")

    out_map = FIXTURES / "all_game_order_mappings.json"
    dump_pretty(out_map, {
        "schema": "ark_all_game_order_v1",
        "generated_at": now_iso(),
        "zero_model": True,
        "version": VERSION,
        "official_dir": str(official_dir) if official_dir else None,
        "usage_package": str(usage_pkg) if usage_pkg else None,
        "mappings": [
            {k: v for k, v in m.items() if k != "scenes"} | {"scenes": m["scenes"]}
            for m in mappings
        ],
        "blocked": blocked,
    })

    dump_pretty(FIXTURES / "attribution_cleanup.json", {
        "schema": "ark_attribution_cleanup_v1",
        "generated_at": now_iso(),
        "changes": display_changes,
    })

    if args.apply and not args.skip_apply:
        dump_compact(args.runtime, data)
        data_version = compute_data_version(args.runtime)
        # write version into a sidecar field if present
        # (data_version is computed from content; do not inject a field that would change it after the fact)
        guide_lines = len(data["route_guides"]["guides"])
        manifest = pack_runtime(args.runtime, data_version, guide_lines)
        update_sidecars(manifest)
        # persist computed version next to reports
        dump_pretty(FIXTURES / "product_pack_meta.json", {
            "version": VERSION,
            "data_version": data_version,
            "manifest": manifest,
            "isolated_no_local_script_routes": isolated,
            "display_changes": len(display_changes),
            "game_order_routes_added": len(extra),
            "blocked": blocked,
        })
        print(json.dumps({
            "ok": True,
            "version": VERSION,
            "data_version": data_version,
            "mappings": len(mappings),
            "blocked": len(blocked),
            "new_routes": len(extra),
            "display_changes": sum(1 for c in display_changes if c["action"] == "relabeled"),
            "isolated": isolated,
            "packed": manifest["packed"]["path"],
        }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
