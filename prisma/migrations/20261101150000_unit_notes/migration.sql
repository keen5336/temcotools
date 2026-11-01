CREATE TABLE "WarehouseUnitNote" (
  id TEXT PRIMARY KEY,
  "unitId" TEXT NOT NULL REFERENCES "WarehouseUnit"(id) ON DELETE RESTRICT,
  "authorUserId" TEXT NOT NULL,
  "authorUsername" TEXT NOT NULL,
  "authorName" TEXT NOT NULL,
  "currentRevision" INTEGER NOT NULL DEFAULT 1 CHECK ("currentRevision" > 0),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','tombstoned')),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "WarehouseUnitNote_unitId_id_idx" ON "WarehouseUnitNote"("unitId",id);
CREATE TABLE "WarehouseUnitNoteRevision" (
  id TEXT PRIMARY KEY,
  "noteId" TEXT NOT NULL REFERENCES "WarehouseUnitNote"(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  action TEXT NOT NULL CHECK (action IN ('append','correct','tombstone','restore')),
  body TEXT NOT NULL,
  reason TEXT,
  "editedByUserId" TEXT NOT NULL,
  "editorUsername" TEXT NOT NULL,
  "editorName" TEXT NOT NULL,
  "correctedOtherAuthor" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE("noteId",revision)
);
-- Application commands only append revisions and advance the guarded note head.
-- Tombstones retain all original text/history; no public hard-delete action exists.
CREATE FUNCTION "prevent_warehouse_note_revision_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Warehouse note revision text and attribution are immutable; append a correction'; END;
$$;
CREATE TRIGGER "WarehouseUnitNoteRevision_immutable_update" BEFORE UPDATE ON "WarehouseUnitNoteRevision" FOR EACH ROW EXECUTE FUNCTION "prevent_warehouse_note_revision_update"();
