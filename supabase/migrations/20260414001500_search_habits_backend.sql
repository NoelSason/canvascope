create table if not exists public.search_events (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.users(id) on delete cascade not null,
  event_kind text not null check (
    event_kind in ('query_submitted', 'result_clicked', 'suggestion_shown', 'suggestion_clicked')
  ),
  raw_query text not null default '',
  normalized_query text not null default '',
  base_query text not null default '',
  sequence_number integer,
  local_timezone text not null default 'UTC',
  local_day_of_week integer not null check (local_day_of_week between 0 and 6),
  local_hour_bucket integer not null check (local_hour_bucket between 0 and 23),
  local_week_index integer not null,
  clicked_item_id text,
  clicked_item_type text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.search_events enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'search_events'
      and policyname = 'Users can view their own search events.'
  ) then
    create policy "Users can view their own search events."
      on public.search_events for select
      using (auth.uid() = user_id);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'search_events'
      and policyname = 'Users can insert their own search events.'
  ) then
    create policy "Users can insert their own search events."
      on public.search_events for insert
      with check (auth.uid() = user_id);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'search_events'
      and policyname = 'Users can update their own search events.'
  ) then
    create policy "Users can update their own search events."
      on public.search_events for update
      using (auth.uid() = user_id);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'search_events'
      and policyname = 'Users can delete their own search events.'
  ) then
    create policy "Users can delete their own search events."
      on public.search_events for delete
      using (auth.uid() = user_id);
  end if;
end
$$;

create index if not exists search_events_user_slot_created_idx
  on public.search_events (user_id, local_day_of_week, local_hour_bucket, created_at desc);

create index if not exists search_events_user_base_query_idx
  on public.search_events (user_id, base_query, created_at desc);

create table if not exists public.search_patterns (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.users(id) on delete cascade not null,
  base_query text not null,
  local_day_of_week integer not null check (local_day_of_week between 0 and 6),
  local_hour_bucket integer not null check (local_hour_bucket between 0 and 23),
  last_sequence_number integer,
  last_seen_week_index integer,
  consecutive_weeks integer not null default 0,
  query_submit_count integer not null default 0,
  result_click_count integer not null default 0,
  suggestion_impression_count integer not null default 0,
  suggestion_click_count integer not null default 0,
  predicted_query text,
  confidence double precision not null default 0,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique (user_id, base_query, local_day_of_week, local_hour_bucket)
);

alter table public.search_patterns enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'search_patterns'
      and policyname = 'Users can view their own search patterns.'
  ) then
    create policy "Users can view their own search patterns."
      on public.search_patterns for select
      using (auth.uid() = user_id);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'search_patterns'
      and policyname = 'Users can insert their own search patterns.'
  ) then
    create policy "Users can insert their own search patterns."
      on public.search_patterns for insert
      with check (auth.uid() = user_id);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'search_patterns'
      and policyname = 'Users can update their own search patterns.'
  ) then
    create policy "Users can update their own search patterns."
      on public.search_patterns for update
      using (auth.uid() = user_id);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'search_patterns'
      and policyname = 'Users can delete their own search patterns.'
  ) then
    create policy "Users can delete their own search patterns."
      on public.search_patterns for delete
      using (auth.uid() = user_id);
  end if;
end
$$;

create index if not exists search_patterns_user_slot_confidence_idx
  on public.search_patterns (user_id, local_day_of_week, local_hour_bucket, confidence desc);

create index if not exists search_patterns_user_predicted_query_idx
  on public.search_patterns (user_id, predicted_query);
