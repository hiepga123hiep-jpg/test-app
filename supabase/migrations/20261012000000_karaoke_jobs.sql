create table if not exists public.karaoke_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  prediction_id text not null unique,
  created_at timestamptz not null default now()
);

alter table public.karaoke_jobs enable row level security;
revoke all on public.karaoke_jobs from anon, authenticated;
grant all on public.karaoke_jobs to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'karaoke-inputs',
  'karaoke-inputs',
  false,
  26214400,
  array['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/ogg', 'audio/aac', 'audio/webm']
)
on conflict (id) do update
set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "Users upload their own karaoke files"
on storage.objects for insert to authenticated
with check (bucket_id = 'karaoke-inputs' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users read their own karaoke files"
on storage.objects for select to authenticated
using (bucket_id = 'karaoke-inputs' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users delete their own karaoke files"
on storage.objects for delete to authenticated
using (bucket_id = 'karaoke-inputs' and (storage.foldername(name))[1] = auth.uid()::text);
