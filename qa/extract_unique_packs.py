"""Extract unique small recovered packs. Skip 20MB+ dumps."""
from __future__ import annotations

import zipfile
from pathlib import Path

SRC = Path(r"c:\Users\gnass\OneDrive\Documents\SAVE FOR LIFE")
DEST = Path(r"c:\Users\gnass\Downloads\f&a ghl full build\RECOVERY_2026-09-15")

EXTRACT = {
    "CODEX_GHL_EXECUTION_HANDOFF_2026-09-08.zip": "codex_handoff_2026-09-08",
    "GEMINI_FNA_MESSAGING_PACK.zip": "gemini_messaging_pack",
    "FNA_Partners_New_Codex_Thread.zip": "partners_brand_thread",
    "F&A_GHL_CURSOR_WORK_PACKAGE_2026-09-12.zip": "cursor_work_package",
    "F&A_MASTER_OPERATING_SYSTEM_SOURCE.zip": "master_operating_system_source",
    "FNA_Claude_Work_Copy_2026-09-12.zip": "claude_work_copy",
    "FA_LIVE_BUILD_COPY_2026-09-12.zip": "fa_live_build_copy",
    "codex tech2 immpotamt.zip": "codex_tech2",
    "11_CODEX_PHASE2_TECHNICAL_LEAD.zip": "codex_phase2_tech_lead",
}


def extract(src: Path, dest: Path) -> int:
    dest.mkdir(parents=True, exist_ok=True)
    count = 0
    with zipfile.ZipFile(src) as zf:
        for info in zf.infolist():
            name = info.filename.replace("\\", "/")
            if name.endswith("/") or ".." in name.split("/"):
                continue
            target = dest / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(zf.read(info))
            count += 1
    return count


def main() -> None:
    for zip_name, folder in EXTRACT.items():
        src = SRC / zip_name
        dest = DEST / folder
        if not src.is_file():
            print(f"MISSING {zip_name}")
            continue
        n = extract(src, dest)
        print(f"{folder}: {n} files")


if __name__ == "__main__":
    main()
