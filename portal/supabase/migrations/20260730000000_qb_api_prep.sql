-- QuickBooks API prep (design-for-API, 2026-07-30).
-- Additive only: human-readable quote numbers (the future QBO estimate
-- DocNumber), organization → QBO customer mapping, and QBO sync bookkeeping.
-- No RLS changes, no destructive statements. Nothing writes qb_* yet — the
-- future qb-sync edge function owns those.

-- 1) quote.quote_number — sequential, unique, backfilled in creation order.
--    Rendered as "Q-0042" (portal formatQuoteNumber). Requires QBO's
--    "Custom transaction numbers" setting ON to land as the estimate no.
create sequence if not exists public.quote_number_seq;

alter table public.quote add column if not exists quote_number bigint;

update public.quote q
set quote_number = n.rn
from (
  select id, row_number() over (order by created_at, id) as rn
  from public.quote
) n
where q.id = n.id and q.quote_number is null;

select setval(
  'public.quote_number_seq',
  coalesce((select max(quote_number) from public.quote), 0) + 1,
  false
);

alter table public.quote alter column quote_number set default nextval('public.quote_number_seq');
alter table public.quote alter column quote_number set not null;
alter table public.quote add constraint quote_quote_number_key unique (quote_number);
alter sequence public.quote_number_seq owned by public.quote.quote_number;

comment on column public.quote.quote_number is
  'Sequential human-readable quote number. Rendered "Q-0042"; becomes the QuickBooks estimate DocNumber. Never renumber.';

-- 2) QBO sync bookkeeping. Idempotency guard for the future push:
--    non-null qb_estimate_id means "already in QuickBooks — do not push again"
--    (QBO has no idempotency keys; this column is the guard).
alter table public.quote add column if not exists qb_estimate_id text;
alter table public.quote add column if not exists qb_synced_at timestamptz;

comment on column public.quote.qb_estimate_id is
  'QuickBooks Online Estimate.Id once pushed. Non-null = synced; the push must skip it.';
comment on column public.quote.qb_synced_at is
  'When the QBO estimate was created/last synced by qb-sync.';

-- 3) organization → QBO customer mapping. Until backfilled, keep QBO customer
--    DisplayName identical to organization.name so name-matching works.
alter table public.organization add column if not exists qb_customer_id text;

comment on column public.organization.qb_customer_id is
  'QuickBooks Online Customer.Id for this organization. Null = not linked yet (backfill matches on DisplayName = organization.name).';

-- 4) get_quotes_for_order now returns quote_number + qb sync fields.
--    Same body and security posture as 20260724000000; only the jsonb payload
--    grows. CREATE OR REPLACE preserves the existing ACL, but the explicit
--    revoke/grant below re-asserts it anyway (default-privilege EXECUTE gotcha).
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
