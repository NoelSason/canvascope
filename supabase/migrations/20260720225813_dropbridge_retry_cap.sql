-- DropBridge retry cap.
--
-- A queued upload was re-claimed every fallback-poll cycle (2 min) until its
-- 24h expiry, and each claim minted a fresh signed URL that pulled the whole
-- file out of Storage again. With no attempt counter that is 720 downloads of
-- one object -- up to 18 GB of egress from a single 25 MB file.
--
-- Attempts are counted at claim time rather than on the client ack: the claim
-- is the only place a signed URL is issued, so counting here bounds egress even
-- when the receiver dies mid-download and never acks.

alter table public.uploads
  add column if not exists attempts int not null default 0;

alter table public.uploads drop constraint if exists uploads_status_check;
alter table public.uploads
  add constraint uploads_status_check
  check (status in ('queued', 'downloading', 'downloaded', 'canceled', 'failed'));

-- Claim queued uploads, incrementing attempts, and burn out anything that has
-- already spent its retry budget. Single statement per branch so concurrent
-- receivers can't both claim the same row.
create or replace function public.claim_dropbridge_uploads(
  p_user_id uuid,
  p_device_id uuid,
  p_ids uuid[],
  p_max_attempts int
)
returns table (
  id uuid,
  file_name text,
  object_path text,
  mime_type text,
  size_bytes bigint,
  created_at timestamptz,
  expires_at timestamptz,
  attempts int,
  sender_device_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.uploads u
     set status = 'failed',
         claimed_at = null
   where u.id = any(p_ids)
     and u.user_id = p_user_id
     and u.device_id = p_device_id
     and u.status = 'queued'
     and u.attempts >= p_max_attempts;

  return query
  update public.uploads u
     set status = 'downloading',
         claimed_at = now(),
         attempts = u.attempts + 1
   where u.id = any(p_ids)
     and u.user_id = p_user_id
     and u.device_id = p_device_id
     and u.status = 'queued'
     and u.attempts < p_max_attempts
  returning u.id, u.file_name, u.object_path, u.mime_type, u.size_bytes,
            u.created_at, u.expires_at, u.attempts, u.sender_device_id;
end;
$$;

revoke all on function public.claim_dropbridge_uploads(uuid, uuid, uuid[], int) from public;
grant execute on function public.claim_dropbridge_uploads(uuid, uuid, uuid[], int) to service_role;
