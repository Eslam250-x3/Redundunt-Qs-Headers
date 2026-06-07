#!/usr/bin/env python3
"""
Create a single ZIP file that can be uploaded to the GitHub review page.

The bundle contains:
  structure/manifest.json
  structure/<subject>/<grade>/<question_id>.zip

Usage:
python3 scripts/package_review_bundle.py
python3 scripts/package_review_bundle.py --output review-output.zip
"""

from __future__ import annotations

import argparse
import zipfile
from pathlib import Path


def package_review_bundle(structure_dir: Path, output_zip: Path) -> int:
    manifest_path = structure_dir / "manifest.json"
    if not manifest_path.is_file():
        raise SystemExit(f"Manifest not found: {manifest_path}")

    added_files = 0
    output_zip.parent.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(output_zip, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file_path in sorted(structure_dir.rglob("*")):
            if not file_path.is_file():
                continue
            if file_path.name.startswith("."):
                continue

            relative_path = file_path.relative_to(structure_dir.parent)
            archive.write(file_path, relative_path.as_posix())
            added_files += 1

    return added_files


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Package review structure into one uploadable ZIP file.",
    )
    parser.add_argument(
        "--structure-dir",
        default="data/output/structure",
        help="Review structure directory (default: data/output/structure)",
    )
    parser.add_argument(
        "--output",
        default="data/output/review-bundle.zip",
        help="Output ZIP path (default: data/output/review-bundle.zip)",
    )
    args = parser.parse_args()

    structure_dir = Path(args.structure_dir)
    output_zip = Path(args.output)
    added_files = package_review_bundle(structure_dir, output_zip)

    print(f"Created {output_zip}")
    print(f"Files added: {added_files}")


if __name__ == "__main__":
    main()
