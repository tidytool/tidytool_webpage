-- Phase 0 — Guided Capture baseline instrumentation (see guided-scan-capture plan §0)
-- Tags each drawer scan's capture-quality outcome so the freehand baseline is
-- MEASURED, not felt, before guided capture ships. Strictly additive & reversible.

-- 1) Outcome enum, matching the DB's descriptive-label convention (cf. drawer_status)
create type public.capture_quality as enum ('clean', 'needed_rework', 'needed_revisit');

-- 2) Tag + provenance on the scan (drawer = one scan). Nullable, no default:
--    metadata-only change, no table rewrite. NULL = not yet tagged by QC.
alter table public.drawer
  add column capture_quality           public.capture_quality,
  add column capture_quality_tagged_at timestamptz,
  add column capture_quality_tagged_by uuid,
  add column capture_quality_note      text;

comment on column public.drawer.capture_quality is
  'Phase 0 baseline instrumentation (guided-capture plan §0). Staff tag each scan at QC: clean / needed_rework / needed_revisit. NULL = not yet tagged.';
comment on column public.drawer.capture_quality_tagged_at is 'When capture_quality was set.';
comment on column public.drawer.capture_quality_tagged_by is 'auth.uid() of the staff member who set capture_quality.';
comment on column public.drawer.capture_quality_note is 'Optional free-text context for the tag (e.g. what the rework was).';

-- 3) Order-level rollup so the plan's "one number per site visit" is free & derived,
--    not double-tagged. security_invoker => the caller's drawer RLS applies.
create or replace view public.order_capture_quality
with (security_invoker = on) as
select
  d.order_id,
  count(*)                                                     as total_drawers,
  count(*) filter (where d.capture_quality is not null)        as tagged_drawers,
  count(*) filter (where d.capture_quality = 'clean')          as clean,
  count(*) filter (where d.capture_quality = 'needed_rework')  as needed_rework,
  count(*) filter (where d.capture_quality = 'needed_revisit') as needed_revisit,
  bool_or(d.capture_quality = 'needed_revisit')                as order_needed_revisit
from public.drawer d
where d.order_id is not null
group by d.order_id;

comment on view public.order_capture_quality is
  'Phase 0: order-level rollup of drawer.capture_quality (guided-capture plan §0). security_invoker so drawer RLS applies to the caller.';

grant select on public.order_capture_quality to authenticated;
