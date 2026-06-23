-- RISC sign-in enforcement: Custom Access Token auth hook.
--
-- Supabase runs this function every time it mints an access token (initial
-- sign-in AND every refresh). If the user's risc_account_flags.signin_blocked
-- is true (set by an account-disabled RISC event), the hook returns an error
-- object that aborts token issuance — so a compromised account cannot sign back
-- in or refresh its session until an account-enabled event clears the flag.
--
-- SAFETY: the hook FAILS OPEN. Any unexpected error returns the event unchanged
-- so a bug here can never lock out the whole user base. The block only applies
-- to users explicitly flagged in risc_account_flags.
--
-- After applying this migration, enable the hook (one-time, per project):
--   Dashboard → Authentication → Hooks → "Customize Access Token (JWT) Claims"
--   → enable → select  public.risc_enforce_signin_block
-- (or set [auth.hook.custom_access_token] in supabase/config.toml + config push)

create or replace function public.risc_enforce_signin_block(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  blocked boolean;
begin
  uid := (event->>'user_id')::uuid;

  select signin_blocked
    into blocked
  from public.risc_account_flags
  where user_id = uid;

  if blocked is true then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'This account is temporarily disabled for security reasons. Please contact support if you believe this is a mistake.'
      )
    );
  end if;

  -- Not blocked: issue the token with claims unchanged.
  return event;
exception
  when others then
    -- Fail open: never block a legitimate sign-in because of a hook error.
    return event;
end;
$$;

-- The hook is invoked by the auth service role. Grant it execute + read access,
-- and keep the function out of reach of normal roles.
grant execute on function public.risc_enforce_signin_block(jsonb) to supabase_auth_admin;
revoke execute on function public.risc_enforce_signin_block(jsonb) from public, anon, authenticated;
grant select on public.risc_account_flags to supabase_auth_admin;
