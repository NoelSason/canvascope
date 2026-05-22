-- ============================================================================
-- Canvascope: skin + academic tools sync tables
--
-- Backs the cross-device sync added by background-cs-extras.js. Each table is
-- keyed by user_id (1:1 with auth.users) and stores a JSON blob — the blob
-- shape is owned by the client modules so we do not need to migrate the
-- schema for every new field.
--
-- Five tables:
--   user_skin_prefs          → canvasSkin state (themes, paint, sidebar, etc.)
--   user_gpa_scenarios       → saved GPA scenarios + course rows
--   user_dashboard_notes     → markdown-lite notes
--   user_custom_todos        → custom todos (merged into Up Next client-side)
--   user_reminder_prefs      → reminder thresholds + optional webhook URL
--
-- RLS: each user reads/writes only their own row.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- user_skin_prefs
-- ----------------------------------------------------------------------------
create table if not exists public.user_skin_prefs (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  skin_json   jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.user_skin_prefs enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_skin_prefs'
      and policyname = 'Users can read their own skin prefs.'
  ) then
    create policy "Users can read their own skin prefs."
      on public.user_skin_prefs for select
      using (auth.uid() = user_id);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_skin_prefs'
      and policyname = 'Users can upsert their own skin prefs.'
  ) then
    create policy "Users can upsert their own skin prefs."
      on public.user_skin_prefs for insert
      with check (auth.uid() = user_id);
    create policy "Users can update their own skin prefs."
      on public.user_skin_prefs for update
      using (auth.uid() = user_id);
  end if;
end
$$;

-- ----------------------------------------------------------------------------
-- user_gpa_scenarios
-- ----------------------------------------------------------------------------
create table if not exists public.user_gpa_scenarios (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  scenarios_json jsonb not null default '[]'::jsonb,
  updated_at     timestamptz not null default now()
);

alter table public.user_gpa_scenarios enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_gpa_scenarios'
      and policyname = 'Users can read their own GPA scenarios.'
  ) then
    create policy "Users can read their own GPA scenarios."
      on public.user_gpa_scenarios for select
      using (auth.uid() = user_id);
    create policy "Users can insert their own GPA scenarios."
      on public.user_gpa_scenarios for insert
      with check (auth.uid() = user_id);
    create policy "Users can update their own GPA scenarios."
      on public.user_gpa_scenarios for update
      using (auth.uid() = user_id);
  end if;
end
$$;

-- ----------------------------------------------------------------------------
-- user_dashboard_notes
-- ----------------------------------------------------------------------------
create table if not exists public.user_dashboard_notes (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  notes_json jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_dashboard_notes enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_dashboard_notes'
      and policyname = 'Users can read their own dashboard notes.'
  ) then
    create policy "Users can read their own dashboard notes."
      on public.user_dashboard_notes for select
      using (auth.uid() = user_id);
    create policy "Users can insert their own dashboard notes."
      on public.user_dashboard_notes for insert
      with check (auth.uid() = user_id);
    create policy "Users can update their own dashboard notes."
      on public.user_dashboard_notes for update
      using (auth.uid() = user_id);
  end if;
end
$$;

-- ----------------------------------------------------------------------------
-- user_custom_todos
-- ----------------------------------------------------------------------------
create table if not exists public.user_custom_todos (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  todos_json jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_custom_todos enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_custom_todos'
      and policyname = 'Users can read their own custom todos.'
  ) then
    create policy "Users can read their own custom todos."
      on public.user_custom_todos for select
      using (auth.uid() = user_id);
    create policy "Users can insert their own custom todos."
      on public.user_custom_todos for insert
      with check (auth.uid() = user_id);
    create policy "Users can update their own custom todos."
      on public.user_custom_todos for update
      using (auth.uid() = user_id);
  end if;
end
$$;

-- ----------------------------------------------------------------------------
-- user_reminder_prefs
-- ----------------------------------------------------------------------------
create table if not exists public.user_reminder_prefs (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  prefs_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_reminder_prefs enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_reminder_prefs'
      and policyname = 'Users can read their own reminder prefs.'
  ) then
    create policy "Users can read their own reminder prefs."
      on public.user_reminder_prefs for select
      using (auth.uid() = user_id);
    create policy "Users can insert their own reminder prefs."
      on public.user_reminder_prefs for insert
      with check (auth.uid() = user_id);
    create policy "Users can update their own reminder prefs."
      on public.user_reminder_prefs for update
      using (auth.uid() = user_id);
  end if;
end
$$;

-- ----------------------------------------------------------------------------
-- Helpful index on updated_at (for "last-writer-wins" merges)
-- ----------------------------------------------------------------------------
create index if not exists user_skin_prefs_updated_at_idx        on public.user_skin_prefs (updated_at desc);
create index if not exists user_gpa_scenarios_updated_at_idx     on public.user_gpa_scenarios (updated_at desc);
create index if not exists user_dashboard_notes_updated_at_idx   on public.user_dashboard_notes (updated_at desc);
create index if not exists user_custom_todos_updated_at_idx      on public.user_custom_todos (updated_at desc);
create index if not exists user_reminder_prefs_updated_at_idx    on public.user_reminder_prefs (updated_at desc);
