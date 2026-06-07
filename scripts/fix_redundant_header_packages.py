#!/usr/bin/env python3
"""
Download question packages and remove redundant headers from their JSON stems.

The script:
1. Reads the intermediate report from ``data/temp/redundant_headers_report.csv``
2. Downloads ``packages/{question_id}.zip`` from S3 once per affected question,
   retrying failed downloads before reporting final failures
3. Removes ``Redundant Header`` from the matching ``Part Number``
4. Writes fixed zip packages to ``data/output/packages``

Usage:
python3 -B script/fix_redundant_header_packages.py
python3 -B script/fix_redundant_header_packages.py --limit 10
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import socket
import ssl
import zipfile
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Tuple
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

context = ssl._create_unverified_context()


@dataclass(frozen=True)
class FixInstruction:
    question_id: str
    part_number: str
    redundant_header: str


def resolve_path(base_dir: Path, path_value: str) -> Path:
    path = Path(path_value).expanduser()
    return path if path.is_absolute() else (base_dir / path)


def build_package_url(question_id: str) -> str:
    return f"https://s3.us-east-1.amazonaws.com/qms.nagwa.com/packages/{question_id}.zip"


def detect_question_id_column(fieldnames: List[str]) -> str:
    for candidate in ("Question ID", "question_id", "base_question_id"):
        if candidate in fieldnames:
            return candidate
    raise SystemExit(
        "Report CSV must contain a 'Question ID', 'question_id', or 'base_question_id' column."
    )


def load_fix_instructions(report_path: Path) -> Tuple[Dict[str, List[FixInstruction]], int]:
    instructions_by_question: Dict[str, List[FixInstruction]] = {}
    total_rows = 0

    try:
        with report_path.open("r", encoding="utf-8", newline="") as csvfile:
            reader = csv.DictReader(csvfile)
            fieldnames = list(reader.fieldnames or [])
            question_id_column = detect_question_id_column(fieldnames)
            missing_columns = [
                column
                for column in ("Redundant Header", "Part Number")
                if column not in fieldnames
            ]
            if missing_columns:
                raise SystemExit(
                    f"Report CSV missing required column(s): {', '.join(missing_columns)}"
                )

            seen = set()
            for row in reader:
                question_id = str(row.get(question_id_column, "")).strip()
                redundant_header = str(row.get("Redundant Header", "")).strip()
                part_number = str(row.get("Part Number", "")).strip()
                if not question_id or not redundant_header or not part_number:
                    continue

                key = (question_id, part_number, redundant_header)
                if key in seen:
                    continue
                seen.add(key)

                instructions_by_question.setdefault(question_id, []).append(
                    FixInstruction(
                        question_id=question_id,
                        part_number=part_number,
                        redundant_header=redundant_header,
                    )
                )
                total_rows += 1
    except FileNotFoundError as exc:
        raise SystemExit(f"Report CSV not found: {report_path}") from exc

    return instructions_by_question, total_rows


def format_request_error(exc: BaseException, timeout_seconds: int) -> str:
    if isinstance(exc, (TimeoutError, socket.timeout)):
        return f"Timeout after {timeout_seconds} second(s)"

    if isinstance(exc, HTTPError):
        return f"HTTP {exc.code}"

    if isinstance(exc, URLError):
        reason = exc.reason
        if isinstance(reason, BaseException):
            return format_request_error(reason, timeout_seconds)
        return str(reason) or exc.__class__.__name__

    return str(exc) or exc.__class__.__name__


def download_package(
    question_id: str,
    temp_packages_dir: Path,
    timeout_seconds: int,
    retries: int,
) -> bytes:
    url = build_package_url(question_id)
    last_error: BaseException | None = None
    for attempt in range(1, retries + 2):
        try:
            request = Request(url, headers={"User-Agent": "python3"})
            with urlopen(request, timeout=timeout_seconds, context=context) as response:
                data = response.read()
            break
        except (HTTPError, URLError, TimeoutError, socket.timeout) as exc:
            last_error = exc
            if attempt > retries:
                raise
            print(
                f"Retrying package fetch for {question_id} after {format_request_error(exc, timeout_seconds)} "
                f"({attempt}/{retries})",
                flush=True,
            )
    else:  # pragma: no cover - loop always breaks or raises
        raise RuntimeError(str(last_error) if last_error else "download_failed")

    temp_packages_dir.mkdir(parents=True, exist_ok=True)
    (temp_packages_dir / f"{question_id}.zip").write_bytes(data)
    return data


def remove_header_from_html(value: str, redundant_header: str) -> Tuple[str, bool]:
    pattern = re.compile(re.escape(redundant_header) + r"\s*")
    updated, count = pattern.subn("", value, count=1)
    return updated, count > 0


def apply_instruction(payload: Any, instruction: FixInstruction) -> Tuple[bool, str]:
    if not isinstance(payload, dict):
        return False, "payload_not_object"

    content = payload.get("content")
    if not isinstance(content, dict):
        return False, "missing_content"

    if instruction.part_number == "statement":
        statement = content.get("statement")
        if not isinstance(statement, str):
            return False, "missing_statement"
        updated_statement, changed = remove_header_from_html(
            statement,
            instruction.redundant_header,
        )
        if not changed:
            return False, "header_not_found_in_statement"
        content["statement"] = updated_statement
        return True, "fixed_statement"

    parts = content.get("parts")
    if not isinstance(parts, list):
        return False, "missing_parts"

    target_part = None
    for index, part in enumerate(parts):
        if not isinstance(part, dict):
            continue
        part_number = str(part.get("n", index + 1))
        if part_number == instruction.part_number:
            target_part = part
            break

    if target_part is None:
        return False, "part_not_found"

    stem = target_part.get("stem")
    if not isinstance(stem, str):
        return False, "missing_stem"

    updated_stem, changed = remove_header_from_html(stem, instruction.redundant_header)
    if not changed:
        return False, "header_not_found_in_stem"

    target_part["stem"] = updated_stem
    return True, "fixed_stem"


def find_question_json_name(question_id: str, names: List[str]) -> str | None:
    exact_name = f"{question_id}.json"
    for name in names:
        if name == exact_name or name.endswith(f"/{exact_name}"):
            return name

    json_names = [name for name in names if name.endswith(".json")]
    if len(json_names) == 1:
        return json_names[0]

    return None


def write_fixed_zip(
    original_zip_bytes: bytes,
    question_id: str,
    fixed_payload: Any,
    output_zip_path: Path,
) -> None:
    output_zip_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(original_zip_bytes), "r") as source_zip:
        names = source_zip.namelist()
        json_name = find_question_json_name(question_id, names)
        if json_name is None:
            raise ValueError("question_json_not_found")

        with zipfile.ZipFile(output_zip_path, "w", compression=zipfile.ZIP_DEFLATED) as output_zip:
            for item in source_zip.infolist():
                if item.filename == json_name:
                    output_zip.writestr(
                        item,
                        json.dumps(fixed_payload, ensure_ascii=False, indent=2) + "\n",
                    )
                else:
                    output_zip.writestr(item, source_zip.read(item.filename))


def fix_question_package(
    question_id: str,
    instructions: List[FixInstruction],
    temp_packages_dir: Path,
    output_packages_dir: Path,
    timeout_seconds: int,
    retries: int,
) -> Dict[str, str]:
    result = {
        "question_id": question_id,
        "package_url": build_package_url(question_id),
        "output_zip": "",
        "status": "failed",
        "applied_fixes": "0",
        "requested_fixes": str(len(instructions)),
        "error": "",
    }

    try:
        package_bytes = download_package(
            question_id,
            temp_packages_dir,
            timeout_seconds,
            retries,
        )
        with zipfile.ZipFile(io.BytesIO(package_bytes), "r") as package_zip:
            names = package_zip.namelist()
            json_name = find_question_json_name(question_id, names)
            if json_name is None:
                result["error"] = "question_json_not_found"
                return result
            payload = json.loads(package_zip.read(json_name))

        applied_count = 0
        errors = []
        for instruction in instructions:
            changed, reason = apply_instruction(payload, instruction)
            if changed:
                applied_count += 1
            else:
                errors.append(f"{instruction.part_number}:{instruction.redundant_header}:{reason}")

        if applied_count == 0:
            result["error"] = "; ".join(errors) or "no_fixes_applied"
            return result

        output_zip_path = output_packages_dir / f"{question_id}.zip"
        write_fixed_zip(package_bytes, question_id, payload, output_zip_path)

        result["status"] = "fixed" if not errors else "partially_fixed"
        result["applied_fixes"] = str(applied_count)
        result["output_zip"] = str(output_zip_path)
        result["error"] = "; ".join(errors)
        return result
    except (HTTPError, URLError, TimeoutError, socket.timeout) as exc:
        result["error"] = format_request_error(exc, timeout_seconds)
        return result
    except zipfile.BadZipFile:
        result["error"] = "bad_zip_file"
        return result
    except json.JSONDecodeError as exc:
        result["error"] = f"invalid_json: {exc}"
        return result
    except Exception as exc:  # pragma: no cover - defensive
        result["error"] = str(exc) or exc.__class__.__name__
        return result


def process_packages(
    instructions_by_question: Dict[str, List[FixInstruction]],
    temp_packages_dir: Path,
    output_packages_dir: Path,
    workers: int,
    timeout_seconds: int,
    retries: int,
) -> List[Dict[str, str]]:
    question_items = list(instructions_by_question.items())
    total_questions = len(question_items)
    results: List[Dict[str, str]] = []

    with ThreadPoolExecutor(max_workers=workers) as executor:
        question_iter = iter(question_items)
        max_pending = max(workers * 2, 1)
        pending: Dict[Future, str] = {}

        def submit_next_question() -> None:
            try:
                question_id, instructions = next(question_iter)
            except StopIteration:
                return

            pending[
                executor.submit(
                    fix_question_package,
                    question_id,
                    instructions,
                    temp_packages_dir,
                    output_packages_dir,
                    timeout_seconds,
                    retries,
                )
            ] = question_id

        for _ in range(min(max_pending, total_questions)):
            submit_next_question()

        completed = 0
        fixed_count = 0
        failed_count = 0

        while pending:
            done, _ = wait(set(pending), return_when=FIRST_COMPLETED)
            for future in done:
                question_id = pending.pop(future)
                try:
                    result = future.result()
                except Exception as exc:  # pragma: no cover - defensive
                    result = {
                        "question_id": question_id,
                        "package_url": build_package_url(question_id),
                        "output_zip": "",
                        "status": "failed",
                        "applied_fixes": "0",
                        "requested_fixes": "0",
                        "error": str(exc) or exc.__class__.__name__,
                    }

                results.append(result)
                completed += 1
                if result["status"] in ("fixed", "partially_fixed"):
                    fixed_count += 1
                else:
                    failed_count += 1

                progress_pct = (completed / total_questions * 100) if total_questions else 100.0
                print(
                    f"Fix Progress: {completed}/{total_questions} ({progress_pct:.1f}%) | "
                    f"Fixed packages: {fixed_count} | Failed packages: {failed_count}",
                    end="\r",
                    flush=True,
                )

                submit_next_question()

    print()
    return results


def write_summary(summary_path: Path, results: List[Dict[str, str]]) -> None:
    fieldnames = [
        "question_id",
        "package_url",
        "output_zip",
        "status",
        "applied_fixes",
        "requested_fixes",
        "error",
    ]
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    with summary_path.open("w", encoding="utf-8", newline="") as csvfile:
        writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(results)


def write_failed_after_retries(
    failed_output_path: Path,
    results: List[Dict[str, str]],
) -> None:
    failed_results = [result for result in results if result["status"] == "failed"]
    fieldnames = [
        "question_id",
        "package_url",
        "status",
        "applied_fixes",
        "requested_fixes",
        "error",
    ]
    failed_output_path.parent.mkdir(parents=True, exist_ok=True)
    with failed_output_path.open("w", encoding="utf-8", newline="") as csvfile:
        writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
        writer.writeheader()
        for result in failed_results:
            writer.writerow({fieldname: result.get(fieldname, "") for fieldname in fieldnames})


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Download question packages and remove redundant headers from JSON stems."
    )
    parser.add_argument(
        "--report",
        default="data/temp/redundant_headers_report.csv",
        help="Detection report CSV path (default: data/temp/redundant_headers_report.csv)",
    )
    parser.add_argument(
        "--temp-packages-dir",
        default="data/temp/packages",
        help="Directory for downloaded original packages (default: data/temp/packages)",
    )
    parser.add_argument(
        "--output-packages-dir",
        default="data/output/packages",
        help="Directory for fixed packages (default: data/output/packages)",
    )
    parser.add_argument(
        "--summary",
        default="data/output/fixed_packages_summary.csv",
        help="Summary CSV path (default: data/output/fixed_packages_summary.csv)",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=50,
        help="Number of concurrent package workers (default: 50)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=30,
        help="HTTP timeout per package download in seconds (default: 30)",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=5,
        help="Number of package fetch retries after the first failed attempt (default: 5)",
    )
    parser.add_argument(
        "--failed-output",
        default="data/temp/fixed_packages_failed_after_retries.csv",
        help=(
            "CSV path for packages still failed after retries "
            "(default: data/temp/fixed_packages_failed_after_retries.csv)"
        ),
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Only process the first N affected questions, useful for smoke tests.",
    )
    args = parser.parse_args()

    if args.workers < 1:
        raise SystemExit("--workers must be at least 1.")
    if args.timeout < 1:
        raise SystemExit("--timeout must be at least 1.")
    if args.retries < 0:
        raise SystemExit("--retries must be 0 or greater.")
    if args.limit is not None and args.limit < 1:
        raise SystemExit("--limit must be at least 1 when provided.")

    base_dir = Path(__file__).resolve().parent.parent
    report_path = resolve_path(base_dir, args.report)
    temp_packages_dir = resolve_path(base_dir, args.temp_packages_dir)
    output_packages_dir = resolve_path(base_dir, args.output_packages_dir)
    summary_path = resolve_path(base_dir, args.summary)
    failed_output_path = resolve_path(base_dir, args.failed_output)

    instructions_by_question, instruction_count = load_fix_instructions(report_path)
    if args.limit is not None:
        instructions_by_question = dict(
            list(instructions_by_question.items())[: args.limit]
        )

    print(f"Reading fix report from: {report_path}", flush=True)
    print(f"Unique affected questions: {len(instructions_by_question)}", flush=True)
    print(f"Fix instructions loaded: {instruction_count}", flush=True)
    print(f"Downloading original packages to: {temp_packages_dir}", flush=True)
    print(f"Writing fixed packages to: {output_packages_dir}", flush=True)
    print(f"Writing summary to: {summary_path}", flush=True)
    print(f"Writing final failed package fetches to: {failed_output_path}", flush=True)
    print(f"Using {args.workers} concurrent worker thread(s).", flush=True)
    print(f"Package fetch retries: {args.retries}", flush=True)

    results = process_packages(
        instructions_by_question=instructions_by_question,
        temp_packages_dir=temp_packages_dir,
        output_packages_dir=output_packages_dir,
        workers=args.workers,
        timeout_seconds=args.timeout,
        retries=args.retries,
    )
    write_summary(summary_path, results)
    write_failed_after_retries(failed_output_path, results)

    fixed_count = sum(1 for result in results if result["status"] == "fixed")
    partially_fixed_count = sum(
        1 for result in results if result["status"] == "partially_fixed"
    )
    failed_count = sum(1 for result in results if result["status"] == "failed")

    print(f"Fixed packages: {fixed_count}")
    print(f"Partially fixed packages: {partially_fixed_count}")
    print(f"Failed packages: {failed_count}")
    print(f"Summary written to: {summary_path}")
    print(f"Failed-after-retries CSV written to: {failed_output_path}")


if __name__ == "__main__":
    main()
