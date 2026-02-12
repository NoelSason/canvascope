#!/usr/bin/env python3
"""
Sync Google Form-linked Sheet responses into a local JSON file.

Required env vars:
  GOOGLE_SERVICE_ACCOUNT_KEY  JSON service account key (full JSON string)
  GOOGLE_SHEET_ID             Spreadsheet ID from the sheet URL

Optional env vars:
  GOOGLE_SHEET_RANGE          Defaults to "Form Responses 1!A:Z"
  OUTPUT_PATH                 Defaults to "docs/bug-reports/google-form-responses.json"
  EXCLUDE_COLUMNS             Comma-separated header names to exclude
  MAX_ROWS                    Integer row limit (from oldest->newest result set)
"""

import json
import os
import sys
from datetime import datetime, timezone

try:
    from google.oauth2.service_account import Credentials
    from googleapiclient.discovery import build
except ModuleNotFoundError:
    print(
        "ERROR: Missing dependencies. Install with:\n"
        "  pip install google-api-python-client google-auth google-auth-httplib2",
        file=sys.stderr,
    )
    sys.exit(1)


DEFAULT_RANGE = "Form Responses 1!A:Z"
DEFAULT_OUTPUT = "docs/bug-reports/google-form-responses.json"
SHEETS_READONLY_SCOPE = ["https://www.googleapis.com/auth/spreadsheets.readonly"]


def die(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def get_required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        die(f"Missing required environment variable: {name}")
    return value


def parse_service_account_info(raw_key: str) -> dict:
    try:
        return json.loads(raw_key)
    except json.JSONDecodeError as exc:
        die(
            "GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON. "
            f"Original error: {exc}"
        )


def to_unique_headers(header_row: list[str]) -> list[str]:
    headers: list[str] = []
    seen: dict[str, int] = {}

    for idx, raw in enumerate(header_row):
        base = (raw or "").strip() or f"column_{idx + 1}"
        count = seen.get(base, 0) + 1
        seen[base] = count
        headers.append(base if count == 1 else f"{base}_{count}")

    return headers


def parse_excluded_headers(raw_exclusions: str) -> set[str]:
    if not raw_exclusions.strip():
        return set()
    return {part.strip().lower() for part in raw_exclusions.split(",") if part.strip()}


def row_to_record(
    row: list[str],
    headers: list[str],
    excluded_headers: set[str],
) -> dict:
    record: dict[str, str] = {}

    for idx, header in enumerate(headers):
        if header.lower() in excluded_headers:
            continue
        value = row[idx] if idx < len(row) else ""
        record[header] = value

    return record


def fetch_sheet_values(spreadsheet_id: str, sheet_range: str, service_account_info: dict) -> list[list[str]]:
    credentials = Credentials.from_service_account_info(
        service_account_info,
        scopes=SHEETS_READONLY_SCOPE,
    )
    service = build("sheets", "v4", credentials=credentials)
    response = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=spreadsheet_id, range=sheet_range)
        .execute()
    )
    return response.get("values", [])


def main() -> None:
    raw_service_account_key = get_required_env("GOOGLE_SERVICE_ACCOUNT_KEY")
    spreadsheet_id = get_required_env("GOOGLE_SHEET_ID")

    sheet_range = os.getenv("GOOGLE_SHEET_RANGE", DEFAULT_RANGE).strip() or DEFAULT_RANGE
    output_path = os.getenv("OUTPUT_PATH", DEFAULT_OUTPUT).strip() or DEFAULT_OUTPUT
    excluded_headers = parse_excluded_headers(os.getenv("EXCLUDE_COLUMNS", ""))
    max_rows_raw = os.getenv("MAX_ROWS", "").strip()

    max_rows = None
    if max_rows_raw:
        try:
            max_rows = int(max_rows_raw)
            if max_rows < 1:
                die("MAX_ROWS must be a positive integer")
        except ValueError:
            die("MAX_ROWS must be an integer")

    service_account_info = parse_service_account_info(raw_service_account_key)
    values = fetch_sheet_values(spreadsheet_id, sheet_range, service_account_info)

    if not values:
        headers = []
        records = []
    else:
        headers = to_unique_headers(values[0])
        rows = values[1:]
        if max_rows is not None:
            rows = rows[-max_rows:]
        records = [row_to_record(row, headers, excluded_headers) for row in rows]

    payload = {
        "synced_at_utc": datetime.now(timezone.utc).isoformat(),
        "spreadsheet_id": spreadsheet_id,
        "range": sheet_range,
        "excluded_columns": sorted(list(excluded_headers)),
        "total_records": len(records),
        "headers": [h for h in headers if h.lower() not in excluded_headers],
        "records": records,
    }

    output_dir = os.path.dirname(output_path) or "."
    os.makedirs(output_dir, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as out:
        json.dump(payload, out, indent=2, ensure_ascii=False)
        out.write("\n")

    print(f"Wrote {len(records)} records to {output_path}")


if __name__ == "__main__":
    main()
