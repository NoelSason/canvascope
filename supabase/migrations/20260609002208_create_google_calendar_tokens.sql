create table if not exists public.google_calendar_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  refresh_token text not null,
  access_token text,
  access_token_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.google_calendar_tokens enable row level security;

create policy "google_calendar_tokens_select_own"
  on public.google_calendar_tokens
  for select using (auth.uid() = user_id);

create policy "google_calendar_tokens_insert_own"
  on public.google_calendar_tokens
  for insert with check (auth.uid() = user_id);

create policy "google_calendar_tokens_update_own"
  on public.google_calendar_tokens
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
