import os
import json
import base64
import pandas as pd

from google.oauth2 import service_account
from googleapiclient.discovery import build


def main():
    key_json = os.getenv("GOOGLE_SERVICE_ACCOUNT_KEY")
    sheet_id = os.getenv("GOOGLE_SHEET_ID")
    sheet_range = os.getenv("GOOGLE_SHEET_RANGE")

    if not key_json or not sheet_id or not sheet_range:
        raise Exception("Missing required environment variables")

    creds_dict = json.loads(key_json)

    creds = service_account.Credentials.from_service_account_info(
        creds_dict,
        scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"],
    )

    service = build("sheets", "v4", credentials=creds)

    sheet = service.spreadsheets()
    result = sheet.values().get(
        spreadsheetId=sheet_id,
        range=sheet_range,
    ).execute()

    values = result.get("values", [])

    if not values:
        print("No data found.")
        return

    headers = values[0]
    rows = values[1:]

    # Normalize rows to match header length
    normalized_rows = []

    for row in rows:
        if len(row) < len(headers):
            row = row + [""] * (len(headers) - len(row))
        elif len(row) > len(headers):
            row = row[:len(headers)]

        normalized_rows.append(row)

    df = pd.DataFrame(normalized_rows, columns=headers)


    # Optional: remove columns
    exclude = os.getenv("GOOGLE_EXCLUDE_COLUMNS")
    if exclude:
        cols = [c.strip() for c in exclude.split(",")]
        df = df.drop(columns=[c for c in cols if c in df.columns])

    # Optional: limit rows
    max_rows = os.getenv("GOOGLE_MAX_ROWS")
    if max_rows:
        df = df.head(int(max_rows))

    data = df.to_dict(orient="records")

    os.makedirs("docs/bug-reports", exist_ok=True)

    output_file = "docs/bug-reports/google-form-responses.json"

    with open(output_file, "w") as f:
        json.dump(data, f, indent=2)

    print(f"Wrote {len(data)} rows to {output_file}")


if __name__ == "__main__":
    main()
