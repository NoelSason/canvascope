-- DropBridge v2: record the sender device on each upload so terminal status
-- (downloaded / canceled) can be broadcast back to the sender over realtime for
-- an instant "delivered" confirmation instead of polling.

alter table public.uploads
  add column if not exists sender_device_id uuid
    references public.devices(id) on delete set null;

create index if not exists idx_uploads_sender_device
  on public.uploads(sender_device_id);
