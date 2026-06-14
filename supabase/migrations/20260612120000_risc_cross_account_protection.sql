-- Cross-Account Protection (RISC) support
-- Google sends security event tokens (SETs) to the risc-receiver edge function
-- when a shared user's Google Account changes (hijacking, disable, sessions
-- revoked, ...). This migration adds:
--   * risc_events        - audit log + idempotency (dedup on jti)
--   * risc_account_flags - per-user sign-in block state set by account-disabled
--   * user_id_for_google_sub() - map a Google account id (sub) -> Supabase user
--   * revoke_user_sessions()   - force re-auth by clearing the user's sessions
-- All objects are locked to the service role (the edge function runs with it).

-- ---------------------------------------------------------------------------
-- Audit log / idempotency. The RISC stream may redeliver a token, so we dedup
-- on the token's unique `jti`. Service-role only (RLS on, no policies).
-- ---------------------------------------------------------------------------
create table if not exists public.risc_events (
  jti          text primary key,
  event_type   text not null,
  subject_sub  text,
  user_id      uuid references auth.users (id) on delete set null,
  reason       text,
  payload      jsonb not null,
  received_at  timestamptz not null default now()
);

create index if not exists risc_events_user_id_idx   on public.risc_events (user_id);
create index if not exists risc_events_received_at_idx on public.risc_events (received_at desc);

alter table public.risc_events enable row level security;

-- ---------------------------------------------------------------------------
-- Sign-in block state. account-disabled (no reason) sets signin_blocked=true;
-- account-enabled clears it. Enforcement happens at the auth layer (see the
-- edge function / follow-up note); this table is the source of truth.
-- ---------------------------------------------------------------------------
create table if not exists public.risc_account_flags (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  signin_blocked boolean not null default false,
  reason         text,
  updated_at     timestamptz not null default now()
);

alter table public.risc_account_flags enable row level security;

-- ---------------------------------------------------------------------------
-- Map a Google account id (the `sub` carried in RISC events, identical to the
-- sub in Sign In With Google id tokens) to the Supabase user it belongs to.
-- ---------------------------------------------------------------------------
create or replace function public.user_id_for_google_sub(p_sub text)
returns uuid
language sql
security definer
set search_path = auth, public
as $$
  select user_id
  from auth.identities
  where provider = 'google'
    and provider_id = p_sub
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Revoke every active session for a user, forcing re-authentication. Returns
-- the number of sessions deleted. Deleting auth.sessions cascades to the
-- associated refresh tokens, so existing access tokens can no longer be
-- refreshed once they expire.
-- ---------------------------------------------------------------------------
create or replace function public.revoke_user_sessions(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = auth, public
as $$
declare
  deleted_count integer;
begin
  delete from auth.sessions where user_id = p_user_id;
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

-- Lock the helpers down: only the service role (used by the edge function) may
-- run them. SECURITY DEFINER would otherwise let any role read the auth schema.
revoke all on function public.user_id_for_google_sub(text) from public, anon, authenticated;
revoke all on function public.revoke_user_sessions(uuid)   from public, anon, authenticated;
grant execute on function public.user_id_for_google_sub(text) to service_role;
grant execute on function public.revoke_user_sessions(uuid)   to service_role;
