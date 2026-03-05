-- DropBridge v2 follow-up
-- Date: 2026-03-02
-- Purpose: align client_kind constraint with v2 function support.

alter table public.devices drop constraint if exists devices_client_kind_check;
alter table public.devices
  add constraint devices_client_kind_check
  check (client_kind in ('canvascope_extension', 'lectra_ipad', 'legacy_pairing'));
