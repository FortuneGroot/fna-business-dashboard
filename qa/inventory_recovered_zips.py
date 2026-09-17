"""Inventory recovered ZIP namelists without extracting the 352MB project dump."""
from __future__ import annotations

import json
import zipfile
from pathlib import Path

SRC = Path(r"c:\Users\gnass\OneDrive\Documents\SAVE FOR LIFE")
OUT = Path(r"c:\Users\gnass\Downloads\f&a ghl full build\RECOVERY_2026-09-15")
OUT.mkdir(exist_ok=True)

ZIPS = [
    "CODEX_GHL_EXECUTION_HANDOFF_2026-09-08.zip",
    "GEMINI_FNA_MESSAGING_PACK.zip",
    "FNA_Partners_New_Codex_Thread.zip",
    "FNA_Partners_New_Codex_Thread (1).zip",
    "codex i had give me this to see if its any diff.zip",
    "ghl 4pm 97 full(2).zip",
    "fa-foundation-experience-src 123.zip",
    "dd58456f-9a7e-4f2b-81ea-11cf4e412521.zip",
    "F&A_GHL_MASTER_COMPLETE_2026-09-12.zip",
    "FnA_GHL_FULL_BUILD_COPY_2026-09-12.zip",
    "FNA_Claude_Work_Copy_2026-09-12.zip",
    "F&A_GHL_CURSOR_WORK_PACKAGE_2026-09-12.zip",
    "F&A_GHL_MASTER_COPY_2026-09-12.zip",
    "FA_LIVE_BUILD_COPY_2026-09-12.zip",
    "f-and-a-ghl-full-build-COPY-2026-09-12.zip",
    "codex tech2 immpotamt.zip",
    "11_CODEX_PHASE2_TECHNICAL_LEAD.zip",
    "F&A_MASTER_OPERATING_SYSTEM_SOURCE.zip",
]

SKIP_EXTRACT_OVER = 20_000_000  # 20MB: list only unless marked unique-small


def list_zip(path: Path, limit=40) -> dict:
    info: dict = {"exists": path.is_file(), "size": path.stat().st_size if path.is_file() else 0}
    if not path.is_file():
        return info
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        info["file_count"] = len(names)
        interesting = [
            n
            for n in names
            if n.lower().endswith((".md", ".json", ".html", ".css", ".txt"))
            and any(
                k in n.lower()
                for k in (
                    "white",
                    "portal",
                    "dashboard",
                    "factory",
                    "train",
                    "onboard",
                    "clone",
                    "snapshot",
                    "qa",
                    "brand",
                    "form",
                    "email",
                    "sms",
                    "support",
                    "nav",
                    "report",
                    "client",
                    "quick",
                    "ux",
                    "login",
                )
            )
        ]
        info["sample"] = names[:limit]
        info["interesting"] = interesting[:80]
    return info


def main() -> None:
    report = {}
    for name in ZIPS:
        report[name] = list_zip(SRC / name)
    (OUT / "zip_inventory.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    summary = {
        k: {"size": v.get("size"), "files": v.get("file_count"), "interesting": len(v.get("interesting") or [])}
        for k, v in report.items()
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
