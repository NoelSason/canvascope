-- ============================================================================
-- Canvascope Character Profile — user-owned personalization state
--
--   character_profile → one row per user: the consent flags (enabled/paused),
--                       dismissed-suggestion ids, and a capped list of
--                       SOURCE-ATTRIBUTED derived summaries (content-light).
--                       No raw page/document/prompt bodies are stored here.
--                       Synced via the existing csTools upsert path
--                       (TOOLS_TABLES → character_profile / profile_json).
--
-- The feature is enabled by default in the client; a user can pause it, dismiss
-- individual suggestions, or clear it entirely. Clearing overwrites this row
-- with a disabled, empty state (see CanvascopeCharacterProfile.clear()), and an
-- account deletion cascades the row away via the auth.users FK.
--
-- RLS: each user reads/writes only their own row.
-- ============================================================================

create extension if not exists pgcrypto;

create table if not exists public.character_profile (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  profile_json jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now()
);

alter table public.character_profile enable row level security;
revoke all on table public.character_profile from anon;
grant select, insert, update, delete on table public.character_profile to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'character_profile'
      and policyname = 'Users can read their own character profile.'
  ) then
    create policy "Users can read their own character profile."
      on public.character_profile for select
      to authenticated
      using ((select auth.uid()) = user_id);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'character_profile'
      and policyname = 'Users can insert their own character profile.'
  ) then
    create policy "Users can insert their own character profile."
      on public.character_profile for insert
      to authenticated
      with check ((select auth.uid()) = user_id);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'character_profile'
      and policyname = 'Users can update their own character profile.'
  ) then
    create policy "Users can update their own character profile."
      on public.character_profile for update
      to authenticated
      using ((select auth.uid()) = user_id)
      with check ((select auth.uid()) = user_id);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'character_profile'
      and policyname = 'Users can delete their own character profile.'
  ) then
    create policy "Users can delete their own character profile."
      on public.character_profile for delete
      to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end
$$;
