/**
 * Order titles and drawer-name shortening for the customer surfaces.
 *
 * Drawer nicknames from tidyCAM usually share a prefix ("Mechanical Trainer -
 * Frontier - Hand Tools"). The dashboard shows the shared part once as the
 * order title and the remainder on each row. Matching is done on WORDS, not on
 * " - " tokens, so one drawer typed as "Mechanical Trainer Frontier - Large
 * Drawer" (missing a dash) no longer defeats the grouping for the whole order.
 */

const WORD = /[^\s\-–—]+/g;

function words(name: string): string[] {
  return name.match(WORD) ?? [];
}

/** Number of leading words every name shares — never a whole name. */
export function sharedPrefixWords(names: (string | null)[]): number {
  if (names.length < 2 || names.some((n) => !n)) return 0;
  const split = names.map((n) => words(n as string).map((w) => w.toLowerCase()));
  let k = Math.max(0, split[0].length - 1);
  for (const w of split.slice(1)) {
    let i = 0;
    while (i < k && i < w.length - 1 && split[0][i] === w[i]) i++;
    k = i;
    if (k === 0) return 0;
  }
  return k;
}

/** Character offset just past the k-th word of `name`. */
function afterWord(name: string, k: number): number {
  let n = 0;
  for (const m of name.matchAll(WORD)) {
    n++;
    if (n === k) return (m.index ?? 0) + m[0].length;
  }
  return name.length;
}

/** The shared prefix as it appears in the first name ("Mechanical Trainer - Frontier"). */
export function prefixTitle(names: (string | null)[], k: number): string {
  const first = names.find((n) => !!n) ?? "";
  return first.slice(0, afterWord(first, k)).replace(/[\s\-–—]+$/, "").trim();
}

/** A drawer's name minus the shared prefix ("Hand Tools"); falls back to the full name. */
export function stripPrefixWords(name: string | null, k: number): string {
  if (!name) return "Drawer";
  if (k === 0) return name;
  const rest = name.slice(afterWord(name, k)).replace(/^[\s\-–—]+/, "").trim();
  return rest || name;
}

/** Customer-facing order title: project name → shared drawer prefix → received date → generic. */
export function orderTitle(opts: {
  projectName?: string | null;
  drawerNames: (string | null)[];
  received?: string | null;
}): { title: string; prefixWords: number } {
  const k = sharedPrefixWords(opts.drawerNames);
  const prefix = k ? prefixTitle(opts.drawerNames, k) : "";
  const title =
    opts.projectName || prefix || (opts.received ? `Order — received ${opts.received}` : "Your order");
  return { title, prefixWords: k };
}
