# Retained warehouse workflow qualification

The current site/RLS/shared-identity model is exercised through one retained operator journey in `scripts/retained-warehouse.integration.test.ts`. This is a focused compatibility check of native application behavior, rather than a port of old fixtures that predate warehouse memberships.

The fixture creates only synthetic people, sessions, two warehouses, source rows and workflow records in the exact guarded loopback `temcotools_v2_warehouse_scope_test` database at `127.0.0.1:55439`. Its lead is a warehouse manager with `isPlatformAdmin=false`; its operator has a current warehouse-operator membership. No legacy global bundle is treated as warehouse authority. The test does not select a public host, production database, real customer payload, printer or external integration.

The journey uses the same `executeApplicationAction` services used by the UI and MCP:

1. Import one synthetic WMS report. A and B share an order number but have different canonical units/LPN aliases; a third unallocated unit supplies a warehouse-wide scan case.
2. Create and approve an explicitly manual demand snapshot. Exact aliases identify quantity-one slots; an order-only requirement remains missing. Allocate A and B and generate the existing native Pick Wave using their canonical aliases. Its two rows do not absorb every unit on the order.
3. Scan the unallocated unit during the picking pass: retain its resolved physical observation even though it does not match a pick requirement. An order-only scan cannot select the bound picks. Exact A/B scans perform native picking; replaying the same event retains one observation. These broad scans do not fulfill lane finals.
4. Scan A in B's lane, retain the actual wrong lane and return the destination instruction. Scanning the destination without placement confirmation does not fulfill it. A fresh confirmed destination scan fulfills it once; a duplicate does not add quantity.
5. Sign a lane against its manual snapshot. An amended source moves B to a new lane while retaining compatible A evidence and its original immutable signature. B requires explicit reallocation and fresh destination confirmation. The old snapshot cannot receive a fresh sign-off.
6. Record the retained Office scenario: original A has left the warehouse, replacement B goes to an exchange, and a missed attempt leaves A's future return deferred while B is expected back. Before B checks in, it is not claimed physically present or awaiting warehouse reschedule. After B's independent check-in and a current complete manual scheduling statement, one durable replacement-reschedule case is created. A valid watch survives repeated evaluation; a new date resolves that scheduling issue. An A-only handling instruction does not apply to B.
7. Deny foreign-site unit/board/history access. Deny scan execution through a real persisted synthetic read-only client grant, even when the principal's cached capabilities contain a broader role. Membership revocation affects the existing session and grant. Lead access and the preserved signature remain intact.

The source retains the qualification distinction throughout: `dispatch.adapter` reports both DMP adapter and official-finals qualification false, and generated work/signatures identify manual demand. A manual Office schedule is not a qualified DMP adapter. Reported WMS stock, scan presence, destination placement, sign-off and later departure remain separate facts.

## Running the focused check

From the MacDev-backed checkout, provide `WAREHOUSE_SCOPE_TEST_DATABASE_URL` through the local development environment and run:

```sh
dev-run -- npx tsx --test scripts/retained-warehouse.integration.test.ts
```

The test validates the exact local host/port/database and refuses connection-string query overrides. It uses unique synthetic namespaces and retains attributed records and immutable history; it does not reset the database or rewrite older fixtures. `TEMCO_PILOT_MODE` is unset only in that disposable test process so local synthetic scan/sign-off paths can run. This does not change pilot runtime restrictions.

Software checkpoint on 2026-11-03: five substantive subtests plus their parent passed (6/6) against the current 40-migration schema and source baseline `94782b7`. Scoped ESLint and whole-tree TypeScript are checked with the package. The broader controlled-custody qualification separately covers same-ID cross-site moves and private handoff history.

## Limits

This is native PostgreSQL/service/application-command qualification. The persisted-grant check exercises current server-side scope enforcement; it does not claim a new remote OAuth ceremony or SDK wire session. The coordinator qualifies deployed public MCP independently.

The test does not qualify live DMP fields, Ashe's official-finals meaning, actual Zebra/phone scanning, camera/OCR results, physical lane inspection, printing, live MARS actions or upstream WMS writes. Every physical observation and warehouse outcome in this check is synthetic local data. Manual operator/device acceptance and upstream contract qualification remain separate.

Exact latest receipts:6/6 `20261103-171821-build-21903`, scoped ESLint `171915-build-22078`, whole-tree TypeScript `171916-build-22079`. No runtime correction was needed from this bounded compatibility check.
