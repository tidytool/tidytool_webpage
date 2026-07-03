-- Customer design-approval feature (v1): additive columns on drawer + token-gated RPCs.
-- Safe/additive: tidyCAM inserts explicit columns, so new nullable/defaulted columns won't break it.

-- 1) Approval fields on drawer (distinct from internal `status` enum's approved_by_qualityctrl)
alter table public.drawer
  add column if not exists customer_approval_status text not null default 'pending'
    check (customer_approval_status in ('pending','approved','changes_requested')),
  add column if not exists approved_by   text,
  add column if not exists approved_at   timestamptz,
  add column if not exists approval_note text,
  add column if not exists design_preview_url text;

comment on column public.drawer.customer_approval_status is
  'Customer-facing design sign-off (pending|approved|changes_requested). Separate from internal status enum.';
comment on column public.drawer.design_preview_url is
  'Public URL of the rendered design preview (PNG) shown on the approval page.';

-- 2) Async HTTP for Discord notify (Vault-secured), best-effort
create extension if not exists pg_net;

-- 3) Discord notify helper — reads webhook from Vault; no-op if not configured.
create or replace function public._notify_discord_approval(
  p_id uuid, p_decision text, p_name text, p_note text
) returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_url  text;
  v_nick text;
  v_msg  text;
begin
  select decrypted_secret into v_url
  from vault.decrypted_secrets
  where name = 'discord_approval_webhook'
  limit 1;

  if v_url is null then
    return; -- webhook not configured yet -> no-op
  end if;

  select nickname into v_nick from public.drawer where id = p_id;

  v_msg := case when p_decision = 'approved'
                then 'Design APPROVED'
                else 'Changes requested' end
        || ' - ' || coalesce(v_nick, p_id::text)
        || ' by ' || p_name
        || coalesce(' - note: ' || p_note, '')
        || E'\nhttps://thetidytool.com/approve/?id=' || p_id::text;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type','application/json'),
    body := jsonb_build_object('content', v_msg)
  );
end;
$$;

-- 4) Public read: only safe fields, bypasses the table's broad SELECT via DEFINER
create or replace function public.get_drawer_approval(p_id uuid)
returns table (
  id uuid,
  nickname text,
  dimensions json,
  design_preview_url text,
  dxf_url text,
  customer_approval_status text,
  approved_by text,
  approved_at timestamptz,
  approval_note text
)
language sql
security definer
set search_path = public
as $$
  select d.id, d.nickname, d.dimensions, d.design_preview_url, d.dxf_url,
         d.customer_approval_status, d.approved_by, d.approved_at, d.approval_note
  from public.drawer d
  where d.id = p_id;
$$;

-- 5) Approve / request-changes: validated, immutable once approved, fires notify best-effort
create or replace function public.submit_drawer_approval(
  p_id uuid,
  p_name text,
  p_decision text default 'approved',
  p_note text default null
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  d public.drawer;
  v_status text;
  v_name text := btrim(coalesce(p_name,''));
  v_note text := nullif(btrim(coalesce(p_note,'')),'');
begin
  if v_name = '' then
    raise exception 'A name is required to sign off.' using errcode = '22000';
  end if;
  if p_decision not in ('approved','changes_requested') then
    raise exception 'Invalid decision.' using errcode = '22000';
  end if;

  select * into d from public.drawer where id = p_id for update;
  if not found then
    raise exception 'Drawer not found.' using errcode = 'P0002';
  end if;
  if d.customer_approval_status = 'approved' then
    raise exception 'This design has already been approved.' using errcode = '23505';
  end if;

  update public.drawer
     set customer_approval_status = p_decision,
         approved_by   = v_name,
         approved_at   = case when p_decision = 'approved' then now() else null end,
         approval_note = v_note
   where id = p_id
   returning customer_approval_status into v_status;

  begin
    perform public._notify_discord_approval(p_id, p_decision, v_name, v_note);
  exception when others then
    null; -- never fail the approval because notification failed
  end;

  return json_build_object('ok', true, 'status', v_status);
end;
$$;

-- 6) Grants: page calls these as anon; keep notify helper internal
revoke all on function public._notify_discord_approval(uuid,text,text,text) from public;
grant execute on function public.get_drawer_approval(uuid) to anon, authenticated;
grant execute on function public.submit_drawer_approval(uuid,text,text,text) to anon, authenticated;