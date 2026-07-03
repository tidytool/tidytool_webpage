-- Supabase default-grants EXECUTE on public functions to anon/authenticated.
-- Explicitly revoke from those roles for staff-only and internal functions.

revoke execute on function public.log_design_revision(uuid,text,text,text) from anon, authenticated, public;
grant  execute on function public.log_design_revision(uuid,text,text,text) to service_role;

revoke execute on function public._notify_discord_approval(uuid,text,text,text) from anon, authenticated, public;

-- Customer-facing RPCs remain callable by anon (intended):
--   submit_drawer_approval, get_drawer_approval, get_drawer_changelog