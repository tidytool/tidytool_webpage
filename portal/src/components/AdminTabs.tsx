"use client";

import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin", label: "Pipeline" },
  { href: "/admin/queue", label: "Queue" },
  { href: "/admin/orders", label: "Orders" },
  { href: "/admin/customers", label: "Customers", adminOnly: true },
  { href: "/admin/organizations", label: "Organizations", adminOnly: true },
  { href: "/admin/employees", label: "Employees", adminOnly: true },
  { href: "/admin/accuracy", label: "Accuracy", adminOnly: true },
  { href: "/admin/history", label: "History", adminOnly: true },
];

/** Segmented admin nav with an active state (why: orientation was the #1
 *  complaint — you couldn't tell which admin view you were on). Staff see
 *  only the read-only order views; the admin-only tabs stay hidden. */
export function AdminTabs({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);

  return (
    <nav className="admin-tabs" aria-label="Admin sections">
      {TABS.filter((t) => isAdmin || !t.adminOnly).map((t) => (
        <a key={t.href} href={t.href} aria-current={isActive(t.href) ? "page" : undefined}>
          {t.label}
        </a>
      ))}
    </nav>
  );
}
