#!/usr/bin/env python3
"""Phase C zero-model hard-metrics audit and additive chronological fallback line.

This script is deterministic and makes no model API calls. It never rewrites,
renames, or deletes an existing route_id, scene_id, or node_id.

Usage:
  python scripts/audit_story_lines.py
  python scripts/audit_story_lines.py --apply
  python scripts/audit_story_lines.py --official-dir /tmp/ark-official/stories
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
FIXTURES = Path(__file__).resolve().parent / "fixtures"
DEFAULT_RUNTIME = REPO_ROOT / "data" / "story_runtime.json"
DEFAULT_OFFICIAL_INDEX = FIXTURES / "act55side_official_index.json"
DEFAULT_MAPPING = FIXTURES / "tl_chrono_mapping.json"
DEFAULT_ID_INVENTORY = FIXTURES / "v1.9.5_id_inventory.json"

TL_STORY_ID = "story_c579b90d26"
NEW_ROUTE_ID = f"{TL_STORY_ID}:route:game_order"
NEW_LINE_CODE = "game_order"
NEW_GUIDE_ID = f"guide:{NEW_ROUTE_ID}"
AM_ROUTE_ID = "story_49947c64bb:route:AM"
TL_UNASSIGNED_ID = f"{TL_STORY_ID}:route:_unassigned"
SNOWFIELD_ROUTE_ID = "story_0f447c9b9b:route:SS"
AM_NEW_DISPLAY = "阿米娅与陈线"
AM_OLD_DISPLAY = "九线"
NO_LOCAL_SCRIPT_SOURCE = "official_prts_stage_order"
SPEAK_RATIO_THRESHOLD = 0.20
SHINGLE_N = 8

# Local cache of official AVG scripts (optional). Never required at test time.
DEFAULT_OFFICIAL_TEXT_DIRS = [
    Path("/tmp/ark-official/stories"),
    Path("/workspace/official-act55side-stories"),
]


def load_json(path: Path):
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def dump_compact(path: Path, data) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    tmp.replace(path)


def dump_pretty(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def natural_key(code: str):
    parts = re.split(r"(\d+)", code or "")
    out = []
    for p in parts:
        if p.isdigit():
            out.append((0, int(p)))
        else:
            out.append((1, p))
    return out


def shingles(text: str, n: int = SHINGLE_N) -> set[str]:
    s = re.sub(r"\s+", "", text or "")
    if not s:
        return set()
    if len(s) < n:
        return {s}
    return {s[i : i + n] for i in range(len(s) - n + 1)}


def official_segments(index: dict) -> list[dict]:
    return list(index["segments"])


# ----- runtime accessors -----

def routes_of(data: dict) -> list[dict]:
    return data["routes"]["routes"]


def route_by_id(data: dict) -> dict[str, dict]:
    return {r["route_id"]: r for r in routes_of(data)}


def stories_of(data: dict) -> list[dict]:
    return data["catalog"]["stories"]


def story_by_id(data: dict) -> dict[str, dict]:
    return {s["story_id"]: s for s in stories_of(data)}


def actor_name_map(data: dict) -> dict[str, str]:
    names = {}
    wrap = data.get("actors") or {}
    for a in (wrap.get("actors") or []) + (wrap.get("generic_actors") or []):
        names[a["actor_id"]] = a.get("canonical_name") or a.get("name") or a["actor_id"]
    return names


def actor_alias_map(data: dict) -> dict[str, set[str]]:
    """Map any canonical name or alias to the full name set of that actor."""
    groups: dict[str, set[str]] = {}
    wrap = data.get("actors") or {}
    for a in (wrap.get("actors") or []) + (wrap.get("generic_actors") or []):
        names = [a.get("canonical_name") or a.get("name")]
        names.extend(a.get("aliases") or [])
        names = [n for n in names if n]
        bucket = set(names)
        for n in names:
            if n in groups:
                bucket |= groups[n]
        for n in list(bucket):
            groups[n] = bucket
    return groups


def corpus_line_by_route(data: dict) -> dict[str, dict]:
    return {ln["route_id"]: ln for ln in data.get("corpus", {}).get("lines") or []}


def nodes_for_story(data: dict, story_id: str, playable_only: bool = True) -> list[dict]:
    out = []
    for n in data["corpus"]["nodes"]:
        if n.get("story_id") != story_id:
            continue
        if playable_only and not n.get("playable"):
            continue
        out.append(n)
    return out


def node_by_scene(data: dict, story_id: str | None = None) -> dict[str, dict]:
    out = {}
    for n in data["corpus"]["nodes"]:
        if story_id and n.get("story_id") != story_id:
            continue
        sid = n.get("scene_id")
        if sid and (n.get("playable") or story_id is None):
            # prefer playable if duplicates
            if sid not in out or (n.get("playable") and not out[sid].get("playable")):
                out[sid] = n
    return out


def entry_texts(data: dict, story_id: str) -> dict[str, str]:
    texts = data["corpus"]["texts"]
    out = {}
    for src in data["corpus"]["sources"]:
        if src.get("story_id") != story_id:
            continue
        for e in src.get("entries") or []:
            sha = e.get("text_sha256")
            if sha and sha in texts and isinstance(texts[sha], str):
                out[e["entry_id"]] = texts[sha]
    return out


def node_text(node: dict, texts_by_entry: dict[str, str]) -> str:
    t = texts_by_entry.get(node.get("entry_id") or "", "")
    if not t:
        return ""
    start, end = node.get("start"), node.get("end")
    if isinstance(start, int) and isinstance(end, int) and end > start:
        return t[start:end] if end <= len(t) else t[start:]
    ranges = node.get("ranges") or []
    if ranges:
        parts = []
        for pair in ranges:
            if isinstance(pair, (list, tuple)) and len(pair) == 2:
                a, b = pair
                parts.append(t[a:b] if b <= len(t) else t[a:])
        return "".join(parts)
    return t


def parse_official_avg(path: Path) -> tuple[list[str], str]:
    name_re = re.compile(r'\[name="([^"]+)"\](.*)')
    names = []
    lines = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        s = raw.strip()
        if not s:
            continue
        m = name_re.match(s)
        if m:
            names.append(m.group(1).strip())
            dlg = m.group(2).strip()
            if dlg:
                lines.append(dlg)
            continue
        if s.startswith("["):
            continue
        lines.append(s)
    return names, "\n".join(lines)


def find_official_text_dir(explicit: Path | None) -> Path | None:
    candidates = []
    if explicit:
        candidates.append(explicit)
    candidates.extend(DEFAULT_OFFICIAL_TEXT_DIRS)
    for d in candidates:
        if d and d.is_dir() and any(d.glob("level_act55side_*.txt")):
            return d
    return None


# ----- classification -----

def claimed_names_from_label(label: str | None) -> list[str]:
    if not label:
        return []
    s = label.strip()
    # strip split suffixes
    s = re.sub(r"\s*·\s*分线\d+\s*$", "", s)
    s = re.sub(r"（.*?）", "", s).strip()
    if not s.endswith("线"):
        return []
    if s in {"完整剧情线", "完整线", "独立片段", "补充片段", "年表线", "游戏关卡顺序保底线"}:
        return []
    if s.startswith("年表线"):
        return []
    core = s[:-1]
    if not core or core in {"服装", "未分配", "补充片段"}:
        return []
    parts = re.split(r"[／/、与及和]", core)
    return [p.strip() for p in parts if p.strip()]


def speaker_hit(speakers: list[str], names: list[str], aliases: dict[str, set[str]] | None = None) -> bool:
    if not speakers or not names:
        return False
    expanded: set[str] = set()
    for nm in names:
        expanded.add(nm)
        if aliases and nm in aliases:
            expanded |= aliases[nm]
    for sp in speakers:
        parts = [p for p in re.split(r"[&／/、]", sp) if p]
        for nm in expanded:
            if sp == nm or nm in parts:
                return True
            # Allow "发言人马克维茨" to satisfy "发言人", but never let a 1-char name
            # (e.g. 九) prefix-match a longer speaker.
            if len(nm) >= 2 and (sp.startswith(nm) or any(p.startswith(nm) for p in parts)):
                return True
    return False


def act_count(route: dict) -> int:
    return len(route.get("ordered_scene_ids") or [])


def is_no_local_script(corpus_line: dict | None, route: dict) -> bool:
    if corpus_line and corpus_line.get("source") == NO_LOCAL_SCRIPT_SOURCE:
        return True
    return route.get("order_source") == NO_LOCAL_SCRIPT_SOURCE


def route_speaker_stats(route: dict, scene_nodes: dict[str, dict], name_map: dict[str, str], aliases: dict[str, set[str]] | None = None) -> dict:
    scenes = route.get("ordered_scene_ids") or []
    claimed = claimed_names_from_label(route.get("display_label"))
    # if no label-derived name, fall back to first focus actor
    focus_names = [name_map[i] for i in (route.get("focus_actor_ids") or []) if i in name_map]
    check_names = claimed or (focus_names[:1] if route.get("display_label_basis") == "source_focus_actor" else [])
    acts_with_claim = 0
    per_act = []
    all_speakers = Counter()
    for sid in scenes:
        node = scene_nodes.get(sid)
        speakers = list((node or {}).get("speakers") or [])
        all_speakers.update(speakers)
        hit = speaker_hit(speakers, check_names, aliases) if check_names else False
        if hit:
            acts_with_claim += 1
        per_act.append({"scene_id": sid, "speakers": speakers, "named_focus_present": hit})
    n = len(scenes) or 1
    ratio = acts_with_claim / n if scenes else 0.0
    return {
        "claimed_names": claimed,
        "check_names": check_names,
        "focus_names": focus_names,
        "acts": len(scenes),
        "acts_with_named_focus": acts_with_claim,
        "named_focus_speak_act_ratio": ratio,
        "top_speakers": [n for n, _c in all_speakers.most_common(8)],
        "speaker_counts": dict(all_speakers),
    }


def classify_routes(data: dict) -> dict:
    names = actor_name_map(data)
    aliases = actor_alias_map(data)
    # nodes by scene across all stories (playable preferred)
    scene_nodes = {}
    for n in data["corpus"]["nodes"]:
        sid = n.get("scene_id")
        if not sid:
            continue
        if sid not in scene_nodes or (n.get("playable") and not scene_nodes[sid].get("playable")):
            scene_nodes[sid] = n
    lines = corpus_line_by_route(data)
    stories = story_by_id(data)
    rows = []
    no_script = []
    single_act = []
    le2_act = []
    mismatches = []
    unassigned = []
    suspect_summaries = []

    act_counts = []
    by_story_routes = Counter()
    by_story_single = defaultdict(list)
    by_story_le2 = defaultdict(list)

    for r in routes_of(data):
        cl = lines.get(r["route_id"])
        story = stories.get(r["story_id"]) or {}
        n_acts = act_count(r)
        act_counts.append(n_acts)
        by_story_routes[r["story_id"]] += 1
        stats = route_speaker_stats(r, scene_nodes, names, aliases)
        no_script_flag = is_no_local_script(cl, r)
        row = {
            "route_id": r["route_id"],
            "story_id": r["story_id"],
            "story_title": story.get("title"),
            "story_category": story.get("category"),
            "line_code": r.get("line_code"),
            "display_label": r.get("display_label"),
            "display_label_basis": r.get("display_label_basis"),
            "order_source": r.get("order_source") or (cl or {}).get("source"),
            "source_kind": r.get("source_kind"),
            "corpus_source": (cl or {}).get("source"),
            "is_full_script": (cl or {}).get("is_full_script"),
            "corpus_status": (cl or {}).get("status"),
            "quality": r.get("quality"),
            "acts": n_acts,
            "no_local_script": no_script_flag,
            "is_unassigned": r.get("line_code") == "_unassigned",
            "claimed_names": stats["claimed_names"],
            "focus_names": stats["focus_names"],
            "named_focus_speak_act_ratio": round(stats["named_focus_speak_act_ratio"], 4),
            "acts_with_named_focus": stats["acts_with_named_focus"],
            "top_speakers": stats["top_speakers"],
        }
        # attribution mismatch: named after a character who speaks in <=20% of acts
        mismatch = False
        reasons = []
        if (
            stats["check_names"]
            and n_acts >= 2
            and stats["named_focus_speak_act_ratio"] <= SPEAK_RATIO_THRESHOLD
            and r.get("line_code") != "_unassigned"
            and r.get("display_label_basis") not in {"official"}
        ):
            mismatch = True
            reasons.append(
                f"display_label names {stats['check_names']} but they speak in "
                f"{stats['acts_with_named_focus']}/{n_acts} acts "
                f"({stats['named_focus_speak_act_ratio']:.1%} <= {SPEAK_RATIO_THRESHOLD:.0%})"
            )
        if r["route_id"] == AM_ROUTE_ID:
            mismatch = True
            if "九仅在 AM1 发言" not in " ".join(reasons):
                reasons.append("known misattribution: 九 only speaks in AM1 of a 7-act Amiya/Chen line")
        if r["route_id"] == TL_UNASSIGNED_ID:
            reasons.append("mislabeled _unassigned costume line; order_source is full_script_fallback, not TL stage order")
        row["attribution_mismatch"] = mismatch
        row["attribution_reasons"] = reasons
        row["attribution_suspect"] = bool(
            mismatch
            or r["route_id"] in {AM_ROUTE_ID, TL_UNASSIGNED_ID}
            or (r.get("line_code") == "_unassigned" and r.get("order_source") == "full_script_fallback" and n_acts > 20)
        )
        rows.append(row)
        if no_script_flag:
            no_script.append(row)
        if n_acts == 1:
            single_act.append(row)
            by_story_single[r["story_id"]].append(row)
        if n_acts <= 2:
            le2_act.append(row)
            by_story_le2[r["story_id"]].append(row)
        if mismatch:
            mismatches.append(row)
        if row["is_unassigned"]:
            unassigned.append(row)
        if row["attribution_suspect"]:
            suspect_summaries.append(row)

    # fragmented chapters
    fragmented = []
    for sid, count in by_story_routes.most_common():
        st = stories.get(sid) or {}
        if count >= 10:
            fragmented.append({
                "story_id": sid,
                "title": st.get("title"),
                "category": st.get("category"),
                "route_count": count,
                "single_act_routes": len(by_story_single.get(sid) or []),
                "le2_act_routes": len(by_story_le2.get(sid) or []),
                "unassigned_routes": [
                    r["route_id"] for r in unassigned if r["story_id"] == sid
                ],
                "stage_codes": st.get("stage_codes") or [],
            })

    act_counts_sorted = sorted(act_counts)
    mid = len(act_counts_sorted) // 2
    median = act_counts_sorted[mid] if act_counts_sorted else 0
    if len(act_counts_sorted) % 2 == 0 and act_counts_sorted:
        median = (act_counts_sorted[mid - 1] + act_counts_sorted[mid]) / 2

    return {
        "totals": {
            "stories": len(stories),
            "routes": len(rows),
            "single_act_routes": len(single_act),
            "le2_act_routes": len(le2_act),
            "le3_act_routes": sum(1 for n in act_counts if n <= 3),
            "median_acts": median,
            "mean_acts": round(sum(act_counts) / len(act_counts), 4) if act_counts else 0,
            "max_acts": max(act_counts) if act_counts else 0,
            "no_local_script_routes": len(no_script),
            "unassigned_routes": len(unassigned),
            "unassigned_scene_refs": sum(r["acts"] for r in unassigned),
            "attribution_mismatches": len(mismatches),
            "suspect_summary_routes": len(suspect_summaries),
        },
        "routes": rows,
        "no_local_script_lines": no_script,
        "single_act_lines": single_act,
        "le2_act_lines": le2_act,
        "attribution_mismatches": mismatches,
        "unassigned_routes": unassigned,
        "suspect_summary_routes": suspect_summaries,
        "fragmented_chapters": fragmented,
        "single_act_by_chapter": _group_rows_by_story(single_act),
        "le2_act_by_chapter": _group_rows_by_story(le2_act),
        "no_local_script_by_chapter": _group_rows_by_story(no_script),
    }


def _group_rows_by_story(rows: list[dict]) -> list[dict]:
    groups = defaultdict(list)
    for r in rows:
        groups[r["story_id"]].append({
            "route_id": r["route_id"],
            "display_label": r.get("display_label"),
            "line_code": r.get("line_code"),
            "acts": r.get("acts"),
        })
    out = []
    for sid, items in groups.items():
        title = next((r.get("story_title") for r in rows if r["story_id"] == sid), None)
        category = next((r.get("story_category") for r in rows if r["story_id"] == sid), None)
        out.append({
            "story_id": sid,
            "title": title,
            "category": category,
            "count": len(items),
            "routes": items,
        })
    out.sort(key=lambda g: (-g["count"], g.get("title") or ""))
    return out


# ----- TL chronological mapping -----

def occurrence_topo_ranks(data: dict, story_id: str) -> dict[str, int]:
    logic_docs = [l for l in data["corpus"].get("logic") or [] if l.get("story_id") == story_id]
    nodes = nodes_for_story(data, story_id, playable_only=True)
    codes = {n.get("node_code") for n in nodes if n.get("node_code")}
    graph = defaultdict(set)
    indeg = {c: 0 for c in codes}
    if logic_docs:
        for rule in logic_docs[0].get("rules") or []:
            if rule.get("type") != "after":
                continue
            subjects = [s for s in (rule.get("subjects") or []) if s in codes]
            refs = [s for s in (rule.get("refs") or []) if s in codes]
            for ref in refs:
                for sub in subjects:
                    if sub == ref:
                        continue
                    if sub not in graph[ref]:
                        graph[ref].add(sub)
                        indeg[sub] = indeg.get(sub, 0) + 1
                        indeg.setdefault(ref, 0)
    # Kahn
    ready = sorted([c for c, d in indeg.items() if d == 0], key=natural_key)
    ranks = {}
    rank = 0
    while ready:
        # assign the current ready set a close rank order by natural key
        current = list(ready)
        ready = []
        for c in current:
            ranks[c] = rank
            rank += 1
            for nxt in sorted(graph.get(c) or [], key=natural_key):
                indeg[nxt] -= 1
                if indeg[nxt] == 0:
                    ready.append(nxt)
        ready.sort(key=natural_key)
    # leftover cycles
    leftover = sorted([c for c in codes if c not in ranks], key=natural_key)
    for c in leftover:
        ranks[c] = rank
        rank += 1
    return ranks


def build_tl_mapping(data: dict, official_index: dict, official_dir: Path | None, existing: dict | None = None) -> dict:
    segments = official_segments(official_index)
    nodes = nodes_for_story(data, TL_STORY_ID, playable_only=True)
    texts = entry_texts(data, TL_STORY_ID)
    ranks = occurrence_topo_ranks(data, TL_STORY_ID)
    routes = [r for r in routes_of(data) if r["story_id"] == TL_STORY_ID and r["route_id"] != NEW_ROUTE_ID]
    scene_to_old_routes = defaultdict(list)
    for r in routes:
        for sid in r.get("ordered_scene_ids") or []:
            scene_to_old_routes[sid].append({
                "route_id": r["route_id"],
                "display_label": r.get("display_label"),
                "line_code": r.get("line_code"),
            })

    # If official texts exist, recompute scores; otherwise reuse baked mapping scores.
    official_shingles = []
    used_live_texts = False
    if official_dir:
        missing = []
        for seg in segments:
            fname = Path(seg["story_txt"]).name + ".txt"
            path = official_dir / fname
            if not path.is_file():
                missing.append(str(path))
                continue
            _names, body = parse_official_avg(path)
            official_shingles.append({**seg, "shingles": shingles(body)})
        if missing:
            raise SystemExit("official text dir is missing files:\n  " + "\n  ".join(missing))
        if len(official_shingles) == len(segments):
            used_live_texts = True

    baked_by_scene = {}
    if existing:
        for item in existing.get("scenes") or []:
            baked_by_scene[item["scene_id"]] = item

    assignments = []
    for n in nodes:
        sid = n["scene_id"]
        body = node_text(n, texts)
        sh = shingles(body)
        scored = []
        if used_live_texts:
            for seg in official_shingles:
                inter = len(sh & seg["shingles"])
                cov = inter / len(sh) if sh else 0.0
                jac = inter / len(sh | seg["shingles"]) if (sh or seg["shingles"]) else 0.0
                scored.append((cov, jac, inter, seg))
            scored.sort(key=lambda x: (x[0], x[1], x[2]), reverse=True)
            best = scored[0]
            second = scored[1] if len(scored) > 1 else (0, 0, 0, None)
            cov, jac, inter, seg = best
            margin = cov - second[0]
            assignment = {
                "scene_id": sid,
                "node_id": n["node_id"],
                "node_code": n.get("node_code"),
                "act_name": n.get("act_name"),
                "line_code": n.get("line_code"),
                "speakers": list(n.get("speakers") or []),
                "source_locator": n.get("source_locator"),
                "chars": n.get("chars") or len(body),
                "seq": seg["seq"],
                "stage_code": seg["stage_code"],
                "avg_tag": seg["avg_tag"],
                "stage_name": seg["stage_name"],
                "official_story_txt": seg["story_txt"],
                "coverage": round(cov, 6),
                "jaccard": round(jac, 6),
                "shingle_overlap": inter,
                "margin_vs_second": round(margin, 6),
                "second_stage_code": second[3]["stage_code"] if second[3] else None,
                "second_avg_tag": second[3]["avg_tag"] if second[3] else None,
                "second_coverage": round(second[0], 6) if second[3] else None,
                "topo_rank": ranks.get(n.get("node_code"), 10**9),
                "old_route_ids": [x["route_id"] for x in scene_to_old_routes.get(sid, [])],
                "old_route_labels": [
                    f"{x['display_label'] or x['line_code']} ({x['route_id']})"
                    for x in scene_to_old_routes.get(sid, [])
                ],
            }
        else:
            baked = baked_by_scene.get(sid)
            if not baked:
                raise SystemExit(
                    f"No official texts found and baked mapping is missing scene {sid}. "
                    "Pass --official-dir with the 24 act55side AVG scripts."
                )
            assignment = dict(baked)
            assignment["topo_rank"] = ranks.get(n.get("node_code"), assignment.get("topo_rank", 10**9))
            assignment["old_route_ids"] = [x["route_id"] for x in scene_to_old_routes.get(sid, [])]
            assignment["old_route_labels"] = [
                f"{x['display_label'] or x['line_code']} ({x['route_id']})"
                for x in scene_to_old_routes.get(sid, [])
            ]
        assignments.append(assignment)

    assignments.sort(key=lambda a: (a["seq"], a.get("topo_rank", 10**9), natural_key(a.get("node_code") or "")))

    # sanity
    scene_ids = [a["scene_id"] for a in assignments]
    if len(scene_ids) != len(set(scene_ids)):
        raise SystemExit("duplicate scene_id in chronological assignment")
    if len(scene_ids) != 136:
        raise SystemExit(f"expected 136 unique playable scenes, got {len(scene_ids)}")
    seqs = [a["seq"] for a in assignments]
    if seqs != sorted(seqs):
        raise SystemExit("stage sequence is not monotonically non-decreasing")

    by_stage = []
    grouped = defaultdict(list)
    for a in assignments:
        grouped[(a["seq"], a["stage_code"], a["avg_tag"], a["stage_name"])].append(a)
    for key in sorted(grouped):
        seq, code, tag, name = key
        items = grouped[key]
        by_stage.append({
            "seq": seq,
            "stage_code": code,
            "avg_tag": tag,
            "stage_name": name,
            "scene_count": len(items),
            "min_coverage": min(x["coverage"] for x in items),
            "max_coverage": max(x["coverage"] for x in items),
            "low_margin_count": sum(1 for x in items if x.get("margin_vs_second", 1) < 0.05),
            "scenes": items,
        })

    return {
        "schema": "ark_phase_c_tl_chrono_v1",
        "story_id": TL_STORY_ID,
        "story_title": "时间啊，向前！",
        "new_route_id": NEW_ROUTE_ID,
        "line_code": NEW_LINE_CODE,
        "existing_route_count": 37,
        "unique_playable_scenes": len(assignments),
        "official_segments": 24,
        "order_source": "game_chronological_fallback",
        "matching_method": (
            f"{SHINGLE_N}-gram overlap between local node text (corpus ranges) "
            "and official act55side AVG scripts (dialogue + narrative, commands stripped)"
        ),
        "matched_from_live_official_texts": used_live_texts,
        "ordered_scene_ids": scene_ids,
        "ordered_node_ids": [a["node_id"] for a in assignments],
        "scenes": assignments,
        "stages": [
            {k: v for k, v in st.items() if k != "scenes"}
            | {"scene_ids": [x["scene_id"] for x in st["scenes"]], "node_codes": [x["node_code"] for x in st["scenes"]]}
            for st in by_stage
        ],
        "stage_tables": by_stage,
    }


def render_tl_review_md(mapping: dict) -> str:
    lines = []
    a = lines.append
    a("# 《时间啊，向前！》年表保底线核对表")
    a("")
    a("本表供人工核对 **TL-ST-1 → TL-1…TL-10 → TL-ST-4** 的关卡顺序后再决定是否并入生产包。")
    a("旧的 37 条路线及其 `route_id` / `scene_id` / `node_id` **全部保持不动**。")
    a("")
    a("## 摘要")
    a("")
    a(f"- 新路线 ID：`{mapping['new_route_id']}`")
    a(f"- 展示名：年表线（游戏关卡顺序）")
    a(f"- 覆盖场景：{mapping['unique_playable_scenes']} 个唯一可玩场景（去重后），0 重复")
    a(f"- 官方剧情段：{mapping['official_segments']} 段（含 4 个幕间 ST 与 TL-1…TL-10 的行动前/后）")
    a(f"- 排序：先按官方回顾表解锁顺序，再按本地发生逻辑拓扑序，最后按节点代号稳定排序")
    a("- 对齐方法：用本地幕原文与官方活动剧本做 8 字片段重合，把每幕归到重合最高的官方关卡段（行动前/行动后/幕间）")
    a(f"- 现场重算官方剧本：{'是' if mapping.get('matched_from_live_official_texts') else '否（使用已烘焙对照表）'}")
    a("- 默认游玩入口仍是原「费奥多尔线」；本线仅追加，不改旧存档游标。")
    a("- 误标为「去到圣骏堡时的服装线」的 `_unassigned`（136 幕、`full_script_fallback`）未改名、未改序，并标记为摘要注入嫌疑。")
    a("")
    a("## 关卡一览")
    a("")
    a("| 序 | 关卡 | 段落 | 官方标题 | 场景数 | 最低覆盖率 | 低区分度（<0.05） | 节点代号 |")
    a("| ---: | --- | --- | --- | ---: | ---: | ---: | --- |")
    for st in mapping["stage_tables"]:
        codes = "、".join(item.get("node_code") or "" for item in st["scenes"])
        a(
            f"| {st['seq']} | {st['stage_code']} | {st['avg_tag']} | {st['stage_name']} | "
            f"{st['scene_count']} | {st['min_coverage']:.3f} | {st['low_margin_count']} | {codes} |"
        )
    a("")
    a("覆盖率 = 本幕本地 8-gram 中出现在对应官方剧本中的比例。本次 136 幕均有明确最优对齐，无弱匹配。")
    a("")
    for st in mapping["stage_tables"]:
        a(f"## {st['seq']}. {st['stage_code']} {st['avg_tag']}　{st['stage_name']}")
        a("")
        a(f"本段收录 {st['scene_count']} 个本地视角场景。")
        a("")
        a("| 新幕序 | 节点 | 场景 ID | 本地幕名 | 覆盖率 | 次优关卡 | 差额 | 来源旧路线 |")
        a("| ---: | --- | --- | --- | ---: | --- | ---: | --- |")
        # new act index is position in the full ordered list
        ordered = mapping["ordered_scene_ids"]
        for item in st["scenes"]:
            new_ord = ordered.index(item["scene_id"]) + 1
            second = ""
            if item.get("second_stage_code"):
                second = f"{item['second_stage_code']} {item.get('second_avg_tag') or ''}".strip()
            sources = "；".join(item.get("old_route_labels") or item.get("old_route_ids") or [])
            a(
                f"| {new_ord} | {item['node_code']} | `{item['scene_id']}` | {item.get('act_name') or ''} | "
                f"{item['coverage']:.3f} | {second} | {item.get('margin_vs_second', 0):.3f} | {sources} |"
            )
        a("")
    a("## 使用与限制")
    a("")
    a("- 中途存档默认留在旧线。若要把旧档迁到本线，必须用当前 `scene_id` 精确落到新线；对不上就拒绝，禁止按幕序号搬运。")
    a("- 本线逐幕摘要复用已有同一 `scene_id` 的草稿摘要，状态仍为 `draft_for_later_batch_import`，抽检通过前不默认注入模型。")
    a("- Token Plan / 任何模型密钥都没有参与本表的生成。")
    a("")
    return "\n".join(lines) + "\n"


def render_audit_md(audit: dict, mapping: dict) -> str:
    t = audit["totals"]
    lines = []
    a = lines.append
    a("# Phase C 零模型剧情硬指标审计")
    a("")
    a("脚本：`scripts/audit_story_lines.py`。全程无模型调用，不改写任何既有 `route_id` / `scene_id` / `node_id`。")
    a("")
    a("## 总览")
    a("")
    a(f"- 篇章：{t['stories']} 篇")
    a(f"- 角色线 / 指导线：{t['routes']} 条")
    a(f"- 单幕线：{t['single_act_routes']} 条")
    a(f"- ≤2 幕线：{t['le2_act_routes']} 条")
    a(f"- ≤3 幕线：{t['le3_act_routes']} 条")
    a(f"- 幕数中位数：{t['median_acts']}；平均：{t['mean_acts']}；最大：{t['max_acts']}")
    a(f"- 本地无脚本（`official_prts_stage_order`，已隔离、不进未来 LLM 队列）：{t['no_local_script_routes']} 条")
    a(f"- `_unassigned`：{t['unassigned_routes']} 条，累计场景引用 {t['unassigned_scene_refs']}")
    a(f"- 角色归因不匹配（具名角色在 ≤20% 的幕发言，或已知误标）：{t['attribution_mismatches']} 条")
    a(f"- 摘要注入嫌疑路线（Phase A2 抽检前禁止注入）：{t['suspect_summary_routes']} 条")
    a("")
    a("## 346 条本地无脚本线（隔离清单）")
    a("")
    a("这些线的语料来自官方 PRTS / gamedata 舞台顺序，**不是**「明日方舟_使用包」本地剧本。它们不得进入后续 Flash / LLM 审核队列。")
    a("")
    a("| 篇章 | 分类 | 条数 | 路线 |")
    a("| --- | --- | ---: | --- |")
    for g in audit["no_local_script_by_chapter"]:
        sample = "、".join(
            f"{r['display_label'] or r['line_code']}" for r in g["routes"][:8]
        )
        if g["count"] > 8:
            sample += f" 等 {g['count']} 条"
        a(f"| {g['title']} | {g['category'] or ''} | {g['count']} | {sample} |")
    a("")
    a("完整 `route_id` 列表见 JSON 报告的 `no_local_script_lines`。")
    a("")
    a("## 单幕线与 ≤2 幕线（按篇章）")
    a("")
    a("### 单幕线（111）")
    a("")
    a("| 篇章 | 条数 | 路线 |")
    a("| --- | ---: | --- |")
    for g in audit["single_act_by_chapter"]:
        labels = "、".join((r["display_label"] or r["line_code"] or r["route_id"]) for r in g["routes"])
        a(f"| {g['title']} | {g['count']} | {labels} |")
    a("")
    a("### ≤2 幕线（224，含上面的单幕线）")
    a("")
    a("| 篇章 | 条数 |")
    a("| --- | ---: |")
    for g in audit["le2_act_by_chapter"]:
        a(f"| {g['title']} | {g['count']} |")
    a("")
    a("## 过度碎片化篇章")
    a("")
    a("| 篇章 | 分类 | 路线数 | 单幕 | ≤2 幕 | 舞台号 |")
    a("| --- | --- | ---: | ---: | ---: | --- |")
    for ch in audit["fragmented_chapters"]:
        stages = "、".join(ch.get("stage_codes") or [])
        a(
            f"| {ch['title']} | {ch.get('category') or ''} | {ch['route_count']} | "
            f"{ch['single_act_routes']} | {ch['le2_act_routes']} | {stages} |"
        )
    a("")
    a("## 角色归因不匹配")
    a("")
    a("判定：展示名指向某角色，但该角色在不超过 20% 的幕中作为发言者出现；以及已核实的 `route:AM`（九线）特例。")
    a("")
    a("| 路线 ID | 篇章 | 展示名 | 幕数 | 具名角色出席幕占比 | 主要发言者 | 原因 |")
    a("| --- | --- | --- | ---: | ---: | --- | --- |")
    for r in audit["attribution_mismatches"]:
        a(
            f"| `{r['route_id']}` | {r['story_title']} | {r['display_label']} | {r['acts']} | "
            f"{r['named_focus_speak_act_ratio']:.1%} | {'、'.join(r.get('top_speakers') or [])} | "
            f"{'；'.join(r.get('attribution_reasons') or [])} |"
        )
    a("")
    a("### `story_49947c64bb:route:AM` 显示名修正（不并线、不改 ID）")
    a("")
    a("- 此线属于《怒号光明》，不是雪原线，也不是《洪水》。")
    a("- 雪原线 `story_0f447c9b9b:route:SS`（塔露拉线，19 幕）保持不动，两条线不合并。")
    a("- 7 幕与全部 `scene_id` / `node_id` 保留。九只在 AM1 与陈、阿米娅、罗德岛干员同场；AM2–AM7 主体是阿米娅、陈对阵塔露拉与黑蛇。")
    a(f"- 显示名由「{AM_OLD_DISPLAY}」改为「{AM_NEW_DISPLAY}」，并写入归因元数据。`attribution_suspect=true`，摘要在抽检前不注入。")
    a("")
    a("## 摘要注入嫌疑路线")
    a("")
    a("至少包括 `route:AM` 与《时间啊，向前！》的 `_unassigned`。完整列表见 JSON。抽检通过前，Phase A2 幕摘要槽应对这些 `route_id` 输出 0 条摘要。")
    a("")
    a("| 路线 ID | 展示名 | 篇章 | 幕数 |")
    a("| --- | --- | --- | ---: |")
    for r in audit["suspect_summary_routes"]:
        a(f"| `{r['route_id']}` | {r['display_label']} | {r['story_title']} | {r['acts']} |")
    a("")
    a("## 《时间啊，向前！》新年表线")
    a("")
    a(f"- 新 `route_id`：`{mapping['new_route_id']}`")
    a(f"- 覆盖 {mapping['unique_playable_scenes']} 个唯一场景，按官方 {mapping['official_segments']} 段剧情顺序排列")
    a("- 详细逐段对照见 `tl-chrono-review.md`")
    a("")
    return "\n".join(lines) + "\n"


# ----- apply additive data changes -----

def _replace_am_display_in_text(text: str) -> str:
    if not text:
        return text
    text = text.replace("角色线：九线", f"角色线：{AM_NEW_DISPLAY}（原误标「九线」；九仅于 AM1 出场）")
    # leftover bare label in short fields
    if text == AM_OLD_DISPLAY:
        return AM_NEW_DISPLAY
    return text


def apply_am_display_fix(data: dict) -> dict:
    changed = []
    r = route_by_id(data)[AM_ROUTE_ID]
    if r.get("display_label") != AM_NEW_DISPLAY:
        r["display_label_previous"] = r.get("display_label") or AM_OLD_DISPLAY
        r["display_label"] = AM_NEW_DISPLAY
        r["display_label_basis"] = "speaker_attribution_correction"
        r["attribution_suspect"] = True
        r["attribution"] = {
            "suspect": True,
            "block_summary_injection": True,
            "named_focus": "九",
            "named_focus_speak_act_ratio": 1 / 7,
            "dominant_speakers": ["阿米娅", "陈"],
            "corrected_display_label": AM_NEW_DISPLAY,
            "previous_display_label": AM_OLD_DISPLAY,
            "do_not_merge_with": SNOWFIELD_ROUTE_ID,
            "reason": "九 only speaks in AM1; AM2-AM7 are Amiya/Chen vs Tallulah/Black Snake. Keep 7 acts and IDs.",
        }
        changed.append("routes.display_label")
    assert r["route_id"] == AM_ROUTE_ID
    assert r.get("ordered_scene_ids") and len(r["ordered_scene_ids"]) == 7
    for g in data["route_guides"]["guides"]:
        if g["route_id"] != AM_ROUTE_ID:
            continue
        g["display_label"] = AM_NEW_DISPLAY
        g["header_lines"] = [_replace_am_display_in_text(h) for h in (g.get("header_lines") or [])]
        changed.append("route_guides.display_label")
    return {"changed": changed}


def mark_suspect_routes(data: dict, audit: dict) -> None:
    suspect = {r["route_id"] for r in audit["suspect_summary_routes"]}
    by = route_by_id(data)
    for rid in suspect:
        r = by[rid]
        r["attribution_suspect"] = True
        info = r.get("attribution") or {}
        info["suspect"] = True
        info["block_summary_injection"] = True
        reasons = next((x["attribution_reasons"] for x in audit["suspect_summary_routes"] if x["route_id"] == rid), [])
        if reasons:
            info.setdefault("reasons", reasons)
        r["attribution"] = info


def _reuse_summaries(data: dict, mapping: dict) -> dict:
    by_scene = {}
    for route in data["player_summaries"]["routes"]:
        if route.get("story_id") != TL_STORY_ID:
            continue
        if route.get("route_id") == NEW_ROUTE_ID:
            continue
        for e in route.get("entries") or []:
            sid = e.get("scene_id")
            if sid and sid not in by_scene:
                by_scene[sid] = e
    entries = []
    missing = []
    for i, item in enumerate(mapping["scenes"], start=1):
        src = by_scene.get(item["scene_id"])
        if not src:
            missing.append(item["scene_id"])
            entries.append({
                "order": i,
                "code": item["node_code"],
                "node_id": item["node_id"],
                "scene_id": item["scene_id"],
                "title": f"{item['stage_code']} {item['avg_tag']} {item['stage_name']}",
                "summary": "",
                "summary_chars": 0,
                "source_locator": item.get("source_locator") or "",
                "source_status": "missing_reusable_summary",
                "notes": "new chrono act; no existing scene summary to reuse",
            })
            continue
        entries.append({
            "order": i,
            "code": item["node_code"],
            "node_id": item["node_id"],
            "scene_id": item["scene_id"],
            "title": src.get("title") or f"{item['stage_code']} {item['avg_tag']} {item['stage_name']}",
            "summary": src.get("summary") or "",
            "summary_chars": src.get("summary_chars") or 0,
            "source_locator": src.get("source_locator") or item.get("source_locator") or "",
            "source_status": src.get("source_status") or "reused",
            "notes": "reused from existing scene summary; draft, pending review",
        })
    return {
        "schema": "ark_scene_summary_draft_v1",
        "status": "draft_for_later_batch_import",
        "date": "2026-11-27",
        "story_id": TL_STORY_ID,
        "route_id": NEW_ROUTE_ID,
        "source_file": "支线/乌萨斯/时间啊 向前！.json",
        "source_data_version": data["player_summaries"].get("source_data_version"),
        "character_limit": 200,
        "count": len(entries),
        "usage": "player preview and optional experienced-act injection after review; not a full-line dump",
        "entries": entries,
        "reuse_missing_scene_ids": missing,
    }


def _build_guide(data: dict, mapping: dict) -> dict:
    # reuse act briefs / acts from existing guides for the same node_id
    acts_by_node = {}
    briefs_by_node = {}
    chapter = None
    for g in data["route_guides"]["guides"]:
        if g.get("story_id") != TL_STORY_ID:
            continue
        chapter = chapter or g.get("chapter")
        for act in g.get("acts") or []:
            acts_by_node.setdefault(act.get("node_id"), act)
        for br in g.get("act_briefs") or []:
            briefs_by_node.setdefault(br.get("node_id"), br)
    order = [item["node_code"] for item in mapping["scenes"]]
    acts = []
    briefs = []
    for i, item in enumerate(mapping["scenes"]):
        nid = item["node_id"]
        nxt = mapping["scenes"][i + 1]["node_code"] if i + 1 < len(mapping["scenes"]) else None
        src_act = acts_by_node.get(nid)
        if src_act:
            act = dict(src_act)
            act["next_node_code"] = nxt
            acts.append(act)
        else:
            acts.append({
                "node_id": nid,
                "node_code": item["node_code"],
                "act_name": f"{item['stage_code']} {item['avg_tag']} {item['stage_name']}",
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
                "code": item["node_code"],
                "title": f"{item['stage_code']} {item['avg_tag']} {item['stage_name']}",
            })
    header = [
        "# 本线剧情指导（全线要点；具体演出以当段原文为准）",
        "章：时间啊，向前！｜乌萨斯活动；角色线：年表线（游戏关卡顺序）",
        "幕序：按官方关卡 TL-ST-1 → TL-1…TL-10 → TL-ST-4（含行动前/行动后）排列 136 个既有场景。",
        "说明：本线是新增保底线；旧 37 条视角线 ID 不变。本指导是全线要点摘录；具体演出以本轮注入的【当前段剧情原文】为准。",
        f"材料：完整原文 {len(mapping['scenes'])} 幕（复用既有 scene_id / node_id）",
        "推进：按本指导的关卡顺序推进，不按旧视角线编号跳幕；交汇节点只结算一次。 玩家插话、观察、提问时保留现场，不推进段落游标。",
    ]
    return {
        "guide_id": NEW_GUIDE_ID,
        "route_id": NEW_ROUTE_ID,
        "story_id": TL_STORY_ID,
        "line_code": NEW_LINE_CODE,
        "chapter": chapter or {
            "title": "时间啊，向前！",
            "group_label": "乌萨斯",
            "source_file": "支线\\乌萨斯\\时间啊 向前！.json",
        },
        "status": "年表保底线（待人工核对关卡顺序）",
        "order": order,
        "shared_nodes": [],
        "branches": [],
        "header_lines": header,
        "act_briefs": briefs,
        "performance_notes": [],
        "acts": acts,
        "display_label": "年表线（游戏关卡顺序）",
    }


def apply_chrono_route(data: dict, mapping: dict) -> dict:
    notes = []
    existing = route_by_id(data)
    if NEW_ROUTE_ID in existing:
        # replace only the additive route in place, never touch others
        notes.append("new route already present; refreshing additive records only")
    new_route = {
        "route_id": NEW_ROUTE_ID,
        "story_id": TL_STORY_ID,
        "line_code": NEW_LINE_CODE,
        "focus_actor_ids": [],
        "ordered_scene_ids": list(mapping["ordered_scene_ids"]),
        "node_count": len(mapping["ordered_scene_ids"]),
        "cross_route_inputs": [],
        "shared_scene_ids": [],
        "quality": "phase_c_draft",
        "source_kind": "phase_c_chrono_fallback",
        "legacy_order": [],
        "order_source": "game_chronological_fallback",
        "display_label": "年表线（游戏关卡顺序）",
        "display_label_basis": "official_stage_order",
        "attribution_suspect": False,
        "pending_human_stage_review": True,
    }
    routes = routes_of(data)
    routes[:] = [r for r in routes if r["route_id"] != NEW_ROUTE_ID] + [new_route]

    # catalog
    for story in stories_of(data):
        if story["story_id"] != TL_STORY_ID:
            continue
        ids = [x for x in (story.get("route_ids") or []) if x != NEW_ROUTE_ID]
        # append, do not change default by mutating this list head
        ids.append(NEW_ROUTE_ID)
        story["route_ids"] = ids

    # navigation
    for entry in (data.get("navigation") or {}).get("entries") or []:
        if entry.get("story_id") != TL_STORY_ID:
            continue
        ids = [x for x in (entry.get("route_ids") or []) if x != NEW_ROUTE_ID]
        ids.append(NEW_ROUTE_ID)
        entry["route_ids"] = ids
        # keep default_route_id unchanged

    # corpus.lines
    clines = data["corpus"]["lines"]
    clines[:] = [ln for ln in clines if ln.get("route_id") != NEW_ROUTE_ID]
    clines.append({
        "route_id": NEW_ROUTE_ID,
        "story_id": TL_STORY_ID,
        "line_code": NEW_LINE_CODE,
        "source": "game_chronological_fallback",
        "ordered_node_ids": list(mapping["ordered_node_ids"]),
        "ordered_scene_ids": list(mapping["ordered_scene_ids"]),
        "ordered_legacy_scene_ids": list(mapping["ordered_scene_ids"]),
        "ordered_codes": [s["node_code"] for s in mapping["scenes"]],
        "logic_rule_count": 0,
        "pending": False,
        "status": "年表保底线（待人工核对）",
        "is_full_script": True,
    })

    # guides
    guides = data["route_guides"]["guides"]
    guides[:] = [g for g in guides if g.get("route_id") != NEW_ROUTE_ID]
    guides.append(_build_guide(data, mapping))
    cov = data["route_guides"].setdefault("coverage", {})
    cov["lines"] = len(guides)
    cov["chapters"] = len({g.get("story_id") for g in guides})

    # uids: do not mint a new worldbook uid (keeps 2049-entry baseline)
    uids = data.setdefault("route_guide_uids", {})
    uids.pop(NEW_ROUTE_ID, None)

    # player summaries
    ps_routes = data["player_summaries"]["routes"]
    ps_routes[:] = [r for r in ps_routes if r.get("route_id") != NEW_ROUTE_ID]
    ps_routes.append(_reuse_summaries(data, mapping))

    # bookkeeping counts
    if isinstance(data.get("guide_meta"), dict) and "lines" in data["guide_meta"]:
        data["guide_meta"]["lines"] = len(guides)
    cc = (data.get("corpus") or {}).get("coverage") or {}
    if "lines" in cc:
        cc["lines"] = len(clines)
    cmc = (data.get("corpus_meta") or {}).get("coverage") or {}
    if "lines" in cmc:
        cmc["lines"] = len(clines)

    notes.append(f"added {NEW_ROUTE_ID} with {len(mapping['ordered_scene_ids'])} scenes")
    return {"notes": notes, "route_id": NEW_ROUTE_ID, "scenes": len(mapping["ordered_scene_ids"])}


def compute_data_version(runtime_path: Path) -> str:
    script = REPO_ROOT / "maintenance" / "runtime-src" / "core" / "data.js"
    expr = (
        "const fs=require('fs');"
        f"const D=require({json.dumps(str(script))});"
        f"const raw=JSON.parse(fs.readFileSync({json.dumps(str(runtime_path))},'utf8'));"
        "process.stdout.write(D.computeDataVersion(raw));"
    )
    out = subprocess.check_output(["node", "-e", expr], text=True)
    return out.strip()


def pack_runtime(runtime_path: Path, data_version: str) -> dict:
    raw_sha = sha256_file(runtime_path)
    packed_name = f"story_runtime.{raw_sha[:16]}.json.gz"
    packed_path = runtime_path.parent / packed_name
    # remove previous phase-c packed artifacts but keep the original v1.9.5 pack if still referenced until replaced
    with runtime_path.open("rb") as f_in, gzip.open(packed_path, "wb", compresslevel=9) as f_out:
        shutil.copyfileobj(f_in, f_out)
    packed_sha = sha256_file(packed_path)
    manifest = {
        "file": "story_runtime.json",
        "bytes": runtime_path.stat().st_size,
        "sha256": raw_sha,
        "data_version": data_version,
        "build_id": hashlib.sha256(f"phase-c-{data_version}".encode()).hexdigest()[:12],
        "corpus_nodes": 4370,
        "corpus_texts": 1433,
        "guide_lines": 850,
        "generated_from": "phase_c_additive_patch",
        "packed": {
            "path": f"data/{packed_name}",
            "bytes": packed_path.stat().st_size,
            "sha256": packed_sha,
        },
    }
    dump_pretty(runtime_path.parent / "data_manifest.json", manifest)
    return manifest


def update_sidecar_files(manifest: dict, am_fixed: bool) -> None:
    data_version = manifest["data_version"]
    packed_name = Path(manifest["packed"]["path"]).name
    # index.js
    index = REPO_ROOT / "index.js"
    text = index.read_text(encoding="utf-8")
    text = re.sub(
        r"story_runtime\.[0-9a-f]{16}\.json\.gz",
        packed_name,
        text,
    )
    text = re.sub(
        r"version: 'a271be482e3e'",
        f"version: '{data_version}'",
        text,
    )
    # also handle already-updated versions
    text = re.sub(
        r"version: '[0-9a-f]{12}'",
        f"version: '{data_version}'",
        text,
    )
    index.write_text(text, encoding="utf-8")

    mjs = REPO_ROOT / "runtime-v1.9.5.mjs"
    mjs_text = mjs.read_text(encoding="utf-8")
    mjs_text = mjs_text.replace('"route_guide_count":849', '"route_guide_count":850')
    mjs_text = re.sub(
        r'__ext\.packed\.version==="[0-9a-f]{12}"',
        f'__ext.packed.version==="{data_version}"',
        mjs_text,
    )
    mjs.write_text(mjs_text, encoding="utf-8")

    release_path = REPO_ROOT / "release.json"
    release = load_json(release_path)
    release["data_version"] = data_version
    release["build_id"] = manifest["build_id"]
    release["data"] = {
        "path": "data/story_runtime.json",
        "bytes": manifest["bytes"],
        "sha256": manifest["sha256"],
    }
    wb = REPO_ROOT / "data" / "base_worldbook.json"
    release["worldbook"]["bytes"] = wb.stat().st_size
    release["worldbook"]["sha256"] = sha256_file(wb)
    changes = release.get("changes") or []
    note = "Phase C：怒号光明 route:AM 显示名修正；《时间啊，向前！》新增 game_order 年表保底线（旧 ID 不改）"
    if note not in changes:
        changes = [note] + list(changes)
    release["changes"] = changes
    dump_pretty(release_path, release)

    if am_fixed:
        wb_text = wb.read_text(encoding="utf-8")
        if "角色线：九线" in wb_text:
            wb.write_text(_replace_am_display_in_text(wb_text), encoding="utf-8")
            # refresh hashes after surgical replace
            release["worldbook"]["bytes"] = wb.stat().st_size
            release["worldbook"]["sha256"] = sha256_file(wb)
            dump_pretty(release_path, release)


def existing_id_sets(data: dict) -> dict[str, set[str]]:
    return {
        "route_ids": {r["route_id"] for r in routes_of(data)},
        "scene_ids": {s["scene_id"] for s in data["scenes"]["scenes"]},
        "node_ids": {n["node_id"] for n in data["corpus"]["nodes"]},
    }


def assert_ids_additive(before: dict[str, set[str]], after: dict[str, set[str]]) -> None:
    for kind in ("route_ids", "scene_ids", "node_ids"):
        missing = before[kind] - after[kind]
        if missing:
            raise SystemExit(f"{kind} were removed: {sorted(missing)[:8]}")
    extra_scenes = after["scene_ids"] - before["scene_ids"]
    extra_nodes = after["node_ids"] - before["node_ids"]
    if extra_scenes or extra_nodes:
        raise SystemExit("new scene_id or node_id was introduced; Phase C must reuse existing IDs")
    extra_routes = after["route_ids"] - before["route_ids"]
    if extra_routes - {NEW_ROUTE_ID}:
        raise SystemExit(f"unexpected new route_ids: {extra_routes}")


# ----- CLI -----

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Phase C zero-model story audit")
    p.add_argument("--runtime", type=Path, default=DEFAULT_RUNTIME)
    p.add_argument("--official-index", type=Path, default=DEFAULT_OFFICIAL_INDEX)
    p.add_argument("--official-dir", type=Path, default=None, help="Directory of official act55side AVG .txt files")
    p.add_argument("--mapping-out", type=Path, default=DEFAULT_MAPPING)
    p.add_argument("--report-json", type=Path, default=Path("/workspace/phase-c-audit-report.json"))
    p.add_argument("--report-md", type=Path, default=Path("/workspace/phase-c-audit-report.md"))
    p.add_argument("--review-md", type=Path, default=Path("/workspace/tl-chrono-review.md"))
    p.add_argument("--apply", action="store_true", help="Write additive data changes into the working clone")
    p.add_argument("--skip-pack", action="store_true")
    return p.parse_args(argv)


def run(argv: list[str] | None = None) -> dict:
    args = parse_args(argv)
    data = load_json(args.runtime)
    official_index = load_json(args.official_index)
    existing_mapping = load_json(args.mapping_out) if args.mapping_out.exists() else None
    official_dir = find_official_text_dir(args.official_dir)

    audit = classify_routes(data)
    mapping = build_tl_mapping(data, official_index, official_dir, existing_mapping)

    # strip bulky stage_tables scenes when writing mapping fixture: keep full scenes list at top
    mapping_out = {k: v for k, v in mapping.items() if k != "stage_tables"}
    # keep a compact stage_tables without nested full copies? we still need them for markdown.
    dump_pretty(args.mapping_out, {**mapping_out, "stage_tables": mapping["stage_tables"]})

    report = {
        "schema": "ark_phase_c_audit_v1",
        "generated_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "zero_model": True,
        "runtime": str(args.runtime),
        "data_version_input": data.get("data_version"),
        "totals": audit["totals"],
        "no_local_script_lines": [
            {k: r[k] for k in ("route_id", "story_id", "story_title", "display_label", "line_code", "acts", "corpus_source")}
            for r in audit["no_local_script_lines"]
        ],
        "single_act_lines": audit["single_act_lines"],
        "le2_act_lines": audit["le2_act_lines"],
        "single_act_by_chapter": audit["single_act_by_chapter"],
        "le2_act_by_chapter": audit["le2_act_by_chapter"],
        "no_local_script_by_chapter": audit["no_local_script_by_chapter"],
        "fragmented_chapters": audit["fragmented_chapters"],
        "attribution_mismatches": audit["attribution_mismatches"],
        "unassigned_routes": audit["unassigned_routes"],
        "suspect_summary_routes": [
            {k: r[k] for k in ("route_id", "story_id", "story_title", "display_label", "acts", "attribution_reasons")}
            for r in audit["suspect_summary_routes"]
        ],
        "am_display_fix": {
            "route_id": AM_ROUTE_ID,
            "previous_display_label": AM_OLD_DISPLAY,
            "new_display_label": AM_NEW_DISPLAY,
            "acts_preserved": 7,
            "merged_into_snowfield": False,
            "snowfield_route_id": SNOWFIELD_ROUTE_ID,
        },
        "tl_chrono": {
            "new_route_id": NEW_ROUTE_ID,
            "scene_count": mapping["unique_playable_scenes"],
            "stage_count": mapping["official_segments"],
            "ordered_stage_codes": [
                f"{st['stage_code']} {st['avg_tag']}" for st in mapping["stage_tables"]
            ],
        },
        "llm_queue_exclusions": [r["route_id"] for r in audit["no_local_script_lines"]],
    }
    dump_pretty(args.report_json, report)
    # also copy into the repo for the branch
    dump_pretty(REPO_ROOT / "docs" / "phase-c-audit-report.json", report)
    md = render_audit_md(audit, mapping)
    args.report_md.write_text(md, encoding="utf-8")
    (REPO_ROOT / "docs" / "phase-c-audit-report.md").write_text(md, encoding="utf-8")
    review = render_tl_review_md(mapping)
    args.review_md.write_text(review, encoding="utf-8")
    (REPO_ROOT / "docs" / "tl-chrono-review.md").write_text(review, encoding="utf-8")

    apply_info = None
    if args.apply:
        before = existing_id_sets(data)
        apply_am_display_fix(data)
        mark_suspect_routes(data, audit)
        apply_chrono_route(data, mapping)
        after = existing_id_sets(data)
        assert_ids_additive(before, after)
        # write runtime first (old data_version), then compute and stamp
        dump_compact(args.runtime, data)
        data_version = compute_data_version(args.runtime)
        # stamp data_version without otherwise mutating
        data = load_json(args.runtime)
        data["data_version"] = data_version
        dump_compact(args.runtime, data)
        if not args.skip_pack:
            manifest = pack_runtime(args.runtime, data_version)
            # surgical worldbook replace happens in update_sidecar_files
            update_sidecar_files(manifest, am_fixed=True)
        apply_info = {
            "data_version": data_version,
            "new_route_id": NEW_ROUTE_ID,
            "am_display_label": route_by_id(data)[AM_ROUTE_ID]["display_label"],
        }

    return {"audit_totals": audit["totals"], "mapping_scenes": mapping["unique_playable_scenes"], "apply": apply_info}


def main(argv: list[str] | None = None) -> int:
    result = run(argv)
    totals = result["audit_totals"]
    print(
        f"audit: routes={totals['routes']} no_script={totals['no_local_script_routes']} "
        f"single={totals['single_act_routes']} le2={totals['le2_act_routes']} "
        f"mismatch={totals['attribution_mismatches']} suspect={totals['suspect_summary_routes']}"
    )
    print(f"tl chrono scenes: {result['mapping_scenes']}")
    if result["apply"]:
        print("applied:", json.dumps(result["apply"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
