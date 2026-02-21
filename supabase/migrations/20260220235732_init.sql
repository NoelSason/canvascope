-- Create Users table
create table public.users (
  id uuid references auth.users not null primary key,
  email text,
  full_name text,
  avatar_url text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS
alter table public.users enable row level security;

-- Create Policies
create policy "Users can view their own profile."
  on public.users for select
  using ( auth.uid() = id );

create policy "Users can update their own profile."
  on public.users for update
  using ( auth.uid() = id );

-- Function to handle new user signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.users (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$;

-- Trigger to call the function on signup
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Create Preferences table
create table public.preferences (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.users(id) on delete cascade not null,
  theme text default 'dark',
  notifications_enabled boolean default true,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique (user_id)
);

-- Enable RLS
alter table public.preferences enable row level security;

-- Create Policies
create policy "Users can view their own preferences."
  on public.preferences for select
  using ( auth.uid() = user_id );

create policy "Users can insert their own preferences."
  on public.preferences for insert
  with check ( auth.uid() = user_id );

create policy "Users can update their own preferences."
  on public.preferences for update
  using ( auth.uid() = user_id );

-- Create SyncedItems table
create table public.synced_items (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.users(id) on delete cascade not null,
  item_type text not null, -- e.g., 'document', 'search_history', 'bookmark'
  item_data jsonb not null default '{}'::jsonb,
  sync_status text default 'synced',
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS
alter table public.synced_items enable row level security;

-- Create Policies
create policy "Users can view their own synced items."
  on public.synced_items for select
  using ( auth.uid() = user_id );

create policy "Users can insert their own synced items."
  on public.synced_items for insert
  with check ( auth.uid() = user_id );

create policy "Users can update their own synced items."
  on public.synced_items for update
  using ( auth.uid() = user_id );

create policy "Users can delete their own synced items."
  on public.synced_items for delete
  using ( auth.uid() = user_id );
