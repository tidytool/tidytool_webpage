-- Promote the dev-branch claims + design-progress feature set to prod.
-- Sources: LIVE definitions extracted from dev (gfkrebuioszsxanjdnsx) on
-- 2026-08-12 (authoritative over tidyCAD's docs/sql drafts).
--
-- Everything here is additive except get_work_queue, whose RETURN TYPE
-- changed — hence the drop-before-create guards on every function, which
-- also keep future Supabase branch-creation replays from failing the way
-- migration 20260706000000 does (CREATE OR REPLACE with changed return
-- type). Applied to prod on 2026-08-12; dev has carried this since Aug 4.

-- 1. Drawer claim columns -----------------------------------------------
alter table public.drawer
  add column if not exists claimed_by uuid references auth.users(id) on delete set null;
alter table public.drawer
  add column if not exists claimed_at timestamp with time zone;
drop index if exists public.drawer_claimed_by_idx;
CREATE INDEX drawer_claimed_by_idx ON public.drawer USING btree (claimed_by) WHERE (claimed_by IS NOT NULL);

-- 2. Design-progress autosave table -------------------------------------
-- RLS is enabled with NO policies on purpose: all access flows through the
-- SECURITY DEFINER functions below.
create table if not exists public.drawer_progress (  drawer_id uuid,
  state jsonb not null,
  schema_version integer default 1 not null,
  saved_by uuid,
  saved_at timestamp with time zone default now() not null,
  constraint drawer_progress_pkey primary key (drawer_id),
  constraint drawer_progress_drawer_id_fkey foreign key (drawer_id)
    references public.drawer(id) on delete cascade,
  constraint drawer_progress_saved_by_fkey foreign key (saved_by)
    references auth.users(id) on delete set null
);
alter table public.drawer_progress enable row level security;

-- 3. Functions (claims workflow + progress autosave + widened queue) ----
drop function if exists public.claim_drawer(p_drawer_id uuid);
CREATE OR REPLACE FUNCTION public.claim_drawer(p_drawer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_owner uuid;
  v_at timestamptz;
begin
  if not public.is_staff() then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  -- First-wins: only fills a NULL claimed_by. Under READ COMMITTED a losing
  -- concurrent claim re-evaluates the WHERE after the winner commits and
  -- updates zero rows.
  update public.drawer d
     set claimed_by = auth.uid(), claimed_at = now()
   where d.id = p_drawer_id and d.claimed_by is null;

  select d.claimed_by, d.claimed_at into v_owner, v_at
    from public.drawer d where d.id = p_drawer_id;
  if not found then
    raise exception 'drawer not found';
  end if;

  return jsonb_build_object(
    'claimed', v_owner = auth.uid(),
    'claimed_by', v_owner,
    'claimed_by_email', (select u.email::text from auth.users u where u.id = v_owner),
    'claimed_at', v_at);
end $function$
;

drop function if exists public.clear_drawer_progress(p_drawer_id uuid);
CREATE OR REPLACE FUNCTION public.clear_drawer_progress(p_drawer_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_owner uuid;
begin
  if not public.is_staff() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  select d.claimed_by into v_owner from public.drawer d where d.id = p_drawer_id;
  if v_owner is not null and v_owner <> auth.uid() and not public.is_admin() then
    raise exception 'progress can only be cleared by the claim owner'
      using errcode = '42501';
  end if;
  delete from public.drawer_progress where drawer_id = p_drawer_id;
end $function$
;

drop function if exists public.get_claimable_staff();
CREATE OR REPLACE FUNCTION public.get_claimable_staff()
 RETURNS TABLE(user_id uuid, email text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_staff() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  return query
    select distinct u.id, u.email::text
      from public.user_roles r
      join auth.users u on u.id = r.user_id
     where r.role in ('staff', 'admin')
     order by u.email::text;
end $function$
;

drop function if exists public.get_drawer_progress(p_drawer_id uuid);
CREATE OR REPLACE FUNCTION public.get_drawer_progress(p_drawer_id uuid)
 RETURNS TABLE(state jsonb, schema_version integer, saved_by uuid, saved_by_email text, saved_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_staff() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  return query
    select p.state, p.schema_version, p.saved_by, u.email::text, p.saved_at
      from public.drawer_progress p
      left join auth.users u on u.id = p.saved_by
     where p.drawer_id = p_drawer_id;
end $function$
;

drop function if exists public.get_work_queue(p_include_done boolean);
CREATE OR REPLACE FUNCTION public.get_work_queue(p_include_done boolean DEFAULT false)
 RETURNS TABLE(drawer_id uuid, nickname text, photo_url text, stage text, stage_label text, stage_changed_at timestamp with time zone, days_in_stage numeric, state text, state_reason text, blocked_on text, order_id uuid, project_name text, customer_name text, order_status text, order_state text, claimed_by uuid, claimed_at timestamp with time zone, claimed_by_email text, order_location text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_staff() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  return query
  select d.id, d.nickname, d.photo_url,
         d.stage, sd.label, d.stage_changed_at,
         round((extract(epoch from (now() - coalesce(d.stage_changed_at, d.created_at))) / 86400.0)::numeric, 1),
         d.state, d.state_reason,
         case when d.state = 'cancelled'            then 'none'
              when d.state = 'on_hold'              then 'hold'
              when d.state = 'rework'               then 'us'
              when d.stage = 'awaiting_approval'    then 'customer'
              when sd.is_terminal                   then 'none'
              when d.stage in ('backlog','scanned','design_queue') then 'us'
              else 'none' end,
         o.id, o.project_name, o.customer_name,
         coalesce(o.manual_status, o.computed_status), o.state,
         d.claimed_by, d.claimed_at, cu.email::text,
         o.location
    from public.drawer d
    join public.status_def sd on sd.domain = 'drawer' and sd.code = d.stage
    left join public."order" o on o.id = d.order_id
    left join auth.users cu on cu.id = d.claimed_by
   where (p_include_done or (not sd.is_terminal and d.state <> 'cancelled'))
     and coalesce(o.state, 'active') <> 'cancelled'
   order by (d.state = 'rework') desc,
            coalesce(d.stage_changed_at, d.created_at) asc;
end $function$
;

drop function if exists public.handoff_drawer(p_drawer_id uuid, p_to_user uuid);
CREATE OR REPLACE FUNCTION public.handoff_drawer(p_drawer_id uuid, p_to_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_owner uuid;
begin
  if not public.is_staff() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.user_roles r
                  where r.user_id = p_to_user and r.role in ('staff', 'admin')) then
    raise exception 'handoff target must be a staff user';
  end if;
  select d.claimed_by into v_owner from public.drawer d where d.id = p_drawer_id;
  if not found then
    raise exception 'drawer not found';
  end if;
  if v_owner is not null and v_owner <> auth.uid() and not public.is_admin() then
    raise exception 'only the claim owner or an admin can hand off this drawer'
      using errcode = '42501';
  end if;
  update public.drawer d
     set claimed_by = p_to_user, claimed_at = now()
   where d.id = p_drawer_id;
  return jsonb_build_object(
    'claimed_by', p_to_user,
    'claimed_by_email', (select u.email::text from auth.users u where u.id = p_to_user));
end $function$
;

drop function if exists public.release_drawer(p_drawer_id uuid);
CREATE OR REPLACE FUNCTION public.release_drawer(p_drawer_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_owner uuid;
begin
  if not public.is_staff() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  select d.claimed_by into v_owner from public.drawer d where d.id = p_drawer_id;
  if not found then
    raise exception 'drawer not found';
  end if;
  if v_owner is null then
    return;  -- already unclaimed; idempotent
  end if;
  if v_owner <> auth.uid() and not public.is_admin() then
    raise exception 'only the claim owner or an admin can release this drawer'
      using errcode = '42501';
  end if;
  update public.drawer d
     set claimed_by = null, claimed_at = null
   where d.id = p_drawer_id;
end $function$
;

drop function if exists public.save_drawer_progress(p_drawer_id uuid, p_state jsonb, p_schema_version integer);
CREATE OR REPLACE FUNCTION public.save_drawer_progress(p_drawer_id uuid, p_state jsonb, p_schema_version integer DEFAULT 1)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_owner uuid;
  v_saved_at timestamptz;
begin
  if not public.is_staff() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  select d.claimed_by into v_owner from public.drawer d where d.id = p_drawer_id;
  if not found then
    raise exception 'drawer not found';
  end if;
  if v_owner is not null and v_owner <> auth.uid() then
    raise exception 'progress can only be saved by the claim owner'
      using errcode = '42501';
  end if;
  insert into public.drawer_progress (drawer_id, state, schema_version, saved_by, saved_at)
  values (p_drawer_id, p_state, p_schema_version, auth.uid(), now())
  on conflict (drawer_id) do update
     set state = excluded.state,
         schema_version = excluded.schema_version,
         saved_by = excluded.saved_by,
         saved_at = excluded.saved_at
  returning saved_at into v_saved_at;
  return v_saved_at;
end $function$
;

