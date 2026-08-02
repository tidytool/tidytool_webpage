-- Option B (Sam, 2026-07-28): QC moves to the portal. tidyCAD's work ends
-- at "designed" — so get_work_queue's blocked_on marks only pre-design
-- stages (backlog/scanned/design_queue) as tidyCAD's move. designed and
-- everything downstream is 'none' (portal territory) unless state=rework,
-- which the portal sets when QC rejects — those return to tidyCAD with
-- top priority (existing ORDER BY rework-first).
CREATE OR REPLACE FUNCTION public.get_work_queue(p_include_done boolean DEFAULT false)
 RETURNS TABLE(drawer_id uuid, nickname text, photo_url text, stage text, stage_label text, stage_changed_at timestamp with time zone, days_in_stage numeric, state text, state_reason text, blocked_on text, order_id uuid, project_name text, customer_name text, order_status text, order_state text)
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
         coalesce(o.manual_status, o.computed_status), o.state
    from public.drawer d
    join public.status_def sd on sd.domain = 'drawer' and sd.code = d.stage
    left join public."order" o on o.id = d.order_id
   where (p_include_done or (not sd.is_terminal and d.state <> 'cancelled'))
     and coalesce(o.state, 'active') <> 'cancelled'
   order by (d.state = 'rework') desc,
            coalesce(d.stage_changed_at, d.created_at) asc;
end $function$;