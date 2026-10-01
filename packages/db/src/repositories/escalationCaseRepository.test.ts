import {
  createInitialJourneyContext,
  EscalationReason,
  EscalationResolution,
  EscalationStatus,
  EscalationTier,
  type TenantId,
} from '@ai-concierge/domain';
import {
  createTestPrismaClient,
  seedTestTenants,
  seedTestUser,
  truncateAllTables,
  TEST_TENANT_ID,
} from '@ai-concierge/testing';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acquireJourneyLock, createJourney } from './journeyRepository.js';
import {
  assignEscalationCaseToStaff,
  createEscalationCase,
  findBreachedEscalationCases,
  findEscalationCaseById,
  findActiveEscalationCaseForJourney,
  listEscalationCases,
  markEscalationCaseSlaBreached,
  resolveEscalationCase,
} from './escalationCaseRepository.js';

async function seedJourney(prisma: PrismaClient, tenantId: TenantId) {
  const conversation = await prisma.conversation.create({
    data: { tenantId, channel: 'WHATSAPP', customerRef: '+15550000002' },
  });
  return prisma.$transaction(async (tx) => {
    await acquireJourneyLock(tx, tenantId, conversation.id);
    return createJourney(tx, {
      tenantId,
      conversationId: conversation.id,
      context: createInitialJourneyContext(conversation.id),
    });
  });
}

describe('escalationCaseRepository', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAllTables(prisma);
    await seedTestTenants(prisma);
  });

  it('creates a case with an SLA due date derived from the tier', async () => {
    const journey = await seedJourney(prisma, TEST_TENANT_ID);
    const now = new Date('2026-10-01T00:00:00.000Z');

    const created = await prisma.$transaction((tx) =>
      createEscalationCase(
        tx,
        TEST_TENANT_ID,
        {
          journeyId: journey.id,
          tier: EscalationTier.T3,
          reason: EscalationReason.QUOTE_NEEDS_REVIEW,
          detail: 'large discount applied',
        },
        now,
      ),
    );

    // No unclaimed "open" lane: a case is with the whole team from the start.
    expect(created.status).toBe(EscalationStatus.IN_PROGRESS);
    expect(created.assignedToUserId).toBeNull();
    expect(created.slaBreached).toBe(false);
    expect(new Date(created.slaDueAt).getTime()).toBe(now.getTime() + 240 * 60_000);

    const found = await findEscalationCaseById(prisma, TEST_TENANT_ID, created.id);
    expect(found?.id).toBe(created.id);

    const activeForJourney = await findActiveEscalationCaseForJourney(
      prisma,
      TEST_TENANT_ID,
      journey.id,
    );
    expect(activeForJourney?.id).toBe(created.id);
  });

  it('the first staff reply claims the case; a second staff member never takes it over', async () => {
    const journey = await seedJourney(prisma, TEST_TENANT_ID);
    const worker = await seedTestUser(prisma, { tenantId: TEST_TENANT_ID, role: 'OPS_AGENT' });
    const created = await prisma.$transaction((tx) =>
      createEscalationCase(
        tx,
        TEST_TENANT_ID,
        {
          journeyId: journey.id,
          tier: EscalationTier.T2,
          reason: EscalationReason.MISSING_INFO_STALLED,
          detail: 'no reply after 3 attempts',
        },
        new Date(),
      ),
    );

    expect(await assignEscalationCaseToStaff(prisma, TEST_TENANT_ID, journey.id, worker.id)).toBe(
      true,
    );
    const claimed = await findEscalationCaseById(prisma, TEST_TENANT_ID, created.id);
    expect(claimed?.status).toBe(EscalationStatus.IN_PROGRESS);
    expect(claimed?.assignedToUserId).toBe(worker.id);

    const otherWorker = await seedTestUser(prisma, {
      tenantId: TEST_TENANT_ID,
      role: 'MANAGER',
      email: 'manager@example.com',
    });
    expect(
      await assignEscalationCaseToStaff(prisma, TEST_TENANT_ID, journey.id, otherWorker.id),
    ).toBe(false);
    const stillClaimed = await findEscalationCaseById(prisma, TEST_TENANT_ID, created.id);
    expect(stillClaimed?.assignedToUserId).toBe(worker.id);
  });

  it('resolves a case exactly once — a second resolve attempt is a no-op', async () => {
    const journey = await seedJourney(prisma, TEST_TENANT_ID);
    const worker = await seedTestUser(prisma, { tenantId: TEST_TENANT_ID, role: 'MANAGER' });
    const created = await prisma.$transaction((tx) =>
      createEscalationCase(
        tx,
        TEST_TENANT_ID,
        {
          journeyId: journey.id,
          tier: EscalationTier.T3,
          reason: EscalationReason.ELIGIBILITY_NEEDS_REVIEW,
          detail: 'nationality override, high risk',
        },
        new Date(),
      ),
    );

    const resolved = await resolveEscalationCase(prisma, {
      tenantId: TEST_TENANT_ID,
      id: created.id,
      resolvedByUserId: worker.id,
      resolution: EscalationResolution.APPROVED,
      resolutionNote: 'confirmed VIP, waived',
      now: new Date(),
    });
    expect(resolved?.status).toBe(EscalationStatus.RESOLVED);
    expect(resolved?.resolution).toBe(EscalationResolution.APPROVED);

    const secondAttempt = await resolveEscalationCase(prisma, {
      tenantId: TEST_TENANT_ID,
      id: created.id,
      resolvedByUserId: worker.id,
      resolution: EscalationResolution.REJECTED,
      resolutionNote: 'changed my mind',
      now: new Date(),
    });
    expect(secondAttempt).toBeNull();

    const stillApproved = await findEscalationCaseById(prisma, TEST_TENANT_ID, created.id);
    expect(stillApproved?.resolution).toBe(EscalationResolution.APPROVED);
  });

  it('lists in-progress cases with their chat and whether a person has answered in it', async () => {
    const journey = await seedJourney(prisma, TEST_TENANT_ID);
    const worker = await seedTestUser(prisma, { tenantId: TEST_TENANT_ID, role: 'OPS_AGENT' });
    const openCase = await prisma.$transaction((tx) =>
      createEscalationCase(
        tx,
        TEST_TENANT_ID,
        {
          journeyId: journey.id,
          tier: EscalationTier.T2,
          reason: EscalationReason.MISSING_INFO_STALLED,
          detail: 'x',
        },
        new Date(),
      ),
    );
    const resolvedCase = await prisma.$transaction((tx) =>
      createEscalationCase(
        tx,
        TEST_TENANT_ID,
        {
          journeyId: journey.id,
          tier: EscalationTier.T2,
          reason: EscalationReason.MISSING_INFO_STALLED,
          detail: 'y',
        },
        new Date(),
      ),
    );
    await resolveEscalationCase(prisma, {
      tenantId: TEST_TENANT_ID,
      id: resolvedCase.id,
      resolvedByUserId: worker.id,
      resolution: EscalationResolution.REJECTED,
      resolutionNote: 'declined',
      now: new Date(),
    });

    const inProgress = await listEscalationCases(prisma, {
      tenantId: TEST_TENANT_ID,
      status: 'IN_PROGRESS',
      limit: 10,
      offset: 0,
    });
    expect(inProgress.map((c) => c.id)).toEqual([openCase.id]);
    expect(inProgress[0]).toMatchObject({
      conversationId: journey.conversationId,
      channel: 'WHATSAPP',
      customerRef: '+15550000002',
      humanReplied: false,
      lastHumanReplyAt: null,
    });

    // A staff reply in the chat after the case was raised turns the tick on.
    await prisma.outboundMessage.create({
      data: {
        tenantId: TEST_TENANT_ID,
        conversationId: journey.conversationId,
        content: 'Hello, this is the team',
        source: 'HUMAN',
        stage: 'STAFF_REPLY',
        authorUserId: worker.id,
      },
    });
    const afterReply = await listEscalationCases(prisma, {
      tenantId: TEST_TENANT_ID,
      status: 'IN_PROGRESS',
      limit: 10,
      offset: 0,
    });
    expect(afterReply[0]?.humanReplied).toBe(true);
    expect(afterReply[0]?.lastHumanReplyAt).not.toBeNull();

    const finished = await listEscalationCases(prisma, {
      tenantId: TEST_TENANT_ID,
      status: 'RESOLVED',
      limit: 10,
      offset: 0,
    });
    expect(finished.map((c) => c.id)).toEqual([resolvedCase.id]);
  });

  it('the SLA sweep finds only breached, still-in-progress cases and marks them exactly once', async () => {
    const journey = await seedJourney(prisma, TEST_TENANT_ID);
    const past = new Date(Date.now() - 10 * 60_000);
    const overdue = await prisma.$transaction((tx) =>
      createEscalationCase(
        tx,
        TEST_TENANT_ID,
        {
          journeyId: journey.id,
          tier: EscalationTier.T4,
          reason: EscalationReason.CUSTOMER_COMPLAINT,
          detail: 'x',
        },
        past,
      ),
    );
    // T4's SLA is 30 minutes; created 10 minutes ago at `past` is not yet due relative to `past`,
    // but IS overdue relative to "now" once we check with a `now` far enough past `past + 30m`.
    const checkAt = new Date(past.getTime() + 31 * 60_000);

    const breached = await findBreachedEscalationCases(prisma, checkAt);
    expect(breached.map((c) => c.id)).toEqual([overdue.id]);

    await markEscalationCaseSlaBreached(prisma, overdue.id);
    const afterMark = await findBreachedEscalationCases(prisma, checkAt);
    expect(afterMark).toHaveLength(0);

    const persisted = await findEscalationCaseById(prisma, TEST_TENANT_ID, overdue.id);
    expect(persisted?.slaBreached).toBe(true);
  });
});
