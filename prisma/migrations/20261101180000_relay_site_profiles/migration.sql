CREATE TABLE "SiteProfile" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "origin" TEXT NOT NULL,
  "pathPrefix" TEXT NOT NULL DEFAULT '/',
  "purpose" TEXT NOT NULL,
  "payloadId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "removedAt" TIMESTAMP(3),
  "createdByUserId" TEXT NOT NULL,
  "updatedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SiteProfile_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SiteProfile_payloadId_fkey" FOREIGN KEY ("payloadId") REFERENCES "Payload"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SiteProfile_revision_positive" CHECK ("revision" > 0),
  CONSTRAINT "SiteProfile_known_purpose" CHECK ("purpose" IN ('dmp_relay', 'mars_label_helper', 'route_planner_relay')),
  CONSTRAINT "SiteProfile_removed_disabled" CHECK ("removedAt" IS NULL OR "enabled" = false)
);
CREATE INDEX "SiteProfile_origin_id_idx" ON "SiteProfile"("origin", "id");
-- Deliberately no guessed site origins, profiles or automatically published code.
