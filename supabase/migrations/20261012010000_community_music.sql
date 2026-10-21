create table if not exists public.published_tracks (
  id uuid primary key default gen_random_uuid(),
  uploader_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  artist text not null,
  album text not null default 'Thư viện SpotiSix',
  search_text text not null,
  object_path text not null unique,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 52428800),
  created_at timestamptz not null default now()
);

alter table public.published_tracks enable row level security;
grant select on public.published_tracks to anon, authenticated;
grant insert, delete on public.published_tracks to authenticated;

drop policy if exists "Anyone can browse published music" on public.published_tracks;
create policy "Anyone can browse published music"
on public.published_tracks for select
to anon, authenticated
using (true);

drop policy if exists "Users publish their own music" on public.published_tracks;
create policy "Users publish their own music"
on public.published_tracks for insert
to authenticated
with check (uploader_id = auth.uid());

drop policy if exists "Users remove their own published music" on public.published_tracks;
create policy "Users remove their own published music"
on public.published_tracks for delete
to authenticated
using (uploader_id = auth.uid());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'community-music',
  'community-music',
  true,
  52428800,
  array['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/ogg', 'audio/aac', 'audio/webm']
)
on conflict (id) do update
set public = true,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users upload their own community music" on storage.objects;
create policy "Users upload their own community music"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'community-music'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Users delete their own community music" on storage.objects;
create policy "Users delete their own community music"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'community-music'
  and (storage.foldername(name))[1] = auth.uid()::text
);
