---
name: google-sheets
description: Google Sheets automation — read/write/append ranges via Sheets API or gspread, service-account auth, 403/permission fixes, formulas, CSV import/export, Apps Script triggers.
---

# Google Sheets — API & automation playbook

## Auth (the #1 source of failures)
- **Service account** (for scripts/CI): create a SA key OR use workload identity; then **share the spreadsheet with the SA's `client_email`** (xxx@project.iam.gserviceaccount.com) like you would a human. A 403 on a valid token almost always means the sheet was never shared with the SA.
- Scopes: `https://www.googleapis.com/auth/spreadsheets` (read/write) or `.../spreadsheets.readonly`.
- User OAuth is only for interactive tools — prefer the SA for automation.

## Read / write / append (Python)
```python
# pip install --user google-api-python-client google-auth
from google.oauth2 import service_account
from googleapiclient.discovery import build

creds = service_account.Credentials.from_service_account_file(
    "sa.json", scopes=["https://www.googleapis.com/auth/spreadsheets"])
svc = build("sheets", "v4", credentials=creds).spreadsheets()

# READ
rows = svc.values().get(spreadsheetId=SHEET_ID, range="Sheet1!A1:C10").execute().get("values", [])

# WRITE (overwrite range)
svc.values().update(spreadsheetId=SHEET_ID, range="Sheet1!A1",
    valueInputOption="USER_ENTERED", body={"values": [["a", 1], ["b", 2]]}).execute()

# APPEND (adds after the last data row)
svc.values().append(spreadsheetId=SHEET_ID, range="Sheet1!A:C",
    valueInputOption="USER_ENTERED", insertDataOption="INSERT_ROWS",
    body={"values": [["new", "row", 3]]}).execute()
```
- `USER_ENTERED` parses like typing (dates/formulas work); `RAW` stores literal strings.
- gspread is the friendlier wrapper: `gspread.service_account(filename="sa.json").open_by_key(ID).sheet1`.

## Common failures
| Symptom | Cause → fix |
|---|---|
| 403 PERMISSION_DENIED | Sheet not shared with SA email → share it |
| 429 RATE_LIMIT | 300 read/min per project — batch with `values().batchGet`/`batchUpdate`, backoff |
| Values come back as strings | Sheets returns display values — request `valueRenderOption=UNFORMATTED_VALUE` |
| Writing formulas as text | Use `valueInputOption=USER_ENTERED` |
| Empty trailing cells missing | API trims trailing empties per row — pad client-side |

## BigQuery ↔ Sheets
- BQ external table over a Sheet: create table with `--external_table_definition` source_format=GOOGLE_SHEETS (needs drive scope on the SA).
- Export query → Sheet: query to CSV then `values().update`, or Connected Sheets in the UI.

## Bulk/format operations
Use `spreadsheets().batchUpdate` (not values) for: adding sheets/tabs, formatting, conditional formats, protected ranges, resizing. One request body, many operations — far under the rate limit.
