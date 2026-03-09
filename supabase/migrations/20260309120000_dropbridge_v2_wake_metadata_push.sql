-- DropBridge v2 wake-up + metadata + push delivery
-- Date: 2026-03-09
-- Purpose: add upload metadata, private realtime wake auth, and iPad push token plumbing.

alter table public.uploads
  add column if not exists metadata jsonb not null default '{}'::jsonb;

update public.uploads
set metadata = '{}'::jsonb
where metadata is null;

alter table public.devices
  add column if not exists push_token text;

alter table public.devices
  add column if not exists push_environment text;

alter table public.devices
  add column if not exists push_token_updated_at timestamptz;

alter table public.devices
  add column if not exists last_background_push_at timestamptz;

alter table public.devices drop constraint if exists devices_push_environment_check;
alter table public.devices
  add constraint devices_push_environment_check
  check (push_environment is null or push_environment in ('sandbox', 'production'));

create or replace function public.dropbridge_wake_topic(target_user_id uuid, target_device_id uuid)
returns text
language sql
immutable
set search_path = public
as $$
  select 'dropbridge:user:' || target_user_id::text || ':device:' || target_device_id::text
$$;

create or replace function public.authorize_dropbridge_realtime_topic(topic text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    auth.uid() is not null
    and split_part(topic, ':', 1) = 'dropbridge'
    and split_part(topic, ':', 2) = 'user'
    and split_part(topic, ':', 4) = 'device'
    and split_part(topic, ':', 6) = ''
    and split_part(topic, ':', 3) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and split_part(topic, ':', 5) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and split_part(topic, ':', 3)::uuid = auth.uid()
    and exists (
      select 1
      from public.devices as d
      where d.id = split_part(topic, ':', 5)::uuid
        and d.user_id = auth.uid()
        and d.revoked_at is null
    );
$$;

revoke all on function public.authorize_dropbridge_realtime_topic(text) from public;
grant execute on function public.authorize_dropbridge_realtime_topic(text) to authenticated, service_role;

create or replace function public.dropbridge_claim_background_push_slot(
  target_device_id uuid,
  min_interval_seconds integer default 30
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_count integer := 0;
begin
  update public.devices
  set last_background_push_at = now()
  where id = target_device_id
    and revoked_at is null
    and (
      last_background_push_at is null
      or last_background_push_at <= now() - make_interval(secs => greatest(min_interval_seconds, 0))
    );

  get diagnostics updated_count = row_count;
  return updated_count > 0;
end;
$$;

revoke all on function public.dropbridge_claim_background_push_slot(uuid, integer) from public;
grant execute on function public.dropbridge_claim_background_push_slot(uuid, integer) to service_role;

create or replace function public.dropbridge_emit_upload_wake()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.user_id is null or NEW.device_id is null or NEW.status <> 'queued' then
    return NEW;
  end if;

  if TG_OP = 'UPDATE'
    and OLD.status = 'queued'
    and OLD.user_id is not distinct from NEW.user_id
    and OLD.device_id is not distinct from NEW.device_id then
    return NEW;
  end if;

  perform realtime.broadcast_changes(
    public.dropbridge_wake_topic(NEW.user_id, NEW.device_id),
    'upload_queued',
    TG_OP,
    TG_TABLE_NAME,
    TG_TABLE_SCHEMA,
    NEW,
    OLD
  );

  return NEW;
end;
$$;

drop trigger if exists dropbridge_upload_wake_broadcast on public.uploads;
create trigger dropbridge_upload_wake_broadcast
after insert or update of status, device_id, user_id on public.uploads
for each row
execute function public.dropbridge_emit_upload_wake();

alter table realtime.messages enable row level security;

drop policy if exists "dropbridge authenticated can receive wake broadcasts" on realtime.messages;
create policy "dropbridge authenticated can receive wake broadcasts"
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and public.authorize_dropbridge_realtime_topic(realtime.topic())
);
