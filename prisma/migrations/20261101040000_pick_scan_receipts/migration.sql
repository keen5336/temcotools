ALTER TABLE "PickWaveScan" ADD COLUMN "captureEventId" TEXT, ADD COLUMN "captureResult" JSONB;
CREATE UNIQUE INDEX "PickWaveScan_captureEventId_key" ON "PickWaveScan"("captureEventId");
