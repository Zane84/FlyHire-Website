-- Public, read-only window onto PUBLISHED blog posts, for the /blog pages.
--
-- Security design (linter-clean, airtight):
--   * public_posts is a SECURITY INVOKER view (runs as the querying role).
--   * anon is granted SELECT on ONLY the blog columns of content_pieces.
--   * an anon RLS policy exposes ONLY published rows.
-- Net effect: anonymous visitors can read just the blog fields of published
-- posts (via the view or even directly); the LinkedIn/Twitter drafts, the raw
-- source text, and any unpublished rows remain fully private to the owner.

create or replace view public.public_posts
  with (security_invoker = on) as
  select
    id,
    blog_slug,
    title,
    blog_excerpt,
    blog_post,
    blog_published_at
  from public.content_pieces
  where status = 'published' and blog_slug is not null;

revoke all on public.public_posts from public;
grant select on public.public_posts to anon, authenticated;

-- Column- and row-scoped anon access to the base table (required because the
-- view runs as the caller). anon never gets the sensitive columns or drafts.
revoke select on public.content_pieces from anon;
grant select (id, blog_slug, title, blog_excerpt, blog_post, blog_published_at)
  on public.content_pieces to anon;

drop policy if exists "Anyone can read published posts" on public.content_pieces;
create policy "Anyone can read published posts"
  on public.content_pieces for select to anon
  using (status = 'published' and blog_slug is not null);
