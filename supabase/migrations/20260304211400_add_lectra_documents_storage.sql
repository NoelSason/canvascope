-- Ensure the Storage bucket used by Canvascope <-> Lectra PDF sync exists.
-- Path contract: {auth.uid()}/lectra_documents/...
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'lectra_documents',
  'lectra_documents',
  false,
  26214400,
  array['application/pdf']
)
on conflict (id) do update
set
  name = excluded.name,
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Allow authenticated users to insert files in their own top-level folder.
do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Users can upload their own Lectra PDFs'
  ) then
    create policy "Users can upload their own Lectra PDFs"
      on storage.objects
      for insert
      to authenticated
      with check (
        bucket_id = 'lectra_documents'
        and (storage.foldername(name))[1] = auth.uid()::text
      );
  end if;
end
$$;

-- Allow authenticated users to read files in their own folder.
do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Users can read their own Lectra PDFs'
  ) then
    create policy "Users can read their own Lectra PDFs"
      on storage.objects
      for select
      to authenticated
      using (
        bucket_id = 'lectra_documents'
        and (storage.foldername(name))[1] = auth.uid()::text
      );
  end if;
end
$$;

-- Allow authenticated users to update files in their own folder.
do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Users can update their own Lectra PDFs'
  ) then
    create policy "Users can update their own Lectra PDFs"
      on storage.objects
      for update
      to authenticated
      using (
        bucket_id = 'lectra_documents'
        and (storage.foldername(name))[1] = auth.uid()::text
      )
      with check (
        bucket_id = 'lectra_documents'
        and (storage.foldername(name))[1] = auth.uid()::text
      );
  end if;
end
$$;

-- Allow authenticated users to delete files in their own folder.
do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Users can delete their own Lectra PDFs'
  ) then
    create policy "Users can delete their own Lectra PDFs"
      on storage.objects
      for delete
      to authenticated
      using (
        bucket_id = 'lectra_documents'
        and (storage.foldername(name))[1] = auth.uid()::text
      );
  end if;
end
$$;
