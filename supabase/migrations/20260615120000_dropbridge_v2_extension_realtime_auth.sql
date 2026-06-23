-- Broaden DropBridge Realtime topic authorization to both device kinds.
--
-- The original policy (20260310113000) only authorized lectra_ipad device
-- topics. That is enough for Canvascope->Lectra wakes and for the iPad sender to
-- receive its own delivery confirmation. The Canvascope extension now also
-- subscribes to its own device topic for instant `file_drop` wakes, so its
-- canvascope_extension device must be authorizable too. Auth still requires the
-- topic's user to be the caller and the device to belong to that user.

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
        and d.client_kind in ('lectra_ipad', 'canvascope_extension')
        and d.revoked_at is null
    );
$$;

revoke all on function public.authorize_dropbridge_realtime_topic(text) from public;

grant execute on function public.authorize_dropbridge_realtime_topic(text) to authenticated, service_role;
