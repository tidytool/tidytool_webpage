-- Boundary box for drawer scans, promoted out of the schemaless
-- `dimensions` JSON so the portal can query it directly.
--
-- The boundary box is the four-corner reference quad the operator taps on
-- the calibrate screen, plus the real-world width/height they typed and the
-- unit they typed it in. The corners are normalized 0-1 fractions of the
-- ortho photo (TL, TR, BR, BL) so they stay resolution-independent.
--
-- boundary_width / boundary_height are expressed IN boundary_unit.
-- Convention for 'feet_inches': the numeric value is TOTAL INCHES (matches
-- the app's Unit.feetInches storage convention); display layers format it
-- as ft + in + fraction.

alter table public.drawer
  add column if not exists boundary_corners jsonb,
  add column if not exists boundary_width numeric,
  add column if not exists boundary_height numeric,
  add column if not exists boundary_unit text;

alter table public.drawer
  drop constraint if exists drawer_boundary_unit_check;

alter table public.drawer
  add constraint drawer_boundary_unit_check
  check (
    boundary_unit is null
    or boundary_unit in ('inches', 'feet_inches', 'cm', 'mm', 'feet_decimal')
  );

comment on column public.drawer.boundary_corners is
  'Reference-box corners tapped at calibration, normalized 0-1 [[x,y] x4] in TL,TR,BR,BL order.';
comment on column public.drawer.boundary_width is
  'Boundary box width in boundary_unit (total inches when unit is feet_inches).';
comment on column public.drawer.boundary_height is
  'Boundary box height in boundary_unit (total inches when unit is feet_inches).';
comment on column public.drawer.boundary_unit is
  'Unit the operator entered the boundary dimensions in: inches | feet_inches | cm | mm | feet_decimal.';
