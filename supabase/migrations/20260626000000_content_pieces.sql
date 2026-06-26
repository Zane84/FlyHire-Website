-- Content Command Center — content_pieces table + owner-only RLS.
--
-- Stores every piece of content created in the private studio: the raw source
-- (a YouTube link or a brain-dump), and the three AI-generated drafts
-- (LinkedIn post, blog post, Twitter/X thread), plus publish/post status.
--
-- Access model: this is single-user. Because the studio signs in with Google
-- OAuth (which would let ANY Google account obtain a session), "authenticated"
-- is not a sufficient gate. Every policy below additionally requires the
-- caller's email to be the owner's. The anon/public key has zero access to the
-- table; public blog exposure (Phase 2) goes through the public_posts view.

create table if not exists public.content_pieces (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- Input
  source_type        text not null check (source_type in ('youtube', 'braindump')),
  source_url         text,
  source_text        text,

  -- Generated / editable drafts
  title              text,
  linkedin_post      text,
  blog_post          text,            -- markdown
  blog_excerpt       text,
  blog_slug          text unique,
  twitter_thread     jsonb not null default '[]'::jsonb,  -- array of tweet strings

  -- Lifecycle
  status             text not null default 'draft' check (status in ('draft', 'published')),
  blog_published_at  timestamptz,
  twitter_posted_at  timestamptz,
  twitter_thread_url text
);

create index if not exists content_pieces_created_at_idx on public.content_pieces (created_at desc);

-- keep updated_at fresh on every write
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists content_pieces_set_updated_at on public.content_pieces;
create trigger content_pieces_set_updated_at
  before update on public.content_pieces
  for each row execute function public.set_updated_at();

-- Lock the table down.
alter table public.content_pieces enable row level security;

-- Owner-only policies. The literal email is the single allowlist entry; swap to
-- a small admins table if more users are ever added.
drop policy if exists "Owner can read content"   on public.content_pieces;
drop policy if exists "Owner can insert content" on public.content_pieces;
drop policy if exists "Owner can update content" on public.content_pieces;
drop policy if exists "Owner can delete content" on public.content_pieces;

create policy "Owner can read content"
  on public.content_pieces for select to authenticated
  using ((auth.jwt() ->> 'email') = 'zanehaug@gmail.com');

create policy "Owner can insert content"
  on public.content_pieces for insert to authenticated
  with check ((auth.jwt() ->> 'email') = 'zanehaug@gmail.com');

create policy "Owner can update content"
  on public.content_pieces for update to authenticated
  using ((auth.jwt() ->> 'email') = 'zanehaug@gmail.com')
  with check ((auth.jwt() ->> 'email') = 'zanehaug@gmail.com');

create policy "Owner can delete content"
  on public.content_pieces for delete to authenticated
  using ((auth.jwt() ->> 'email') = 'zanehaug@gmail.com');
