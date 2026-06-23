# Pending (un-applied) migrations

Files here are **intentionally outside** `supabase/migrations/` so the Supabase CLI
does **not** apply them on `supabase db push`. They are authored but were never
deployed to the linked project.

To deploy one: review it, move it into `supabase/migrations/` (keeping its
timestamp prefix, or re-stamp to a current time so it sorts last), then run
`supabase db push --dry-run` followed by `supabase db push`.

## Contents

- `20260610120000_dropbridge_v3_realtime_receipts.sql` — adds a
  `public.dropbridge_receipts` telemetry table + indexes and rewrites
  `dropbridge_emit_upload_wake()` to insert receipts. Quarantined 2026-06-22:
  the table does not exist on remote and this was never deployed. The
  `dropbridge_emit_upload_wake()` function on remote currently does not write
  receipts.
