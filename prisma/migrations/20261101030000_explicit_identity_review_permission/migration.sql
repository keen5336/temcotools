-- Identity correction is new authority; legacy managers do not inherit it.
-- Prior migration is already applied in qualification and stays immutable.
UPDATE "RoleBundle" SET "capabilities" = array_remove("capabilities", 'inventory.identify'),
  "description" = 'Initial legacy manager access; new identity correction authority requires explicit assignment', "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'legacy-manager';
INSERT INTO "RoleBundle" ("id", "name", "description", "capabilities", "isSystem", "updatedAt")
VALUES ('identity-reviewer', 'Inventory identity reviewer', 'Optional and unassigned by default; requires explicit administrator assignment', ARRAY['inventory.read', 'inventory.identify'], true, CURRENT_TIMESTAMP);
UPDATE "User" SET "authVersion" = "authVersion" + 1 WHERE "id" IN (SELECT "userId" FROM "UserRoleBundle" WHERE "bundleId" = 'legacy-manager');
UPDATE "UserSession" SET "revokedAt" = CURRENT_TIMESTAMP WHERE "revokedAt" IS NULL AND "userId" IN (SELECT "userId" FROM "UserRoleBundle" WHERE "bundleId" = 'legacy-manager');
