-- ============================================================================
-- Approval changelog: append-only event log. ADDITIVE ONLY.
-- No DROP, no column removal, no data mutation of existing rows beyond a
-- defaulted new column. Log is made immutable (no UPDATE/DELETE) by triggers.
-- ============================================================================

-- 1) Convenience column on drawer (additive, defaulted; existing rows -> 0)
alter table public.drawer
  add column if not exists current_revision int not null default 0;

-- 2) Append-only event table. FK has NO cascade -> a drawer with history
--    cannot be silently deleted (protects the audit trail).
create table if not exists public.drawer_event (
  id          uuid primary key default gen_random_uuid(),
  drawer_id   uuid not null references public.drawer(id),
  revision    int,
  event_type  text not null check (event_type in
                 ('design_uploaded','design_revised','approved','changes_requested')),
  actor_name  text,
  actor_role  text not null check (actor_role in ('customer','staff')),
  note        text,
  preview_url text,
  dxf_url     text,
  created_at  timestamptz not null default now()
);
create index if not exists drawer_event_drawer_created_idx
  on public.drawer_event (drawer_id, created_at desc);

comment on table public.drawer_event is
  'Append-only audit log of the design-approval lifecycle. Written only via SECURITY DEFINER RPCs; UPDATE/DELETE blocked by trigger.';

-- 3) Immutability: block UPDATE and DELETE for ALL roles (incl. service_role).
create or replace function public.drawer_event_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'drawer_event is append-only; % is not permitted', tg_op
    using errcode = '0A000';
end;
$$;

drop trigger if exists drawer_event_no_update on public.drawer_event;
drop trigger if exists drawer_event_no_delete on public.drawer_event;
create trigger drawer_event_no_update before update on public.drawer_event
  for each row execute function public.drawer_event_immutable();
create trigger drawer_event_no_delete before delete on public.drawer_event
  for each row execute function public.drawer_event_immutable();

-- 4) RLS on: no direct policies -> table reachable only via DEFINER RPCs below.
alter table public.drawer_event enable row level security;

-- 5) submit_drawer_approval: unchanged behavior + now appends an immutable event.
create or replace function public.submit_drawer_approval(
  p_id uuid, p_name text, p_decision text default 'approved', p_note text default null
) returns json
language plpgsql security definer set search_path = public
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
  if p_decision = 'approved' and d.customer_approval_status = 'approved' then
    raise exception 'This design has already been approved.' using errcode = '23505';
  end if;

  update public.drawer
     set customer_approval_status = p_decision,
         approved_by   = v_name,
         approved_at   = case when p_decision = 'approved' then now() else null end,
         approval_note = v_note
   where id = p_id
   returning customer_approval_status into v_status;

  insert into public.drawer_event
    (drawer_id, revision, event_type, actor_name, actor_role, note, preview_url, dxf_url)
  values
    (p_id, d.current_revision, p_decision, v_name, 'customer', v_note, d.design_preview_url, d.dxf_url);

  begin
    perform public._notify_discord_approval(p_id, p_decision, v_name, v_note);
  exception when others then
    null;
  end;

  return json_build_object('ok', true, 'status', v_status);
end;
$$;

-- 6) log_design_revision: staff-only. Records an image update, bumps revision,
--    resets approval to pending (prior approval preserved in the event log).
create or replace function public.log_design_revision(
  p_drawer_id uuid, p_preview_url text, p_dxf_url text default null, p_note text default null
) returns json
language plpgsql security definer set search_path = public
as $$
declare
  d public.drawer;
  v_rev int;
  v_type text;
begin
  select * into d from public.drawer where id = p_drawer_id for update;
  if not found then
    raise exception 'Drawer not found.' using errcode = 'P0002';
  end if;

  v_rev  := coalesce(d.current_revision, 0) + 1;
  v_type := case when coalesce(d.current_revision,0) = 0 then 'design_uploaded' else 'design_revised' end;

  update public.drawer
     set current_revision        = v_rev,
         design_preview_url       = coalesce(p_preview_url, design_preview_url),
         dxf_url                  = coalesce(p_dxf_url, dxf_url),
         customer_approval_status = 'pending',
         approved_by = null, approved_at = null, approval_note = null
   where id = p_drawer_id;

  insert into public.drawer_event
    (drawer_id, revision, event_type, actor_name, actor_role, note, preview_url, dxf_url)
  values
    (p_drawer_id, v_rev, v_type, 'TidyTool', 'staff',
     nullif(btrim(coalesce(p_note,'')),''), p_preview_url, coalesce(p_dxf_url, d.dxf_url));

  return json_build_object('ok', true, 'revision', v_rev, 'event', v_type);
end;
$$;

-- 7) get_drawer_changelog: token-gated read of one drawer's history.
create or replace function public.get_drawer_changelog(p_drawer_id uuid)
returns table (
  event_type text, revision int, actor_name text, actor_role text,
  note text, preview_url text, created_at timestamptz
)
language sql security definer set search_path = public
as $$
  select event_type, revision, actor_name, actor_role, note, preview_url, created_at
  from public.drawer_event
  where drawer_id = p_drawer_id
  order by created_at desc, id desc;
$$;

-- 8) Grants
revoke all on function public.log_design_revision(uuid,text,text,text) from public;
grant execute on function public.log_design_revision(uuid,text,text,text) to service_role;
grant execute on function public.get_drawer_changelog(uuid) to anon, authenticated;
grant execute on function public.submit_drawer_approval(uuid,text,text,text) to anon, authenticated;