-- DropBridge v2 account-linked upgrade
-- Date: 2026-02-27
-- Purpose: add same-account receiver routing while preserving v1 pairing flow.

alter table public.devices
  add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.devices
  add column if not exists client_kind text not null default 'canvascope_extension';
alter table public.devices
  alter column device_token_hash drop not null;
alter table public.uploads
  add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.uploads
  add column if not exists expires_at timestamptz not null default (now() + interval '24 hour');
update public.uploads as u
set user_id = d.user_id
from public.devices as d
where u.device_id = d.id
  and u.user_id is null
  and d.user_id is not null;
create index if not exists idx_devices_user_last_seen
  on public.devices(user_id, last_seen_at desc);
create index if not exists idx_uploads_user_device_status_created
  on public.uploads(user_id, device_id, status, created_at);
alter table public.devices drop constraint if exists devices_v1_or_v2_identity_check;
alter table public.devices
  add constraint devices_v1_or_v2_identity_check
  check (
    device_token_hash is not null
    or user_id is not null
  );
alter table public.devices drop constraint if exists devices_client_kind_check;
alter table public.devices
  add constraint devices_client_kind_check
  check (client_kind in ('canvascope_extension', 'legacy_pairing'));
