import { createClient } from "@/lib/supabase/server";
import { requireAdminPage } from "@/lib/require-admin";
import { type CalibrationPoint, type CalibrationSummary } from "@/lib/types";
import { CalibrationAccuracy } from "@/components/CalibrationAccuracy";

export const dynamic = "force-dynamic";

/**
 * Scan accuracy: live per-scan calibration quality from tidyCAM. The admin
 * layout already redirects non-admins, but the real boundary is the RPCs
 * themselves — get_calibration_accuracy_series raises "staff or admin only"
 * in the database, which we surface here as an access-denied state.
 */
export default async function AdminAccuracyPage() {
  await requireAdminPage();
  const supabase = await createClient();
  const [seriesRes, summaryRes] = await Promise.all([
    supabase.rpc("get_calibration_accuracy_series", { p_days: 90 }),
    supabase.rpc("get_calibration_accuracy_summary", { p_days: 30 }),
  ]);

  if (seriesRes.error && /staff or admin only/i.test(seriesRes.error.message)) {
    return (
      <main className="wrap wrap--wide">
        <p className="banner--err" role="alert">
          Access denied — this page is for staff and admins only.
        </p>
      </main>
    );
  }

  const series = (seriesRes.data ?? []) as CalibrationPoint[];
  const summary = (summaryRes.data?.[0] ?? null) as CalibrationSummary | null;

  return (
    <main className="wrap wrap--wide">
      <div className="page-head">
        <div>
          <p className="eyebrow">Admin</p>
          <h1>Scan accuracy</h1>
          <p className="muted sub num">
            Per-scan calibration quality from tidyCAM, updating live as new
            scans arrive. Higher is better; the target is {90}% or above.
          </p>
        </div>
      </div>

      {seriesRes.error ? (
        <p className="banner--err" role="alert">{seriesRes.error.message}</p>
      ) : null}

      <CalibrationAccuracy initialSeries={series} initialSummary={summary} />
    </main>
  );
}
