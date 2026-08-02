import { createClient } from "@/lib/supabase/server";
import {
  type AdminOrderDetail,
  type AdminCustomer,
  type AdminQuote,
  formatCents,
} from "@/lib/types";
import { QuotesSection } from "@/components/QuotesSection";
import { OrderContents } from "@/components/OrderContents";
import { GenerateQuoteModal, type RateDefaults } from "@/components/GenerateQuoteModal";
import { DEFAULT_PRICING_CONFIG, parsePricingConfig } from "@/lib/pricing/config";
import { EditOrderModal } from "@/components/EditOrderModal";

export const dynamic = "force-dynamic";

export default async function AdminOrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();
  const [detailRes, custRes, quotesRes, configRes] = await Promise.all([
    supabase.rpc("get_admin_order_detail", { p_order_id: id }),
    supabase.rpc("get_admin_customers"),
    supabase.rpc("get_quotes_for_order", { p_order_id: id }),
    supabase.from("pricing_config").select("config").eq("active", true).single(),
  ]);

  if (detailRes.error) {
    return (
      <main className="wrap wrap--wide">
        <h1>Order</h1>
        <p className="banner--err">{detailRes.error.message}</p>
      </main>
    );
  }
  const detail = detailRes.data as AdminOrderDetail;
  const customers = (custRes.data ?? []) as AdminCustomer[];
  // Absent until the quoting migration is applied — render nothing rather than crash.
  const quotes = (quotesRes.error ? [] : (quotesRes.data ?? [])) as AdminQuote[];
  const o = detail.order;

  // Current physical-copy structure — used to flag quotes priced before a change.
  const currentDrawerCopies = detail.drawers.map((d) => {
    const box = detail.boxes.find((b) => b.id === d.box_id) ?? null;
    return { id: d.id, copies: (box ? box.quantity : 1) * d.quantity };
  });
  const physicalTotal = currentDrawerCopies.reduce((s, d) => s + d.copies, 0);
  const latestQuote = quotes.length
    ? quotes.reduce((a, b) => (new Date(a.created_at) >= new Date(b.created_at) ? a : b))
    : null;

  // Quote-modal rate knobs default from the ACTIVE rate card (fall back to the
  // code default if the row is missing/unreadable so the modal always opens).
  let activeConfig = DEFAULT_PRICING_CONFIG;
  try {
    if (!configRes.error && configRes.data?.config) activeConfig = parsePricingConfig(configRes.data.config);
  } catch {
    /* keep code default */
  }
  const dollars = (cents: number | null | undefined, fallback: number): string =>
    ((cents ?? fallback) / 100).toFixed(2);
  const tierRate = (tier: "essential" | "professional" | "premium"): string =>
    dollars(activeConfig.product.tier_rates_cents_per_sqft?.[tier], activeConfig.product.rate_cents_per_sqft);
  const rateDefaults: RateDefaults = {
    essential: tierRate("essential"),
    professional: tierRate("professional"),
    premium: tierRate("premium"),
    design_base: dollars(activeConfig.services.measurement_design.base_cents, 0),
    travel_per_mile: dollars(activeConfig.services.measurement_design.travel_cents_per_mile, 0),
    ship_base: dollars(
      activeConfig.services.delivery_install.shipping_base_cents,
      DEFAULT_PRICING_CONFIG.services.delivery_install.shipping_base_cents ?? 0,
    ),
    ship_per_sqft: dollars(
      activeConfig.services.delivery_install.shipping_cents_per_sqft,
      DEFAULT_PRICING_CONFIG.services.delivery_install.shipping_cents_per_sqft ?? 0,
    ),
    drawer_min: dollars(activeConfig.minimums.per_drawer_cents, 0),
    order_min: dollars(activeConfig.minimums.per_order_cents, 0),
  };

  return (
    <main className="wrap wrap--wide">
      <p className="eyebrow" style={{ marginTop: "0.25rem" }}>
        <a href="/admin/orders">← Orders</a>
      </p>

      <div className="order-head">
        <div style={{ minWidth: 0 }}>
          <h1 style={{ marginBottom: "0.25rem" }}>{o.project_name || o.customer_name || "Order"}</h1>
          <p className="muted sub" style={{ margin: 0, display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
            {detail.customer ? (
              <span className="chip">
                {detail.customer.name || detail.customer.email}
                {detail.organization ? (
                  <>
                    {" "}
                    · <strong>{detail.organization.name}</strong>
                  </>
                ) : null}
              </span>
            ) : (
              <span className="badge badge--warn">Unassigned</span>
            )}
            <span>
              Created {new Date(o.created_at).toLocaleDateString()} ·{" "}
              <span className="num">{formatCents(o.total_price) ?? "no price"}</span>
              {latestQuote ? (
                <>
                  {" "}
                  · <span className="num">latest quote {formatCents(latestQuote.total_cents)}</span>
                </>
              ) : null}
            </span>
          </p>
        </div>

        <div className="order-head__actions">
          <GenerateQuoteModal
            orderId={o.id}
            drawerCount={detail.drawers.length}
            physicalCount={physicalTotal}
            defaultMiles={o.round_trip_miles}
            hasSite={!!o.site_address}
            rates={rateDefaults}
          />
          <EditOrderModal
            order={{
              id: o.id,
              customer_name: o.customer_name,
              customer_email: o.customer_email,
              customer_phone: o.customer_phone,
              project_name: o.project_name,
              location: o.location,
              notes: o.notes,
              drawer_count: o.drawer_count,
              total_price: o.total_price,
              site_address: o.site_address,
              round_trip_miles: o.round_trip_miles,
            }}
            customers={customers}
            hasCustomer={!!detail.customer}
            drawerCount={detail.drawers.length}
          />
        </div>
      </div>

      {sp.error ? (
        <p className="banner--err" role="alert">
          {sp.error}
        </p>
      ) : null}

      <OrderContents
        orderId={o.id}
        boxes={detail.boxes.map((b) => ({ id: b.id, label: b.label, quantity: b.quantity }))}
        drawers={detail.drawers.map((d) => ({
          id: d.id,
          nickname: d.nickname,
          status: d.status,
          customer_approval_status: d.customer_approval_status,
          photo_url: d.photo_url,
          design_preview_url: d.design_preview_url,
          point_cloud_url: d.point_cloud_url,
          box_id: d.box_id,
          tier: d.tier,
          quantity: d.quantity,
        }))}
      />

      <QuotesSection orderId={o.id} quotes={quotes} currentDrawerCopies={currentDrawerCopies} />
    </main>
  );
}
