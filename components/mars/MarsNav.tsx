import Link from "next/link";

const links = [
  { href: "/tools/mars/import", label: "Import" },
  { href: "/tools/mars/inventory", label: "Inventory" },
  { href: "/tools/mars/audit", label: "Audit" },
  { href: "/tools/mars/reconciliation", label: "Reconciliation" },
];

export default function MarsNav() {
  return (
    <div className="flex flex-wrap gap-2 mb-6">
      {links.map((link) => (
        <Link key={link.href} href={link.href} className="btn btn-sm btn-outline">
          {link.label}
        </Link>
      ))}
    </div>
  );
}
