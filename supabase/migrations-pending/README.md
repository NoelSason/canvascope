# Pending (un-applied) migrations

Files here are **intentionally outside** `supabase/migrations/` so the Supabase CLI
does **not** apply them on `supabase db push`. They are authored but were never
deployed to the linked project.

To deploy one: review it, move it into `supabase/migrations/` (keeping its
timestamp prefix, or re-stamp to a current time so it sorts last), then run
`supabase db push --dry-run` followed by `supabase db push`.

## Contents

No pending migrations.
