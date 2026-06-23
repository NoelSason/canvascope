-- DropBridge v3 targeted realtime receipts
-- Date: 2026-06-10
-- Purpose: support upload-id hot path telemetry without changing v2 API payloads.

create table if not exists public.dropbridge_receipts (
  id uuid primary key default gen_random_uuid(),
  upload_id uuid not null references public.uploads(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  stage text not null,
  source text not null default 'server',
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.dropbridge_receipts enable row level security;

revoke all on table public.dropbridge_receipts from anon, authenticated;

create index if not exists idx_dropbridge_receipts_upload_created
  on public.dropbridge_receipts(upload_id, created_at);

create index if not exists idx_dropbridge_receipts_user_upload_created
  on public.dropbridge_receipts(user_id, upload_id, created_at);

create index if not exists idx_devices_user_kind_last_seen
  on public.devices(user_id, client_kind, revoked_at, last_seen_at desc);

create index if not exists idx_uploads_direct_claim_lookup
  on public.uploads(user_id, device_id, id, status, expires_at);

create index if not exists idx_uploads_user_device_status_created_id
  on public.uploads(user_id, device_id, status, created_at, id);

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

  begin
    insert into public.dropbridge_receipts (
      upload_id,
      user_id,
      device_id,
      stage,
      source,
      detail
    )
    values (
      NEW.id,
      NEW.user_id,
      NEW.device_id,
      'wake_emitted',
      'realtime_trigger',
      jsonb_build_object(
        'operation', TG_OP,
        'fileName', NEW.file_name,
        'sizeBytes', NEW.size_bytes,
        'mimeType', NEW.mime_type,
        'createdAt', NEW.created_at
      )
    );
  exception
    when others then
      null;
  end;

  return NEW;
end;
$$;
