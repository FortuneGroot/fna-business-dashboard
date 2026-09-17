"""Static 316-object + safety detectors. Never marks live tests PASS."""
from __future__ import annotations

import csv
import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP = Path(__file__).resolve().parents[1]
OUT = APP / "qa" / "output"
OUT.mkdir(exist_ok=True)

LIVE = "kIXDnRuhkj6HLR1g6V6V"
MASTER = "NQwD3zdWCuBSVpOuzybj"
PIPE = "6XevPh4T3rX0qAYRfuta"
OLD_PIPE = "iYIxeKOdg5jkoAfKNnYM"
OLD_FUNNEL = "HTqU4udPzzCzq6EIyZuI"
WRONG_BRAND = ("Fortune & Enterprise", "Fortune&Enterprise", "F&A TEST COMPANY")
PLACEHOLDERS = ("WAITING_CODEX_ID", "TODO", "TBD", "FIXME", "[CLIENT CONFIRMATION REQUIRED]")

SKIP_DIRS = {".next", "node_modules", ".git", "output"}


def iter_files() -> list[Path]:
    files: list[Path] = []
    for base in (APP, ROOT / "old nw 3" / "LIVE_FNA_BUILD"):
        if not base.exists():
            continue
        for p in base.rglob("*"):
            if any(part in SKIP_DIRS for part in p.parts):
                continue
            if p.suffix.lower() in {".md", ".json", ".ts", ".tsx", ".py", ".csv", ".example"} and p.is_file():
                files.append(p)
    return files


def scan() -> dict:
    stale_old_pipe = []
    master_hits = []
    brand_hits = []
    placeholder_hits = []
    for path in iter_files():
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        rel = str(path)
        if OLD_PIPE in text:
            ctx = "do-not-use" if any(
                m in text.lower() for m in ("do not use", "do_not_use", "never", "forbidden", "old pipeline")
            ) else "unqualified"
            stale_old_pipe.append({"file": rel, "classification": ctx})
        if MASTER in text and "forbidden" not in text.lower() and "do not" not in text.lower() and "never" not in text.lower():
            # actionable if it looks like a default location assignment
            if re.search(r"LOCATION_ID\s*=\s*[\"']" + MASTER, text) or "GHL_LOCATION_ID=" + MASTER in text:
                master_hits.append({"file": rel, "severity": "ACTIONABLE"})
            else:
                master_hits.append({"file": rel, "severity": "MENTION"})
        for brand in WRONG_BRAND:
            if brand in text:
                brand_hits.append({"file": rel, "brand": brand})
        if path.parent.name not in {"LIVE_FNA_BUILD"} or "WAITING_CODEX_ID" in path.name:
            for ph in PLACEHOLDERS:
                if ph in text and "intentionally" not in text.lower():
                    placeholder_hits.append({"file": rel, "token": ph})
                    break
    return {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "live_location": LIVE,
        "live_pipeline": PIPE,
        "old_pipeline_refs": stale_old_pipe,
        "master_refs": master_hits,
        "brand_contamination": brand_hits,
        "placeholders": placeholder_hits[:80],
        "note": "Unqualified old-pipeline refs in LIVE_FNA_BUILD should be do-not-use annotations. Actionable Master LOCATION_ID assignments are the real risk.",
    }


def write_trackers() -> None:
    qa_src = ROOT / "ondnew2" / "ghl-provisioner" / "_blueprint_extract" / "registers" / "qa_checklist.csv"
    qa_out = APP / "qa" / "qa_48_tracker.csv"
    if qa_src.is_file():
        rows = list(csv.DictReader(qa_src.read_text(encoding="utf-8-sig").splitlines()))
        fieldnames = list(rows[0].keys()) if rows else []
        with qa_out.open("w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=fieldnames)
            w.writeheader()
            w.writerows(rows)
    rt_src = ROOT / "ondnew2" / "cursor_execution_pack" / "RED_TEAM_52_EXECUTION_MANIFEST.json"
    rt_rows = []
    if rt_src.is_file():
        data = json.loads(rt_src.read_text(encoding="utf-8-sig"))
        for case in data.get("cases") or []:
            rt_rows.append(
                {
                    "test_id": case.get("test_id"),
                    "test": case.get("test"),
                    "current_status": "NOT_RUN",
                    "live_pass_allowed": False,
                    "evidence": "",
                    "note": "Do not mark PASS without live evidence. Copied from 2026-09-10 manifest as tracker only.",
                }
            )
    (APP / "qa" / "red_team_52_tracker.json").write_text(json.dumps({"count": len(rt_rows), "cases": rt_rows}, indent=2) + "\n", encoding="utf-8")


def object_inventory() -> dict:
    xwalk = ROOT / "old nw 3" / "LIVE_FNA_BUILD" / "LIVE_RUNTIME_CROSSWALK.json"
    data = json.loads(xwalk.read_text(encoding="utf-8")) if xwalk.is_file() else {}
    return {
        "custom_fields": len(data.get("custom_fields") or []),
        "calendars": len(data.get("calendars") or []),
        "forms": len(data.get("forms") or []),
        "funnel": data.get("funnel"),
        "wf_00_01": ((data.get("workflows") or {}).get("wf_00_01") or {}).get("id"),
        "canonical_316_note": "316-lock is historical Master-era. This inventory is LIVE checkpoint counts, not a claim that 316/316 exist on LIVE.",
        "live_status": "STATIC_FROM_CHECKPOINT — not a live GET this session",
    }


def main() -> int:
    write_trackers()
    report = {
        "inventory": object_inventory(),
        "detectors": scan(),
        "live_tests_marked_pass": 0,
        "rule": "No live QA/Red Team case marked PASS without evidence.",
    }
    (OUT / "static_audit_2026-09-14.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "inventory": report["inventory"],
        "old_pipeline_refs": len(report["detectors"]["old_pipeline_refs"]),
        "master_refs": len(report["detectors"]["master_refs"]),
        "brand_hits": len(report["detectors"]["brand_contamination"]),
        "live_pass": 0,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
