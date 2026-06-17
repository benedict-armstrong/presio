-- Create sessions table
create table if not exists sessions (
  id text primary key,
  pdf_path text not null,
  filename text not null,
  total_slides integer not null,
  current_slide integer not null default 1,
  controller_token text not null,
  passphrase text not null,
  timer_mode text,
  timer_duration integer,
  timer_threshold integer,
  note_prefix text not null default 'note:',
  local boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);

-- For existing deployments: add the column if the table predates it.
alter table sessions add column if not exists local boolean not null default false;

-- Index for cleanup query
create index if not exists idx_sessions_expires_at on sessions (expires_at);

-- Create storage bucket for presentations
insert into storage.buckets (id, name, public)
values ('presentations', 'presentations', true)
on conflict (id) do nothing;

-- Allow public read access to the presentations bucket
create policy "Public read access" on storage.objects
  for select using (bucket_id = 'presentations');

-- Allow uploads to the presentations bucket (server uses service role key, so this is optional)
create policy "Allow uploads" on storage.objects
  for insert with check (bucket_id = 'presentations');

create policy "Allow deletes" on storage.objects
  for delete using (bucket_id = 'presentations');
