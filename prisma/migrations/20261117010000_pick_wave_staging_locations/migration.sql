CREATE TABLE "PickWaveStagingLocation" (
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PickWaveStagingLocation_pkey" PRIMARY KEY ("name")
);

-- Preserve the original 9–14 A–D choices and add the new 7–8 A–E locations.
-- Seed once here so removing all locations remains an intentional saved setting.
INSERT INTO "PickWaveStagingLocation" ("name")
SELECT n::text || '-' || letter
FROM generate_series(9, 14) AS n
CROSS JOIN unnest(ARRAY['A', 'B', 'C', 'D']) AS letter
UNION ALL
SELECT n::text || '-' || letter
FROM generate_series(7, 8) AS n
CROSS JOIN unnest(ARRAY['A', 'B', 'C', 'D', 'E']) AS letter;
