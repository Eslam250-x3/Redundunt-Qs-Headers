#!/usr/bin/env python3
"""
Organize fixed question packages into a subject/grade folder structure
and generate a manifest for the review UI.

Output layout:
  data/output/structure/<subject>/<grade>/<question_id>.zip
  data/output/structure/manifest.json

Usage:
python3 -B script/build_review_structure.py
python3 -B script/build_review_structure.py --clean
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import shutil
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple


def resolve_path(base_dir: Path, path_value: str) -> Path:
    path = Path(path_value).expanduser()
    return path if path.is_absolute() else (base_dir / path)


def sanitize_path_component(value: str) -> str:
    cleaned = str(value or "").strip()
    cleaned = re.sub(r'[\\/:*?"<>|]', "_", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned or "unknown"


def load_question_metadata(report_path: Path) -> Dict[str, Dict[str, str]]:
    metadata: Dict[str, Dict[str, str]] = {}

    with report_path.open("r", encoding="utf-8", newline="") as csvfile:
        reader = csv.DictReader(csvfile)
        question_id_column = None
        fieldnames = list(reader.fieldnames or [])
        for candidate in ("Question ID", "question_id", "base_question_id"):
            if candidate in fieldnames:
                question_id_column = candidate
                break

        if question_id_column is None:
            raise SystemExit(
                "Report CSV must contain a 'Question ID', 'question_id', or 'base_question_id' column."
            )

        for row in reader:
            question_id = str(row.get(question_id_column, "")).strip()
            if not question_id or question_id in metadata:
                continue

            metadata[question_id] = {
                "subject": str(row.get("Subject", "")).strip() or "unknown",
                "grade": str(row.get("Grade", "")).strip() or "unknown",
                "language": str(row.get("Language", "")).strip(),
                "country": str(row.get("Country", "")).strip(),
                "question_type": str(row.get("Question Type", "")).strip(),
            }

    return metadata


def load_fixed_packages(summary_path: Path) -> Dict[str, Dict[str, str]]:
    packages: Dict[str, Dict[str, str]] = {}

    with summary_path.open("r", encoding="utf-8", newline="") as csvfile:
        reader = csv.DictReader(csvfile)
        for row in reader:
            question_id = str(row.get("question_id", "")).strip()
            status = str(row.get("status", "")).strip()
            output_zip = str(row.get("output_zip", "")).strip()

            if not question_id or status not in ("fixed", "partially_fixed"):
                continue
            if not output_zip:
                continue

            packages[question_id] = {
                "status": status,
                "output_zip": output_zip,
            }

    return packages


def build_structure(
    metadata_by_question: Dict[str, Dict[str, str]],
    packages_by_question: Dict[str, Dict[str, str]],
    packages_dir: Path,
    temp_packages_dir: Path,
    structure_dir: Path,
    clean: bool,
) -> Tuple[Dict[str, Any], int, int, int]:
    if clean and structure_dir.exists():
        shutil.rmtree(structure_dir)

    structure_dir.mkdir(parents=True, exist_ok=True)
    original_packages_dir = structure_dir.parent / "original-packages"
    original_packages_dir.mkdir(parents=True, exist_ok=True)

    grouped: Dict[str, Dict[str, List[Dict[str, str]]]] = defaultdict(lambda: defaultdict(list))
    copied_count = 0
    missing_zip_count = 0
    missing_metadata_count = 0

    for question_id, package_info in sorted(packages_by_question.items()):
        metadata = metadata_by_question.get(question_id)
        if metadata is None:
            missing_metadata_count += 1
            continue

        subject = metadata["subject"]
        grade = metadata["grade"]
        subject_dir = sanitize_path_component(subject)
        grade_dir = sanitize_path_component(grade)

        source_zip = Path(package_info["output_zip"])
        if not source_zip.is_file():
            fallback_zip = packages_dir / f"{question_id}.zip"
            source_zip = fallback_zip if fallback_zip.is_file() else source_zip

        if not source_zip.is_file():
            missing_zip_count += 1
            continue

        target_dir = structure_dir / subject_dir / grade_dir
        target_dir.mkdir(parents=True, exist_ok=True)
        target_zip = target_dir / f"{question_id}.zip"
        shutil.copy2(source_zip, target_zip)
        copied_count += 1

        relative_zip_path = f"structure/{subject_dir}/{grade_dir}/{question_id}.zip"
        original_zip = temp_packages_dir / f"{question_id}.zip"
        question_entry: Dict[str, str] = {
            "question_id": question_id,
            "status": package_info["status"],
            "language": metadata.get("language", ""),
            "country": metadata.get("country", ""),
            "question_type": metadata.get("question_type", ""),
            "zip_path": relative_zip_path,
            "zip_url": f"/redundant-review/{relative_zip_path}",
        }
        if original_zip.is_file():
            target_original_zip = original_packages_dir / f"{question_id}.zip"
            if not target_original_zip.exists():
                try:
                    target_original_zip.symlink_to(original_zip.resolve())
                except OSError:
                    shutil.copy2(original_zip, target_original_zip)

            question_entry["original_zip_url"] = (
                f"/redundant-review/original-packages/{question_id}.zip"
            )
        grouped[subject][grade].append(question_entry)

    subjects: List[Dict[str, Any]] = []
    for subject_name in sorted(grouped.keys(), key=lambda value: value.casefold()):
        grades: List[Dict[str, Any]] = []
        for grade_name in sorted(
            grouped[subject_name].keys(),
            key=lambda value: (not value.isdigit(), value.casefold()),
        ):
            questions = sorted(
                grouped[subject_name][grade_name],
                key=lambda item: item["question_id"],
            )
            grades.append(
                {
                    "name": grade_name,
                    "folder": sanitize_path_component(grade_name),
                    "question_count": len(questions),
                    "questions": questions,
                }
            )

        subjects.append(
            {
                "name": subject_name,
                "folder": sanitize_path_component(subject_name),
                "question_count": sum(grade["question_count"] for grade in grades),
                "grades": grades,
            }
        )

    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_questions": copied_count,
        "subjects": subjects,
    }

    return manifest, copied_count, missing_zip_count, missing_metadata_count


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build subject/grade review structure from fixed packages."
    )
    parser.add_argument(
        "--report",
        default="data/temp/redundant_headers_report.csv",
        help="Detection report CSV path (default: data/temp/redundant_headers_report.csv)",
    )
    parser.add_argument(
        "--summary",
        default="data/output/fixed_packages_summary.csv",
        help="Fixed packages summary CSV path (default: data/output/fixed_packages_summary.csv)",
    )
    parser.add_argument(
        "--packages-dir",
        default="data/output/packages",
        help="Flat fixed packages directory (default: data/output/packages)",
    )
    parser.add_argument(
        "--temp-packages-dir",
        default="data/temp/packages",
        help="Original downloaded packages directory (default: data/temp/packages)",
    )
    parser.add_argument(
        "--structure-dir",
        default="data/output/structure",
        help="Output structure directory (default: data/output/structure)",
    )
    parser.add_argument(
        "--manifest",
        default="data/output/structure/manifest.json",
        help="Manifest output path (default: data/output/structure/manifest.json)",
    )
    parser.add_argument(
        "--clean",
        action="store_true",
        help="Delete the existing structure directory before rebuilding.",
    )
    args = parser.parse_args()

    base_dir = Path(__file__).resolve().parent.parent
    report_path = resolve_path(base_dir, args.report)
    summary_path = resolve_path(base_dir, args.summary)
    packages_dir = resolve_path(base_dir, args.packages_dir)
    temp_packages_dir = resolve_path(base_dir, args.temp_packages_dir)
    structure_dir = resolve_path(base_dir, args.structure_dir)
    manifest_path = resolve_path(base_dir, args.manifest)

    print(f"Reading metadata from: {report_path}", flush=True)
    print(f"Reading fixed packages from: {summary_path}", flush=True)
    print(f"Source packages directory: {packages_dir}", flush=True)
    print(f"Original packages directory: {temp_packages_dir}", flush=True)
    print(f"Writing structure to: {structure_dir}", flush=True)

    metadata_by_question = load_question_metadata(report_path)
    packages_by_question = load_fixed_packages(summary_path)

    manifest, copied_count, missing_zip_count, missing_metadata_count = build_structure(
        metadata_by_question=metadata_by_question,
        packages_by_question=packages_by_question,
        packages_dir=packages_dir,
        temp_packages_dir=temp_packages_dir,
        structure_dir=structure_dir,
        clean=args.clean,
    )

    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    print(f"Copied ZIP packages: {copied_count}", flush=True)
    print(f"Missing metadata rows: {missing_metadata_count}", flush=True)
    print(f"Missing ZIP files: {missing_zip_count}", flush=True)
    print(f"Subjects in manifest: {len(manifest['subjects'])}", flush=True)
    print(f"Manifest written to: {manifest_path}", flush=True)


if __name__ == "__main__":
    main()
