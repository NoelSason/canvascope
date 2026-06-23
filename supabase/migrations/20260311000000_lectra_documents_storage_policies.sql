-- Create the lectra_documents bucket if it doesn't exist
insert into storage.buckets (id, name, public, file_size_limit)
values ('lectra_documents', 'lectra_documents', false, 52428800) -- 50MB
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit;

-- Enable RLS on storage.objects (if not already enabled)
alter table storage.objects enable row level security;

-- Storage Policies for lectra_documents bucket

create policy "Users can view their own documents"
  on storage.objects for select
  to authenticated
  using ( bucket_id = 'lectra_documents' and (storage.foldername(name))[1] = auth.uid()::text );

create policy "Users can insert their own documents"
  on storage.objects for insert
  to authenticated
  with check ( bucket_id = 'lectra_documents' and (storage.foldername(name))[1] = auth.uid()::text );

create policy "Users can update their own documents"
  on storage.objects for update
  to authenticated
  using ( bucket_id = 'lectra_documents' and (storage.foldername(name))[1] = auth.uid()::text );

create policy "Users can delete their own documents"
  on storage.objects for delete
  to authenticated
  using ( bucket_id = 'lectra_documents' and (storage.foldername(name))[1] = auth.uid()::text );
