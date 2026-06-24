-- Leads captured from the FlyHire website contact form.
-- Rows are inserted exclusively by the `submit-lead` Edge Function using the
-- service-role key (which bypasses RLS). RLS is enabled with NO policies, so the
-- public/anon key has zero access — leads stay private.

create table if not exists public.leads (
  id            uuid        primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  name          text        not null,
  email         text        not null,
  company       text,
  phone         text,
  revenue_range text,
  message       text,
  status        text        not null default 'new',
  source        text        not null default 'website'
);

create index if not exists leads_created_at_idx on public.leads (created_at desc);

alter table public.leads enable row level security;
