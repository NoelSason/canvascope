# Google Form -> GitHub Sync Setup

This setup pulls Google Form responses (from the linked Google Sheet) into:

- `docs/bug-reports/google-form-responses.json`

via GitHub Actions every 30 minutes and on manual run.

## 1. Confirm where your form responses live

1. Open your Google Form.
2. Go to `Responses`.
3. Click the Sheets icon to open the linked spreadsheet.
4. Keep this sheet open for the next steps.

## 2. Create Google Cloud credentials

1. Go to Google Cloud Console.
2. Create or select a project.
3. Enable `Google Sheets API`.
4. Create a Service Account.
5. Create a JSON key for that service account and download it.

## 3. Share the response sheet with the service account

1. Copy the service account email (looks like `...@...iam.gserviceaccount.com`).
2. In the Google Sheet, click `Share`.
3. Add the service account email as `Viewer` (or `Editor`).

Without this, sync will fail with permission errors.

## 4. Add GitHub repository secrets

In your GitHub repo (`NoelSason/canvascope`):

1. `Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`.
2. Add these secrets:

- `GOOGLE_SERVICE_ACCOUNT_KEY`: entire JSON key file contents
- `GOOGLE_SHEET_ID`: spreadsheet ID from URL
- `GOOGLE_SHEET_RANGE`: e.g. `Form Responses 1!A:Z`

Optional:

- `GOOGLE_EXCLUDE_COLUMNS`: comma-separated headers to omit (e.g. `Email Address,Name`)
- `GOOGLE_MAX_ROWS`: max rows to keep in JSON (e.g. `500`)

Also verify:

1. `Settings` -> `Actions` -> `General`.
2. Under `Workflow permissions`, select `Read and write permissions`.

Without write permissions, the workflow cannot commit synced files.

## 5. Commit and push workflow files

Files added:

- `.github/workflows/sync-google-form-bugs.yml`
- `scripts/sync_google_form_responses.py`
- `docs/bug-reports/google-form-responses.json`

Push these to your default branch.

## 6. Run once manually

1. Go to `Actions` tab in GitHub.
2. Open `Sync Google Form Bug Reports`.
3. Click `Run workflow`.
4. Confirm `docs/bug-reports/google-form-responses.json` updated.

## 7. Verify scheduled sync

The workflow is scheduled at:

- Every 30 minutes (`*/30 * * * *`)

If no responses changed, it will skip committing.

## Notes

- If this repo is public, avoid storing sensitive respondent data.
- Use `GOOGLE_EXCLUDE_COLUMNS` to strip PII fields.
