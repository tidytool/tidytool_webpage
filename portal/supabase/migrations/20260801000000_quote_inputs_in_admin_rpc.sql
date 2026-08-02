-- get_quotes_for_order gains 'inputs' in its payload (2026-08-01).
-- The quote generator now supports per-quote rate overrides stored inside the
-- inputs jsonb (config_overrides). The admin quote list needs inputs to render
-- the "Custom rates" badge. Staff-only RPC (is_staff-gated) — inputs carry
-- internal cost assumptions, which staff already see via cost_breakdown.
-- Additive payload change only; body otherwise identical to 20260730120000.
create or replace function public.get_quotes_for_order(p_order_id uuid)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $$
begin
  if not public.is_staff() then
    raise exception 'get_quotes_for_order: staff or admin only';
  end if;
  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', q.id, 'created_at', q.created_at, 'status', q.status,
        'quote_number', q.quote_number,
        'qb_estimate_id', q.qb_estimate_id, 'qb_synced_at', q.qb_synced_at,
        'inputs', q.inputs,
        'subtotal_cents', q.subtotal_cents, 'total_cents', q.total_cents,
        'estimated_cost_cents', q.estimated_cost_cents,
        'gross_profit_cents', q.gross_profit_cents, 'gross_margin', q.gross_margin,
        'margin_target', q.margin_target, 'below_target', q.below_target,
        'warnings', q.warnings, 'unpriced_drawers', q.unpriced_drawers,
        'valid_until', q.valid_until, 'notes', q.notes, 'cost_breakdown', q.cost_breakdown,
        'lines', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'position', l.position, 'kind', l.kind, 'description', l.description,
            'drawer_id', l.drawer_id, 'qty', l.qty, 'unit', l.unit,
            'unit_price_cents', l.unit_price_cents, 'amount_cents', l.amount_cents,
            'included', l.included, 'meta', l.meta
          ) order by l.position), '[]'::jsonb)
          from public.quote_line_item l where l.quote_id = q.id
        )
      ) order by q.created_at desc
    )
    from public.quote q where q.order_id = p_order_id
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.get_quotes_for_order(uuid) from anon, public;
grant execute on function public.get_quotes_for_order(uuid) to authenticated;
