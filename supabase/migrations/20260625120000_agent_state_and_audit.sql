-- ============================================================================
-- Canvascope Autonomous Agent — persistent state + audit log
--
--   agent_state  → one row per user: prefs, kill switch, last briefing,
--                  dismissed suggestions, memory notes (state_json blob).
--                  Synced via the existing csTools upsert path (TOOLS_TABLES).
--   agent_audit  → append-only log of every tool the agent executed, every
--                  integrity block, and every undo. Powers the briefing card's
--                  action list + undo, and cross-device visibility.
--
-- RLS: each user reads/writes only their own rows.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- agent_state (one row per user, upserted on user_id)
-- ----------------------------------------------------------------------------
create table if not exists public.agent_state (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  state_json  jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.agent_state enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'agent_state'
      and policyname = 'Users can read their own agent state.'
  ) then
    create policy "Users can read their own agent state."
      on public.agent_state for select
      using (auth.uid() = user_id);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'agent_state'
      and policyname = 'Users can insert their own agent state.'
  ) then
    create policy "Users can insert their own agent state."
      on public.agent_state for insert
      with check (auth.uid() = user_id);
    create policy "Users can update their own agent state."
      on public.agent_state for update
      using (auth.uid() = user_id);
  end if;
end
$$;

-- ----------------------------------------------------------------------------
-- agent_audit (append-only)
-- ----------------------------------------------------------------------------
create table if not exists public.agent_audit (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  run_id      text,
  ts          timestamptz not null default now(),
  tool        text not null,
  input       jsonb,
  result      jsonb,
  status      text not null,            -- ok | error | integrity_block | undone | paused | loop_truncated
  undoable    boolean not null default false,
  undo_ref    jsonb,
  undone_at   timestamptz
);

create index if not exists agent_audit_user_ts_idx
  on public.agent_audit (user_id, ts desc);

alter table public.agent_audit enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'agent_audit'
      and policyname = 'Users can read their own agent audit.'
  ) then
    create policy "Users can read their own agent audit."
      on public.agent_audit for select
      using (auth.uid() = user_id);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'agent_audit'
      and policyname = 'Users can insert their own agent audit.'
  ) then
    create policy "Users can insert their own agent audit."
      on public.agent_audit for insert
      with check (auth.uid() = user_id);
  end if;
  -- Undo marks a prior row undone; allow the owner to update their own rows.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'agent_audit'
      and policyname = 'Users can update their own agent audit.'
  ) then
    create policy "Users can update their own agent audit."
      on public.agent_audit for update
      using (auth.uid() = user_id);
  end if;
end
$$;
