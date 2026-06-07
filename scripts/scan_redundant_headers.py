#!/usr/bin/env python3
"""
Scan live question JSONs from S3 for redundant question headers.

The script:
1. Reads question IDs from a CSV with a ``Question ID``, ``question_id``, or
   ``base_question_id`` column
2. Fetches each JSON directly from S3 without saving JSON files locally
3. Scans question stems/statements for known redundant prompt headers
4. Writes the intermediate detection report to ``data/temp`` using the input CSV
   shape plus the matched header and part number

Usage:
python3 -B script/scan_redundant_headers.py
python3 -B script/scan_redundant_headers.py --csv data/input/questions.csv
python3 -B script/scan_redundant_headers.py --workers 250
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import re
import socket
import ssl
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from pathlib import Path
from typing import Any, Dict, List, Tuple
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

context = ssl._create_unverified_context()

REDUNDANT_HEADER_PHRASES = [
    "Choose the correct answer:",
    "Complete the following sentence:",
    "Fill in the blank:",
    "املأ الفراغ:",
    "أكمل الفراغ:",
    "اختر الإجابة الصحيحة:",
    "اختَر الإجابة الصحيحة:",
    "أَكمِل الجملة الآتية:",
    "أكمل الجملة الآتية:",
    "أكمل العبارة الآتية:",
]

PASSTHROUGH_COLUMNS = [
    "Parent ID",
    "Section ID",
    "Country",
    "Subject",
    "Grade",
    "Language",
    "Question Type",
]


def normalize_text(value: Any) -> str:
    if value is None:
        return ""

    text = str(value)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def load_question_rows(
    csv_path: Path,
) -> Tuple[List[Dict[str, str]], str, List[str], int, int]:
    rows: List[Dict[str, str]] = []
    seen = set()
    blank_count = 0
    duplicate_count = 0

    try:
        with csv_path.open("r", encoding="utf-8", newline="") as csvfile:
            reader = csv.DictReader(csvfile)
            input_fieldnames = list(reader.fieldnames or [])
            question_id_column = None
            if input_fieldnames:
                for candidate in ("Question ID", "question_id", "base_question_id"):
                    if candidate in input_fieldnames:
                        question_id_column = candidate
                        break

            if question_id_column is None:
                raise SystemExit(
                    f"CSV must contain a 'Question ID', 'question_id', or 'base_question_id' column: {csv_path}"
                )

            for index, row in enumerate(reader, start=1):
                question_id = str(row.get(question_id_column, "")).strip()
                if not question_id:
                    blank_count += 1
                    continue
                if question_id in seen:
                    duplicate_count += 1
                    continue

                seen.add(question_id)
                row["question_id"] = question_id
                rows.append({key: (value or "") for key, value in row.items()})

                if index % 100000 == 0:
                    print(
                        f"Loaded {index} CSV row(s)... unique question IDs so far: {len(rows)}",
                        flush=True,
                    )
    except FileNotFoundError as exc:
        raise SystemExit(f"CSV file not found: {csv_path}") from exc

    return rows, question_id_column, input_fieldnames, blank_count, duplicate_count


def build_question_url(question_id: str) -> str:
    return f"https://s3.us-east-1.amazonaws.com/qms.nagwa.com/questions/{question_id}/{question_id}.json"


def is_timeout_error(exc: BaseException | object) -> bool:
    if isinstance(exc, (TimeoutError, socket.timeout)):
        return True

    if isinstance(exc, URLError):
        return is_timeout_error(exc.reason)

    if isinstance(exc, BaseException):
        error_text = str(exc).lower()
        return "timed out" in error_text or "timeout" in error_text

    return False


def format_request_error(exc: BaseException, timeout_seconds: int) -> str:
    if is_timeout_error(exc):
        return f"Timeout after {timeout_seconds} second(s)"

    if isinstance(exc, HTTPError):
        return f"HTTP {exc.code}"

    if isinstance(exc, URLError):
        reason = exc.reason
        if isinstance(reason, BaseException):
            return format_request_error(reason, timeout_seconds)
        return str(reason) or exc.__class__.__name__

    return str(exc) or exc.__class__.__name__


def make_failed_scan_result(
    question_row: Dict[str, str],
    timeout_seconds: int,
    exc: BaseException,
) -> Dict[str, Any]:
    question_id = question_row["question_id"]
    return {
        "question_id": question_id,
        "json_url": build_question_url(question_id),
        "request_failed": True,
        "invalid_json": False,
        "match_rows": [],
        "error": format_request_error(exc, timeout_seconds),
    }


def find_phrase_matches(text: str) -> List[str]:
    return [phrase for phrase in REDUNDANT_HEADER_PHRASES if phrase in text]


def make_snippet(text: str, phrase: str, radius: int = 140) -> str:
    phrase_index = text.find(phrase)
    if phrase_index < 0:
        return text[: radius * 2].strip()

    start = max(0, phrase_index - radius)
    end = min(len(text), phrase_index + len(phrase) + radius)
    snippet = text[start:end].strip()
    if start > 0:
        snippet = f"...{snippet}"
    if end < len(text):
        snippet = f"{snippet}..."
    return snippet


def build_match_row(
    question_row: Dict[str, str],
    json_url: str,
    location: str,
    part_number: str,
    part_type: str,
    matched_phrase: str,
    text: str,
) -> Dict[str, str]:
    row = {
        "question_id": question_row["question_id"],
        "json_url": json_url,
        "location": location,
        "part_number": part_number,
        "part_type": part_type,
        "matched_phrase": matched_phrase,
        "stem_snippet": make_snippet(text, matched_phrase),
    }

    for column in PASSTHROUGH_COLUMNS:
        row[column] = question_row.get(column, "")

    return row


def build_redundant_header_rows(
    question_row: Dict[str, str],
    json_url: str,
    payload: Any,
) -> List[Dict[str, str]]:
    rows: List[Dict[str, str]] = []
    content = payload.get("content", {}) if isinstance(payload, dict) else {}

    if isinstance(content, dict):
        statement_text = normalize_text(content.get("statement"))
        for phrase in find_phrase_matches(statement_text):
            rows.append(
                build_match_row(
                    question_row=question_row,
                    json_url=json_url,
                    location="content.statement",
                    part_number="",
                    part_type="",
                    matched_phrase=phrase,
                    text=statement_text,
                )
            )

        parts = content.get("parts", [])
        if isinstance(parts, list):
            for index, part in enumerate(parts):
                if not isinstance(part, dict):
                    continue

                stem_text = normalize_text(part.get("stem"))
                for phrase in find_phrase_matches(stem_text):
                    rows.append(
                        build_match_row(
                            question_row=question_row,
                            json_url=json_url,
                            location=f"content.parts[{index}].stem",
                            part_number=str(part.get("n", index + 1)),
                            part_type=str(part.get("type", "")),
                            matched_phrase=phrase,
                            text=stem_text,
                        )
                    )

    return rows


def scan_question_row(
    question_row: Dict[str, str],
    timeout_seconds: int,
) -> Dict[str, Any]:
    question_id = question_row["question_id"]
    json_url = build_question_url(question_id)
    result: Dict[str, Any] = {
        "question_id": question_id,
        "json_url": json_url,
        "request_failed": False,
        "invalid_json": False,
        "match_rows": [],
        "error": "",
    }

    request = Request(json_url, headers={"User-Agent": "python3"})

    try:
        with urlopen(request, timeout=timeout_seconds, context=context) as response:
            raw_data = response.read()
    except HTTPError as exc:
        result["request_failed"] = True
        result["error"] = format_request_error(exc, timeout_seconds)
        return result
    except URLError as exc:
        result["request_failed"] = True
        result["error"] = format_request_error(exc, timeout_seconds)
        return result
    except (TimeoutError, socket.timeout) as exc:
        result["request_failed"] = True
        result["error"] = format_request_error(exc, timeout_seconds)
        return result
    except Exception as exc:  # pragma: no cover - defensive
        return make_failed_scan_result(question_row, timeout_seconds, exc)

    try:
        payload = json.loads(raw_data)
    except json.JSONDecodeError as exc:
        result["invalid_json"] = True
        result["error"] = str(exc)
        return result

    result["match_rows"] = build_redundant_header_rows(question_row, json_url, payload)
    return result


def process_question_rows(
    question_rows: List[Dict[str, str]],
    writer: csv.DictWriter,
    output_fieldnames: List[str],
    workers: int,
    timeout_seconds: int,
    round_label: str,
    matched_locations_start: int = 0,
    invalid_json_start: int = 0,
) -> Tuple[int, int, List[Dict[str, str]]]:
    matched_locations = matched_locations_start
    invalid_json_count = invalid_json_start
    failed_results: List[Dict[str, str]] = []

    total_questions = len(question_rows)
    if total_questions == 0:
        return matched_locations, invalid_json_count, failed_results

    with ThreadPoolExecutor(max_workers=workers) as executor:
        question_iter = iter(question_rows)
        max_pending = max(workers * 2, 1)
        pending: Dict[Future, Dict[str, str]] = {}

        def submit_next_question() -> None:
            try:
                question_row = next(question_iter)
            except StopIteration:
                return

            pending[
                executor.submit(scan_question_row, question_row, timeout_seconds)
            ] = question_row

        for _ in range(min(max_pending, total_questions)):
            submit_next_question()

        completed = 0
        failed_fetch_count = 0
        matched_questions = 0

        while pending:
            done, _ = wait(set(pending), return_when=FIRST_COMPLETED)

            for future in done:
                question_row = pending.pop(future)
                try:
                    result = future.result()
                except Exception as exc:  # pragma: no cover - defensive
                    result = make_failed_scan_result(question_row, timeout_seconds, exc)

                completed += 1

                if result["request_failed"]:
                    failed_fetch_count += 1
                    failed_results.append(
                        {
                            "question_id": result["question_id"],
                            "error": result["error"],
                            "json_url": result["json_url"],
                        }
                    )
                if result["invalid_json"]:
                    invalid_json_count += 1
                    failed_results.append(
                        {
                            "question_id": result["question_id"],
                            "error": f"Invalid JSON: {result['error']}",
                            "json_url": result["json_url"],
                        }
                    )

                match_rows = result["match_rows"]
                if match_rows:
                    matched_questions += 1
                    for match_row in match_rows:
                        output_row = {
                            fieldname: question_row.get(fieldname, "")
                            for fieldname in output_fieldnames
                        }
                        output_row["Redundant Header"] = match_row["matched_phrase"]
                        output_row["Part Number"] = match_row["part_number"] or "statement"
                        writer.writerow(output_row)
                    matched_locations += len(match_rows)

                progress_pct = (completed / total_questions * 100) if total_questions else 100.0
                print(
                    f"{round_label} Progress: {completed}/{total_questions} ({progress_pct:.1f}%) | "
                    f"Questions with matches: {matched_questions} | "
                    f"Matched locations: {matched_locations} | "
                    f"Failed fetches: {failed_fetch_count} | "
                    f"Invalid JSONs: {invalid_json_count}",
                    end="\r",
                    flush=True,
                )

                submit_next_question()

    print()
    return matched_locations, invalid_json_count, failed_results


def resolve_path(base_dir: Path, path_value: str) -> Path:
    path = Path(path_value).expanduser()
    return path if path.is_absolute() else (base_dir / path)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fetch live question JSON from S3 and report redundant prompt headers."
    )
    parser.add_argument(
        "--csv",
        default="data/input/questions.csv",
        help="Input CSV containing a question ID column (default: data/input/questions.csv)",
    )
    parser.add_argument(
        "--output",
        default="data/temp/redundant_headers_report.csv",
        help="Output CSV path (default: data/temp/redundant_headers_report.csv)",
    )
    parser.add_argument(
        "--failed-output",
        default=None,
        help=(
            "Output CSV path for failed fetches "
            "(default: <output>_failed_fetches.csv)"
        ),
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=250,
        help="Number of concurrent worker threads (default: 250)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=30,
        help="HTTP timeout per question fetch in seconds (default: 30)",
    )
    parser.add_argument(
        "--ReworkFailedFetches",
        action="store_true",
        default=True,
        help="Retry failed fetches in additional rounds using --trials (enabled by default)",
    )
    parser.add_argument(
        "--NoReworkFailedFetches",
        action="store_false",
        dest="ReworkFailedFetches",
        help="Disable retrying failed fetches.",
    )
    parser.add_argument(
        "--trials",
        type=int,
        default=5,
        help="Number of additional retry rounds for failed fetches (default: 5)",
    )
    args = parser.parse_args()

    if args.workers < 1:
        raise SystemExit("--workers must be at least 1.")
    if args.timeout < 1:
        raise SystemExit("--timeout must be at least 1.")

    base_dir = Path(__file__).resolve().parent.parent
    csv_path = resolve_path(base_dir, args.csv)
    output_path = resolve_path(base_dir, args.output)
    if args.failed_output:
        failed_output_path = resolve_path(base_dir, args.failed_output)
    else:
        failed_output_path = output_path.with_name(
            f"{output_path.stem}_failed_fetches.csv"
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    failed_output_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"Reading question rows from: {csv_path}", flush=True)
    print(f"Using {args.workers} concurrent worker thread(s).", flush=True)
    print(f"HTTP timeout per request: {args.timeout} second(s).", flush=True)
    print("JSON files will be fetched from S3 only and will NOT be saved.", flush=True)
    print(
        f"Retry failed fetches: {'yes' if args.ReworkFailedFetches else 'no'}",
        flush=True,
    )
    if args.ReworkFailedFetches:
        print(f"Retry rounds: {args.trials}", flush=True)

    (
        question_rows,
        id_column,
        input_fieldnames,
        blank_count,
        duplicate_count,
    ) = load_question_rows(csv_path)

    processed_ids = set()
    if output_path.exists():
        print("Output file exists. Loading processed IDs for resume...", flush=True)
        try:
            with output_path.open("r", encoding="utf-8", newline="") as f:
                reader = csv.DictReader(f)
                if reader.fieldnames:
                    for row in reader:
                        processed_id = str(row.get(id_column, "")).strip()
                        if processed_id:
                            processed_ids.add(processed_id)
            print(
                f"  Found {len(processed_ids)} already matched questions. Skipping them.",
                flush=True,
            )
        except Exception as exc:
            print(
                f"  Warning: Could not read existing output file for resume: {exc}",
                flush=True,
            )

    if processed_ids:
        original_count = len(question_rows)
        question_rows = [
            row for row in question_rows if row["question_id"] not in processed_ids
        ]
        print(
            f"  Questions remaining to process: {len(question_rows)} "
            f"(from {original_count} unique IDs)",
            flush=True,
        )

    total_questions = len(question_rows)

    print(f"Question ID column: {id_column}", flush=True)
    print(f"Unique question IDs loaded: {total_questions}", flush=True)
    print(f"Blank question_id rows skipped: {blank_count}", flush=True)
    print(f"Duplicate question_id rows skipped: {duplicate_count}", flush=True)

    mode = "a" if processed_ids else "w"
    print(f"{'Appending CSV report to' if processed_ids else 'Writing CSV report to'}: {output_path}", flush=True)
    print(f"Writing failed fetch log to: {failed_output_path}", flush=True)
    print("Starting live S3 scan...", flush=True)

    failed_fieldnames = [
        "question_id",
        "error",
        "json_url",
    ]

    matched_locations = 0
    invalid_json_count = 0

    with output_path.open(mode, encoding="utf-8", newline="") as csvfile:
        output_fieldnames = [*input_fieldnames, "Redundant Header", "Part Number"]

        writer = csv.DictWriter(csvfile, fieldnames=output_fieldnames)
        if mode == "w":
            writer.writeheader()

        matched_locations, invalid_json_count, failed_results = process_question_rows(
            question_rows=question_rows,
            writer=writer,
            output_fieldnames=input_fieldnames,
            workers=args.workers,
            timeout_seconds=args.timeout,
            round_label="Initial pass",
            matched_locations_start=matched_locations,
            invalid_json_start=invalid_json_count,
        )

        if args.ReworkFailedFetches and args.trials > 0:
            for retry_round in range(1, args.trials + 1):
                if not failed_results:
                    print(
                        f"No failed fetches remaining before retry round {retry_round}.",
                        flush=True,
                    )
                    break

                failed_ids = {row["question_id"] for row in failed_results}
                retry_question_rows = [
                    row for row in question_rows if row["question_id"] in failed_ids
                ]
                print(
                    f"Retry round {retry_round}: retrying {len(retry_question_rows)} failed fetch(es)...",
                    flush=True,
                )
                matched_locations, invalid_json_count, failed_results = process_question_rows(
                    question_rows=retry_question_rows,
                    writer=writer,
                    output_fieldnames=input_fieldnames,
                    workers=args.workers,
                    timeout_seconds=args.timeout,
                    round_label=f"Retry round {retry_round}",
                    matched_locations_start=matched_locations,
                    invalid_json_start=invalid_json_count,
                )

    with failed_output_path.open("w", encoding="utf-8", newline="") as failed_csvfile:
        failed_writer = csv.DictWriter(failed_csvfile, fieldnames=failed_fieldnames)
        failed_writer.writeheader()
        failed_writer.writerows(failed_results)

    print(f"Wrote {matched_locations} matched location row(s) to {output_path}")
    print(f"Wrote {len(failed_results)} failed fetch row(s) to {failed_output_path}")
    print(f"Question IDs processed: {total_questions}")
    print(f"Failed fetches remaining: {len(failed_results)}")
    print(f"Invalid JSONs: {invalid_json_count}")


if __name__ == "__main__":
    main()
