-- DropBridge installer schema
-- Date: 2026-02-25
-- Safe to run multiple times.

create extension if not exists pgcrypto;
create table if not exists public.devices (
  id uuid primary key,
  name text not null default 'My PC',
  device_token_hash text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);
create table if not exists public.uploads (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  file_name text not null,
  object_path text not null unique,
  mime_type text,
  size_bytes bigint not null,
  status text not null default 'queued',
  claimed_at timestamptz,
  downloaded_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_devices_last_seen on public.devices(last_seen_at desc);
create index if not exists idx_uploads_device_status_created on public.uploads(device_id, status, created_at);
alter table public.devices enable row level security;
alter table public.uploads enable row level security;
alter table public.uploads drop constraint if exists uploads_status_check;
alter table public.uploads
  add constraint uploads_status_check
  check (status in ('queued', 'downloading', 'downloaded', 'canceled'));
insert into storage.buckets (id, name, public, file_size_limit)
values ('drops', 'drops', false, 26214400)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit;
-- No client-facing policies are added on public tables or storage.objects.
-- All sensitive actions are handled by Edge Functions using service role key.;
