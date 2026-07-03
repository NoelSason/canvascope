begin;

select plan(24);

select ok(to_regclass('public.course_material_documents') is not null, 'course_material_documents exists');
select ok(to_regclass('public.course_material_chunks') is not null, 'course_material_chunks exists');

select ok((
  select c.relrowsecurity
  from pg_class as c
  join pg_namespace as n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'course_material_documents'
), 'course_material_documents has RLS enabled');

select ok((
  select c.relrowsecurity
  from pg_class as c
  join pg_namespace as n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'course_material_chunks'
), 'course_material_chunks has RLS enabled');

select ok(exists(
  select 1 from pg_policies
  where schemaname = 'public'
    and tablename = 'course_material_documents'
    and policyname = 'Users can view their own course material documents.'
), 'course material documents select policy exists');

select ok(exists(
  select 1 from pg_policies
  where schemaname = 'public'
    and tablename = 'course_material_documents'
    and policyname = 'Users can insert their own course material documents.'
), 'course material documents insert policy exists');

select ok(exists(
  select 1 from pg_policies
  where schemaname = 'public'
    and tablename = 'course_material_documents'
    and policyname = 'Users can update their own course material documents.'
), 'course material documents update policy exists');

select ok(exists(
  select 1 from pg_policies
  where schemaname = 'public'
    and tablename = 'course_material_documents'
    and policyname = 'Users can delete their own course material documents.'
), 'course material documents delete policy exists');

select ok(exists(
  select 1 from pg_policies
  where schemaname = 'public'
    and tablename = 'course_material_chunks'
    and policyname = 'Users can view their own course material chunks.'
), 'course material chunks select policy exists');

select ok(exists(
  select 1 from pg_policies
  where schemaname = 'public'
    and tablename = 'course_material_chunks'
    and policyname = 'Users can insert their own course material chunks.'
), 'course material chunks insert policy exists');

select ok(exists(
  select 1 from pg_policies
  where schemaname = 'public'
    and tablename = 'course_material_chunks'
    and policyname = 'Users can update their own course material chunks.'
), 'course material chunks update policy exists');

select ok(exists(
  select 1 from pg_policies
  where schemaname = 'public'
    and tablename = 'course_material_chunks'
    and policyname = 'Users can delete their own course material chunks.'
), 'course material chunks delete policy exists');

select ok(to_regclass('public.course_material_documents_user_course_file_idx') is not null, 'document user-course-file index exists');
select ok(to_regclass('public.course_material_documents_user_course_week_idx') is not null, 'document user-course-week index exists');
select ok(to_regclass('public.course_material_documents_user_status_idx') is not null, 'document user-status index exists');
select ok(to_regclass('public.course_material_chunks_document_idx') is not null, 'chunk document index exists');
select ok(to_regclass('public.course_material_chunks_user_course_week_idx') is not null, 'chunk user-course-week index exists');
select ok(to_regclass('public.course_material_chunks_search_idx') is not null, 'chunk full-text search index exists');

select ok(to_regprocedure('public.search_course_materials(text,text,integer,date,date)') is not null, 'search_course_materials RPC exists');

select ok((
  select position('indexed' in pg_get_constraintdef(oid)) > 0
  from pg_constraint
  where conname = 'course_material_documents_status_check'
), 'document status check includes indexed');

select ok(exists(
  select 1
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'course_material_chunks'
    and column_name = 'search_vector'
    and is_generated = 'ALWAYS'
), 'course material chunks search_vector is generated');

select ok(exists(
  select 1
  from information_schema.table_privileges
  where table_schema = 'public'
    and table_name = 'course_material_documents'
    and grantee = 'authenticated'
    and privilege_type = 'SELECT'
), 'authenticated can select course material documents through Data API');

select ok(exists(
  select 1
  from information_schema.routine_privileges
  where routine_schema = 'public'
    and routine_name = 'search_course_materials'
    and grantee = 'authenticated'
    and privilege_type = 'EXECUTE'
), 'authenticated can execute search_course_materials');

select ok(exists(
  select 1
  from pg_index as i
  join pg_class as c on c.oid = i.indexrelid
  join unnest(i.indclass) as cls(opclass_oid) on true
  join pg_opclass as op on op.oid = cls.opclass_oid
  where c.relname = 'course_material_chunks_search_idx'
    and op.opcname = 'tsvector_ops'
), 'course material search index uses tsvector ops');

select * from finish();

rollback;
