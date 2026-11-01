ALTER TABLE "AppAccessGrant" ADD COLUMN "sessionId" TEXT;
-- Earlier development grants have no individual session binding. They remain
-- recorded but cannot authenticate; users create a fresh scoped grant.
