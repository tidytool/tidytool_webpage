-- Notification emails (ARCHITECTURE.md §3, build step 5)
-- Customer lifecycle emails via the `notify` edge function + Resend.
--   design ready  -> "review your design"   (hooked into log_design_revision)
--   approved      -> "we're cutting"        (hooked into submit_drawer_approval)
--
-- Same contract as _notify_discord_approval: best-effort, SECURITY DEFINER,
-- no-op until the Vault secret `notify_hook_secret` exists. The edge function
-- additionally no-ops until RESEND_API_KEY is set, so this migration is safe
-- to apply before Resend/DNS setup is done.
--
-- NOT APPLIED TO PROD without Sam's explicit approval (touches the approval RPC).

-- 1) Helper: look up the customer for a drawer and post to the notify function.
create or replace function public._notify_customer_email(
  p_drawer_id uuid, p_kind text, p_note text, p_revision int default null
) returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret text;
  v_to     text;
  v_name   text;
  v_nick   text;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'notify_hook_secret'
  limit 1;

  if v_secret is null then
    return; -- not configured yet -> no-op
  end if;

  select d.nickname,
         coalesce(c.email, nullif(btrim(o.customer_email), '')),
         coalesce(c.name,  nullif(btrim(o.customer_name),  ''))
    into v_nick, v_to, v_name
    from public.drawer d
    left join public."order"   o on o.id = d.order_id
    left join public.customer  c on c.id = o.customer_id
   where d.id = p_drawer_id;

  if v_to is null then
    return; -- no customer email on record -> nothing to send
  end if;
  if v_nick ilike '%[TEST]%' then
    return; -- dev seed rows never email anyone
  end if;

  perform net.http_post(
    url := 'https://tkrrvpoupekrjqditupi.supabase.co/functions/v1/notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-notify-secret', v_secret
    ),
    body := jsonb_build_object(
      'type', p_kind,
      'to', v_to,
      'customer_name', v_name,
      'nickname', v_nick,
      'drawer_id', p_drawer_id::text,
      'revision', p_revision,
      'note', p_note
    )
  );
end;
$$;

revoke execute on function public._notify_customer_email(uuid,text,text,int)
  from anon, authenticated, public;

-- 2) log_design_revision: current prod body + design-ready email (best-effort).
create or replace function public.log_design_revision(
  p_drawer_id uuid, p_preview_url text, p_dxf_url text default null, p_note text default null
) returns json
language plpgsql
security definer
set search_path = public
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

  -- NEW: tell the customer their design is ready to review (best-effort)
  begin
    perform public._notify_customer_email(
      p_drawer_id, 'design_ready', nullif(btrim(coalesce(p_note,'')),''), v_rev);
  exception when others then
    null;
  end;

  return json_build_object('ok', true, 'revision', v_rev, 'event', v_type);
end;
$$;

-- 3) submit_drawer_approval: current prod body + approved-confirmation email.
create or replace function public.submit_drawer_approval(
  p_id uuid, p_name text, p_decision text default 'approved', p_note text default null
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

  -- NEW: confirmation email to the customer on approval (best-effort)
  if p_decision = 'approved' then
    begin
      perform public._notify_customer_email(p_id, 'approved', v_note, d.current_revision);
    exception when others then
      null;
    end;
  end if;

  return json_build_object('ok', true, 'status', v_status);
end;
$$;
