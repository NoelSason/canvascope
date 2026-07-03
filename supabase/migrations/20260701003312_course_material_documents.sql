create table if not exists public.course_material_documents (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  course_id text not null,
  course_name text not null,
  canvas_file_id text,
  source_url text not null,
  download_url text,
  title text not null,
  mime_type text,
  folder_path text,
  module_name text,
  week_start date,
  week_end date,
  week_hints text[] not null default '{}'::text[],
  content_hash text,
  status text not null default 'queued'
    check (status in ('queued', 'indexing', 'indexed', 'failed', 'skipped')),
  page_count integer not null default 0 check (page_count >= 0),
  text_length integer not null default 0 check (text_length >= 0),
  parse_error text,
  discovered_at timestamptz not null default timezone('utc'::text, now()),
  indexed_at timestamptz,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now())
);

create table if not exists public.course_material_chunks (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  document_id text not null references public.course_material_documents(id) on delete cascade,
  course_id text not null,
  course_name text not null,
  canvas_file_id text,
  title text not null,
  page_start integer,
  page_end integer,
  chunk_index integer not null default 0 check (chunk_index >= 0),
  text text not null,
  folder_path text,
  module_name text,
  week_start date,
  week_end date,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  search_vector tsvector generated always as (
    to_tsvector(
      'english',
      coalesce(title, '') || ' ' ||
      coalesce(course_name, '') || ' ' ||
      coalesce(module_name, '') || ' ' ||
      coalesce(folder_path, '') || ' ' ||
      coalesce(text, '')
    )
  ) stored
);

create unique index if not exists course_material_documents_user_course_file_idx
  on public.course_material_documents (user_id, course_id, canvas_file_id)
  where canvas_file_id is not null;

create index if not exists course_material_documents_user_course_week_idx
  on public.course_material_documents (user_id, course_id, week_start, week_end);

create index if not exists course_material_documents_user_status_idx
  on public.course_material_documents (user_id, status);

create index if not exists course_material_chunks_document_idx
  on public.course_material_chunks (document_id);

create index if not exists course_material_chunks_user_course_week_idx
  on public.course_material_chunks (user_id, course_id, week_start, week_end);

create index if not exists course_material_chunks_search_idx
  on public.course_material_chunks using gin (search_vector);

alter table public.course_material_documents enable row level security;
alter table public.course_material_chunks enable row level security;

create policy "Users can view their own course material documents."
  on public.course_material_documents for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert their own course material documents."
  on public.course_material_documents for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own course material documents."
  on public.course_material_documents for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own course material documents."
  on public.course_material_documents for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can view their own course material chunks."
  on public.course_material_chunks for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert their own course material chunks."
  on public.course_material_chunks for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own course material chunks."
  on public.course_material_chunks for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own course material chunks."
  on public.course_material_chunks for delete
  to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.course_material_documents to authenticated;
grant select, insert, update, delete on public.course_material_chunks to authenticated;

create or replace function public.search_course_materials(
  p_course_id text,
  p_query text,
  p_limit integer default 8,
  p_week_start date default null,
  p_week_end date default null
)
returns table (
  chunk_id text,
  document_id text,
  title text,
  course_id text,
  course_name text,
  source_url text,
  page_start integer,
  page_end integer,
  folder_path text,
  module_name text,
  week_start date,
  week_end date,
  text text,
  rank real
)
language sql
stable
security invoker
set search_path = public
as $$
  with query as (
    select websearch_to_tsquery('english', coalesce(nullif(trim(p_query), ''), 'course materials')) as tsq
  )
  select
    c.id as chunk_id,
    c.document_id,
    c.title,
    c.course_id,
    c.course_name,
    d.source_url,
    c.page_start,
    c.page_end,
    c.folder_path,
    c.module_name,
    c.week_start,
    c.week_end,
    c.text,
    ts_rank(c.search_vector, query.tsq) as rank
  from public.course_material_chunks as c
  join public.course_material_documents as d
    on d.id = c.document_id
   and d.user_id = c.user_id
  cross join query
  where c.user_id = (select auth.uid())
    and (p_course_id is null or p_course_id = '' or c.course_id = p_course_id)
    and (p_week_start is null or c.week_end is null or c.week_end >= p_week_start)
    and (p_week_end is null or c.week_start is null or c.week_start <= p_week_end)
    and c.search_vector @@ query.tsq
  order by rank desc, c.title asc, c.page_start nulls last, c.chunk_index asc
  limit greatest(1, least(coalesce(p_limit, 8), 24));
$$;

grant execute on function public.search_course_materials(text, text, integer, date, date)
  to authenticated;
