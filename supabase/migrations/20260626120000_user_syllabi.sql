-- ============================================================================
-- Canvascope Syllabus Memory — durable, structured syllabus per user
--
--   user_syllabi → one row per user: a blob keyed by courseId holding the
--                  parsed grading scheme (weights + drop rules), letter
--                  cutoffs, schedule / no-class dates, policies, and
--                  instructor info (syllabi_json blob). Powers "what do I
--                  need to get an A" (deterministic calculator) and schedule
--                  questions ("when do we not have class") in the Course Brain.
--                  Synced via the existing csTools upsert path (TOOLS_TABLES).
--
-- RLS: each user reads/writes only their own row.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- user_syllabi (one row per user, upserted on user_id)
-- ----------------------------------------------------------------------------
create table if not exists public.user_syllabi (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  syllabi_json jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now()
);

create index if not exists user_syllabi_updated_at_idx
  on public.user_syllabi (updated_at);

alter table public.user_syllabi enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_syllabi'
      and policyname = 'Users can read their own syllabi.'
  ) then
    create policy "Users can read their own syllabi."
      on public.user_syllabi for select
      using (auth.uid() = user_id);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_syllabi'
      and policyname = 'Users can insert their own syllabi.'
  ) then
    create policy "Users can insert their own syllabi."
      on public.user_syllabi for insert
      with check (auth.uid() = user_id);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_syllabi'
      and policyname = 'Users can update their own syllabi.'
  ) then
    create policy "Users can update their own syllabi."
      on public.user_syllabi for update
      using (auth.uid() = user_id);
  end if;
end
$$;
