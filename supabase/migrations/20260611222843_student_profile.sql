-- Student Profile: durable facts about the student (who/what/how + auto-captured
-- layer) used to personalize AI answers. One row per user, mirrors preferences.
create table public.student_profile (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.users(id) on delete cascade not null,
  facts jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique (user_id)
);
-- Enable RLS
alter table public.student_profile enable row level security;
-- Create Policies
create policy "Users can view their own student profile."
  on public.student_profile for select
  using ( auth.uid() = user_id );
create policy "Users can insert their own student profile."
  on public.student_profile for insert
  with check ( auth.uid() = user_id );
create policy "Users can update their own student profile."
  on public.student_profile for update
  using ( auth.uid() = user_id );
create policy "Users can delete their own student profile."
  on public.student_profile for delete
  using ( auth.uid() = user_id );
