-- Calibration-accuracy telemetry for the admin portal's live accuracy plot.
-- tidyCAM writes a per-scan quality rollup into drawer.dimensions under the
-- 'calibration_quality' key (score 0-100, diagonal_error_mm, edge_asymmetry_pct,
-- corner_angle_dev_deg, keystone_center_mm) — no schema migration, same pattern
-- as calibration_matrix / notes. These RPCs expose it as a time series + summary
-- for staff/admins only.
--
-- NB: drawer.dimensions is `json`, NOT `jsonb`, so the `?` key-exists operator is
-- unavailable. Filter with `dimensions -> 'calibration_quality' is not null`
-- (returns NULL when the key is absent); `->`/`->>` extraction works on json.
-- The partial index in the design guide (WHERE dimensions ? '...') would fail for
-- the same reason and is intentionally omitted — a plain created_at btree is used.
--
-- Guarded in-body with is_staff() (staff OR admin) so the advisor's warning about
-- authenticated-executable SECURITY DEFINER functions is answered by real
-- enforcement, matching admin_list_users / record_dxf_upload.

-- ---------------------------------------------------------------------------
-- Per-scan time series (initial load; Realtime streams new rows client-side).
-- ---------------------------------------------------------------------------
create or replace function public.get_calibration_accuracy_series(p_days int default 90)
returns table (
  drawer_id          uuid,
  nickname           text,
  scanned_at         timestamptz,
  score              numeric,
  diagonal_error_mm  numeric,
  edge_asymmetry_pct numeric
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public.is_staff() then
    raise exception 'get_calibration_accuracy_series: staff or admin only';
  end if;
  return query
    select
      d.id,
      d.nickname,
      d.created_at,
      (d.dimensions -> 'calibration_quality' ->> 'score')::numeric,
      (d.dimensions -> 'calibration_quality' ->> 'diagonal_error_mm')::numeric,
      (d.dimensions -> 'calibration_quality' ->> 'edge_asymmetry_pct')::numeric
    from public.drawer d
    where d.dimensions -> 'calibration_quality' is not null
      and d.created_at > now() - make_interval(days => greatest(1, least(p_days, 365)))
    order by d.created_at;
end;
$$;

revoke all on function public.get_calibration_accuracy_series(int) from public, anon;
grant execute on function public.get_calibration_accuracy_series(int) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Cheap rollup for the KPI tiles (avoids pulling every row for the headline).
-- ---------------------------------------------------------------------------
create or replace function public.get_calibration_accuracy_summary(p_days int default 30)
returns table (
  scans            bigint,
  avg_score        numeric,
  median_error_mm  numeric,
  p90_error_mm     numeric
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public.is_staff() then
    raise exception 'get_calibration_accuracy_summary: staff or admin only';
  end if;
  return query
    select
      count(*),
      round(avg((dimensions -> 'calibration_quality' ->> 'score')::numeric), 1),
      round(percentile_cont(0.5) within group (
        order by (dimensions -> 'calibration_quality' ->> 'diagonal_error_mm')::numeric), 2),
      round(percentile_cont(0.9) within group (
        order by (dimensions -> 'calibration_quality' ->> 'diagonal_error_mm')::numeric), 2)
    from public.drawer
    where dimensions -> 'calibration_quality' is not null
      and created_at > now() - make_interval(days => greatest(1, least(p_days, 365)));
end;
$$;

revoke all on function public.get_calibration_accuracy_summary(int) from public, anon;
grant execute on function public.get_calibration_accuracy_summary(int) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Recency index the queries filter on (advisor would otherwise ask for it).
-- ---------------------------------------------------------------------------
create index if not exists drawer_created_at_idx on public.drawer (created_at desc);
