/**
 * Sticky drawer-to-drawer navigation on /labels/[id].
 *
 * Loading tools means walking a whole cabinet: without this, each drawer costs
 * back → scroll → find the row → tap. With it: tap → next → next. Server
 * component, plain links, no JS.
 */
export type DrawerNavItem = { id: string; name: string };

export function DrawerNav({
  currentId,
  orderHref,
  orderTitle,
  items,
}: {
  currentId: string;
  orderHref: string;
  orderTitle: string;
  items: DrawerNavItem[];
}) {
  const i = items.findIndex((d) => d.id === currentId);
  const prev = i > 0 ? items[i - 1] : null;
  const next = i >= 0 && i < items.length - 1 ? items[i + 1] : null;
  const showSteps = items.length > 1 && i >= 0;

  return (
    <nav className="dnav" aria-label="Drawer navigation">
      <a href={orderHref} className="dnav__back">
        <span aria-hidden>←</span> {orderTitle}
      </a>
      {showSteps ? (
        <div className="dnav__steps">
          {prev ? (
            <a href={`/labels/${prev.id}`} className="btn btn--ghost btn--sm dnav__btn" rel="prev">
              <span aria-hidden>‹</span> <span className="dnav__name">{prev.name}</span>
            </a>
          ) : (
            <span className="btn btn--ghost btn--sm dnav__btn dnav__btn--off" aria-disabled>
              <span aria-hidden>‹</span>
            </span>
          )}
          <span className="dnav__count num">
            {i + 1} of {items.length}
          </span>
          {next ? (
            <a href={`/labels/${next.id}`} className="btn btn--ghost btn--sm dnav__btn" rel="next">
              <span className="dnav__name">{next.name}</span> <span aria-hidden>›</span>
            </a>
          ) : (
            <span className="btn btn--ghost btn--sm dnav__btn dnav__btn--off" aria-disabled>
              <span aria-hidden>›</span>
            </span>
          )}
        </div>
      ) : null}
    </nav>
  );
}
