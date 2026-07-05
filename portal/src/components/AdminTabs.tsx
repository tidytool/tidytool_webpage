"use client";

import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin", label: "Pipeline" },
  { href: "/admin/orders", label: "Orders" },
  { href: "/admin/customers", label: "Customers" },
  { href: "/admin/organizations", label: "Organizations" },
  { href: "/admin/history", label: "History" },
];

/** Segmented admin nav with an active state (why: orientation was the #1
 *  complaint — you couldn't tell which admin view you were on). */
export function AdminTabs() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);

  return (
    <nav className="admin-tabs" aria-label="Admin sections">
      {TABS.map((t) => (
        <a key={t.href} href={t.href} aria-current={isActive(t.href) ? "page" : undefined}>
          {t.label}
        </a>
      ))}
    </nav>
  );
}
