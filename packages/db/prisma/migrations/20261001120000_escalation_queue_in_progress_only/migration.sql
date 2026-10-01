-- Escalation queue: a case no longer waits in an "Open" lane for someone to claim it. Every case the AI
-- could not resolve starts IN_PROGRESS (the whole team sees it), a staff member's first reply in that
-- chat assigns it to them, and it leaves IN_PROGRESS only when staff hand the chat back to the AI
-- (RESOLVED) or close it (RESOLVED / CANCELLED). The OPEN value therefore no longer exists.

UPDATE "escalation_cases" SET "status" = 'IN_PROGRESS' WHERE "status" = 'OPEN';

ALTER TYPE "EscalationStatus" RENAME TO "EscalationStatus_old";
CREATE TYPE "EscalationStatus" AS ENUM ('IN_PROGRESS', 'RESOLVED', 'CANCELLED');
ALTER TABLE "escalation_cases" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "escalation_cases"
  ALTER COLUMN "status" TYPE "EscalationStatus" USING ("status"::text::"EscalationStatus");
ALTER TABLE "escalation_cases" ALTER COLUMN "status" SET DEFAULT 'IN_PROGRESS';
DROP TYPE "EscalationStatus_old";
