-- Create sessions table
create table if not exists sessions (
  id text primary key,
  pdf_path text not null,
  pdf_url text not null default '',
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
  user_id uuid references auth.users,
  -- Lifecycle: 'active' while the presentation is live; 'expired' once it has
  -- ended (either explicitly by the controller or after expires_at passed).
  -- Expired rows are retained as a record rather than deleted.
  status text not null default 'active',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);

-- For existing deployments: add the columns if the table predates them.
alter table sessions add column if not exists local boolean not null default true;
alter table sessions add column if not exists user_id uuid references auth.users;

-- "Bring your own storage": when set, the PDF is hosted externally (e.g. a
-- GitHub raw/Pages URL) and Presio stores only this URL — no bytes are uploaded
-- to the bucket. Mode is derivable: local=true ⇒ local; pdf_url <> '' ⇒
-- external; pdf_path <> '' ⇒ Supabase-hosted.
alter table sessions add column if not exists pdf_url text not null default '';
alter table sessions add column if not exists status text not null default 'active';

-- Index for cleanup query
create index if not exists idx_sessions_expires_at on sessions (expires_at);

-- Email list signups collected from the in-app prompt. Only the server (service
-- role) touches this table; RLS with no policies keeps PostgREST clients out.
create table if not exists newsletter_signups (
  email text primary key,
  created_at timestamptz not null default now()
);
alter table newsletter_signups enable row level security;

-- Create storage bucket for presentations
insert into storage.buckets (id, name, public)
values ('presentations', 'presentations', true)
on conflict (id) do nothing;

-- Allow public read access to the presentations bucket.
-- NOTE: this makes every uploaded PDF readable by anyone who knows (or guesses)
-- its object path. Do not store confidential material in synced presentations.
-- drop-then-create keeps this script idempotent (Postgres has no
-- "create policy if not exists"), so it can be re-applied safely on every boot.
drop policy if exists "Public read access" on storage.objects;
create policy "Public read access" on storage.objects
  for select using (bucket_id = 'presentations');

-- Writes and deletes are performed exclusively by the server using the service
-- role key, which bypasses RLS. We deliberately do NOT grant anon/authenticated
-- insert or delete policies, so clients cannot tamper with stored PDFs directly.

-- If a deployment created the previously-permissive policies, drop them:
drop policy if exists "Allow uploads" on storage.objects;
drop policy if exists "Allow deletes" on storage.objects;
