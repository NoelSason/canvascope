begin;

select plan(36);

select ok(to_regclass('public.users') is not null, 'public.users exists');
select ok(to_regclass('public.preferences') is not null, 'public.preferences exists');
select ok(to_regclass('public.synced_items') is not null, 'public.synced_items exists');
select ok(to_regclass('public.devices') is not null, 'public.devices exists');
select ok(to_regclass('public.uploads') is not null, 'public.uploads exists');
select ok(to_regclass('public.app_users') is not null, 'public.app_users exists');
select ok(to_regclass('public.schools') is not null, 'public.schools exists');
select ok(to_regclass('public.requirements') is not null, 'public.requirements exists');
select ok(to_regclass('public.user_course_profiles') is not null, 'public.user_course_profiles exists');
select ok(to_regclass('public.user_course_entries') is not null, 'public.user_course_entries exists');
select ok(to_regclass('public.user_canvascope_course_mappings') is not null, 'public.user_canvascope_course_mappings exists');
select ok(to_regclass('public.import_runs') is not null, 'public.import_runs exists');

select ok((
  select c.relrowsecurity
  from pg_class as c
  join pg_namespace as n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'users'
), 'public.users has RLS enabled');

select ok((
  select c.relrowsecurity
  from pg_class as c
  join pg_namespace as n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'preferences'
), 'public.preferences has RLS enabled');

select ok((
  select c.relrowsecurity
  from pg_class as c
  join pg_namespace as n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'synced_items'
), 'public.synced_items has RLS enabled');

select ok((
  select c.relrowsecurity
  from pg_class as c
  join pg_namespace as n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'devices'
), 'public.devices has RLS enabled');

select ok((
  select c.relrowsecurity
  from pg_class as c
  join pg_namespace as n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'uploads'
), 'public.uploads has RLS enabled');

select ok(exists(
  select 1
  from storage.buckets
  where id = 'drops'
), 'drops storage bucket exists');

select ok(coalesce((
  select file_size_limit = 26214400
  from storage.buckets
  where id = 'drops'
), false), 'drops bucket enforces a 25 MiB file limit');

select ok(exists(
  select 1
  from storage.buckets
  where id = 'lectra_documents'
), 'lectra_documents storage bucket exists');

select ok(coalesce((
  select allowed_mime_types = array['application/pdf']::text[]
  from storage.buckets
  where id = 'lectra_documents'
), false), 'lectra_documents bucket only allows PDFs');

select ok(to_regprocedure('public.authorize_dropbridge_realtime_topic(text)') is not null, 'authorize_dropbridge_realtime_topic(text) exists');
select ok(to_regprocedure('public.dropbridge_claim_background_push_slot(uuid, integer)') is not null, 'dropbridge_claim_background_push_slot(uuid, integer) exists');

select ok(exists(
  select 1
  from pg_trigger
  where tgname = 'dropbridge_upload_wake_broadcast'
    and not tgisinternal
), 'dropbridge upload wake trigger exists');

select ok(exists(
  select 1
  from pg_policies
  where schemaname = 'realtime'
    and tablename = 'messages'
    and policyname = 'dropbridge authenticated can receive wake broadcasts'
), 'realtime wake broadcast policy exists');

select ok((
  select position('lectra_ipad' in pg_get_constraintdef(oid)) > 0
  from pg_constraint
  where conname = 'devices_client_kind_check'
), 'devices_client_kind_check includes lectra_ipad');

select ok((
  select position('queued' in pg_get_constraintdef(oid)) > 0
  from pg_constraint
  where conname = 'uploads_status_check'
), 'uploads_status_check allows queued');

select ok((
  select position('downloading' in pg_get_constraintdef(oid)) > 0
  from pg_constraint
  where conname = 'uploads_status_check'
), 'uploads_status_check allows downloading');

select ok((
  select position('downloaded' in pg_get_constraintdef(oid)) > 0
  from pg_constraint
  where conname = 'uploads_status_check'
), 'uploads_status_check allows downloaded');

select ok((
  select position('canceled' in pg_get_constraintdef(oid)) > 0
  from pg_constraint
  where conname = 'uploads_status_check'
), 'uploads_status_check allows canceled');

select ok(exists(
  select 1
  from pg_policies
  where schemaname = 'public'
    and tablename = 'users'
    and policyname = 'Users can view their own profile.'
), 'users select policy exists');

select ok(exists(
  select 1
  from pg_policies
  where schemaname = 'public'
    and tablename = 'synced_items'
    and policyname = 'Users can insert their own synced items.'
), 'synced_items insert policy exists');

select ok(exists(
  select 1
  from pg_policies
  where schemaname = 'storage'
    and tablename = 'objects'
    and policyname = 'Users can upload their own Lectra PDFs'
), 'lectra storage insert policy exists');

select ok(exists(
  select 1
  from pg_policies
  where schemaname = 'storage'
    and tablename = 'objects'
    and policyname = 'Users can read their own Lectra PDFs'
), 'lectra storage read policy exists');

select ok(exists(
  select 1
  from pg_policies
  where schemaname = 'storage'
    and tablename = 'objects'
    and policyname = 'Users can update their own Lectra PDFs'
), 'lectra storage update policy exists');

select ok(exists(
  select 1
  from pg_policies
  where schemaname = 'storage'
    and tablename = 'objects'
    and policyname = 'Users can delete their own Lectra PDFs'
), 'lectra storage delete policy exists');

select * from finish();

rollback;
