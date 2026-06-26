-- Read access for the FlyHire leads table.
--
-- Leads are written exclusively by the `submit-lead` Edge Function via the
-- service-role key (which bypasses RLS). This policy adds a SELECT path for the
-- `authenticated` role only -- e.g. a logged-in admin reading leads through the
-- API. The `anon`/public key still has ZERO access, so leads stay private.
--
-- Note: the Supabase dashboard Table Editor bypasses RLS, so leads were already
-- browsable there; this policy is for authenticated API/dashboard-with-auth reads.

drop policy if exists "Authenticated users can read leads" on public.leads;

create policy "Authenticated users can read leads"
  on public.leads
  for select
  to authenticated
  using (true);
