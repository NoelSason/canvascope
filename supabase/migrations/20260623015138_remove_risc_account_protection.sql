-- Remove Google Cross-Account Protection (RISC) from Canvascope.
--
-- RISC token/session revocation events were too aggressive for the extension's
-- expected persistent Google sign-in behavior. Canvascope now relies on normal
-- Supabase Auth session persistence and explicit user sign-out.
--
-- Keep a pass-through function at the old custom-access-token hook target so
-- token issuance remains safe if a hosted project still has the hook enabled
-- before the Supabase config change is pushed.
create or replace function public.risc_enforce_signin_block(event jsonb)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select $1;
$$;

grant execute on function public.risc_enforce_signin_block(jsonb) to supabase_auth_admin;
revoke execute on function public.risc_enforce_signin_block(jsonb) from public, anon, authenticated;

drop function if exists public.revoke_user_sessions(uuid);
drop function if exists public.user_id_for_google_sub(text);

drop table if exists public.risc_account_flags;
drop table if exists public.risc_events;
