begin;

select plan(17);

select ok(to_regclass('public.search_events') is not null, 'public.search_events exists');
select ok(to_regclass('public.search_patterns') is not null, 'public.search_patterns exists');

select ok((
  select c.relrowsecurity
  from pg_class as c
  join pg_namespace as n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'search_events'
), 'public.search_events has RLS enabled');

select ok((
  select c.relrowsecurity
  from pg_class as c
  join pg_namespace as n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'search_patterns'
), 'public.search_patterns has RLS enabled');

select ok(exists(
  select 1
  from pg_policies
  where schemaname = 'public'
    and tablename = 'search_events'
    and policyname = 'Users can view their own search events.'
), 'search_events select policy exists');

select ok(exists(
  select 1
  from pg_policies
  where schemaname = 'public'
    and tablename = 'search_events'
    and policyname = 'Users can insert their own search events.'
), 'search_events insert policy exists');

select ok(exists(
  select 1
  from pg_policies
  where schemaname = 'public'
    and tablename = 'search_events'
    and policyname = 'Users can update their own search events.'
), 'search_events update policy exists');

select ok(exists(
  select 1
  from pg_policies
  where schemaname = 'public'
    and tablename = 'search_events'
    and policyname = 'Users can delete their own search events.'
), 'search_events delete policy exists');

select ok(exists(
  select 1
  from pg_policies
  where schemaname = 'public'
    and tablename = 'search_patterns'
    and policyname = 'Users can view their own search patterns.'
), 'search_patterns select policy exists');

select ok(exists(
  select 1
  from pg_policies
  where schemaname = 'public'
    and tablename = 'search_patterns'
    and policyname = 'Users can insert their own search patterns.'
), 'search_patterns insert policy exists');

select ok(exists(
  select 1
  from pg_policies
  where schemaname = 'public'
    and tablename = 'search_patterns'
    and policyname = 'Users can update their own search patterns.'
), 'search_patterns update policy exists');

select ok(exists(
  select 1
  from pg_policies
  where schemaname = 'public'
    and tablename = 'search_patterns'
    and policyname = 'Users can delete their own search patterns.'
), 'search_patterns delete policy exists');

select ok(to_regclass('public.search_events_user_slot_created_idx') is not null, 'search_events user-slot index exists');
select ok(to_regclass('public.search_events_user_base_query_idx') is not null, 'search_events base-query index exists');
select ok(to_regclass('public.search_patterns_user_slot_confidence_idx') is not null, 'search_patterns slot-confidence index exists');
select ok(to_regclass('public.search_patterns_user_predicted_query_idx') is not null, 'search_patterns predicted-query index exists');

select ok((
  select position('query_submitted' in pg_get_constraintdef(oid)) > 0
  from pg_constraint
  where conname = 'search_events_event_kind_check'
), 'search_events event kind check exists');

select * from finish();

rollback;
