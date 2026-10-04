import {
  Prisma,
  type PrismaClient,
  type EscalationCase as PrismaEscalationCase,
} from '@prisma/client';
import {
  ESCALATION_SLA_MINUTES,
  EscalationStatus,
  escalationCaseSchema,
  type CreateEscalationCaseInput,
  type EscalationCase,
  type EscalationCaseListItem,
  type EscalationResolutionValue,
  type TenantId,
} from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

export function toDomainEscalationCase(row: PrismaEscalationCase): EscalationCase {
  return escalationCaseSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    journeyId: row.journeyId,
    tier: row.tier,
    reason: row.reason,
    status: row.status,
    detail: row.detail,
    assignedToUserId: row.assignedToUserId,
    slaDueAt: row.slaDueAt.toISOString(),
    slaBreached: row.slaBreached,
    resolution: row.resolution,
    resolutionNote: row.resolutionNote,
    resolvedByUserId: row.resolvedByUserId,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Caller (journeyService.ts, inside the same transaction as the ESCALATED transition) supplies `now` for testability. */
export async function createEscalationCase(
  tx: Prisma.TransactionClient,
  tenantId: TenantId,
  input: CreateEscalationCaseInput,
  now: Date,
): Promise<EscalationCase> {
  const slaDueAt = new Date(now.getTime() + ESCALATION_SLA_MINUTES[input.tier] * 60_000);
  const row = await tx.escalationCase.create({
    data: {
      tenantId,
      journeyId: input.journeyId,
      tier: input.tier,
      reason: input.reason,
      detail: input.detail,
      slaDueAt,
    },
  });
  return toDomainEscalationCase(row);
}

export async function findEscalationCaseById(
  db: Executor,
  tenantId: TenantId,
  id: string,
): Promise<EscalationCase | null> {
  const row = await db.escalationCase.findFirst({ where: { id, tenantId } });
  return row ? toDomainEscalationCase(row) : null;
}

/** The journey's case that is still with the team (IN_PROGRESS); a journey has at most one at a time. */
export async function findActiveEscalationCaseForJourney(
  db: Executor,
  tenantId: TenantId,
  journeyId: string,
): Promise<EscalationCase | null> {
  const row = await db.escalationCase.findFirst({
    where: { tenantId, journeyId, status: EscalationStatus.IN_PROGRESS },
    orderBy: { createdAt: 'desc' },
  });
  return row ? toDomainEscalationCase(row) : null;
}

export interface ListEscalationCasesParams {
  tenantId: TenantId;
  status?: keyof typeof EscalationStatus;
  assignedToUserId?: string | null;
  limit: number;
  offset: number;
}

export async function listEscalationCases(
  db: Executor,
  params: ListEscalationCasesParams,
): Promise<EscalationCaseListItem[]> {
  const inProgress = params.status === EscalationStatus.IN_PROGRESS;
  // The queue is worked oldest-first with overdue cases on top; finished cases read newest-first.
  const orderBy: Prisma.EscalationCaseOrderByWithRelationInput[] = inProgress
    ? [{ slaBreached: 'desc' }, { createdAt: 'asc' }]
    : [{ updatedAt: 'desc' }, { createdAt: 'desc' }];
  const rows = await db.escalationCase.findMany({
    where: {
      tenantId: params.tenantId,
      ...(params.status ? { status: params.status } : {}),
      ...(params.assignedToUserId !== undefined
        ? { assignedToUserId: params.assignedToUserId }
        : {}),
    },
    orderBy,
    take: params.limit,
    skip: params.offset,
    include: {
      journey: {
        select: {
          conversationId: true,
          conversation: { select: { channel: true, customerRef: true } },
        },
      },
    },
  });
  if (rows.length === 0) return [];

  const lastReplies = await db.outboundMessage.groupBy({
    by: ['conversationId'],
    where: {
      tenantId: params.tenantId,
      source: 'HUMAN',
      conversationId: { in: rows.map((row) => row.journey.conversationId) },
    },
    _max: { createdAt: true },
  });
  const lastReplyByConversation = new Map(
    lastReplies.map((entry) => [entry.conversationId, entry._max.createdAt]),
  );

  return rows.map((row) => {
    const lastReply = lastReplyByConversation.get(row.journey.conversationId) ?? null;
    const humanReplied = lastReply !== null && lastReply >= row.createdAt;
    return {
      ...toDomainEscalationCase(row),
      conversationId: row.journey.conversationId,
      channel: row.journey.conversation.channel,
      customerRef: row.journey.conversation.customerRef,
      humanReplied,
      lastHumanReplyAt: humanReplied ? lastReply.toISOString() : null,
    };
  });
}

/**
 * A staff member's first reply in a chat claims the case that is still unassigned, so the queue shows
 * who is on it. A case someone already holds is never taken over by a second person's reply.
 */
export async function assignEscalationCaseToStaff(
  db: Executor,
  tenantId: TenantId,
  journeyId: string,
  userId: string,
): Promise<boolean> {
  const result = await db.escalationCase.updateMany({
    where: { tenantId, journeyId, status: EscalationStatus.IN_PROGRESS, assignedToUserId: null },
    data: { assignedToUserId: userId },
  });
  return result.count > 0;
}

export interface ResolveEscalationCaseParams {
  tenantId: TenantId;
  id: string;
  resolvedByUserId: string;
  resolution: EscalationResolutionValue;
  resolutionNote: string;
  now: Date;
}

/** Only an IN_PROGRESS case can resolve — an already-resolved case is never silently overwritten. */
export async function resolveEscalationCase(
  db: Executor,
  params: ResolveEscalationCaseParams,
): Promise<EscalationCase | null> {
  const result = await db.escalationCase.updateMany({
    where: {
      id: params.id,
      tenantId: params.tenantId,
      status: EscalationStatus.IN_PROGRESS,
    },
    data: {
      status: EscalationStatus.RESOLVED,
      resolution: params.resolution,
      resolutionNote: params.resolutionNote,
      resolvedByUserId: params.resolvedByUserId,
      resolvedAt: params.now,
    },
  });
  if (result.count === 0) {
    return null;
  }
  return findEscalationCaseById(db, params.tenantId, params.id);
}

export interface CancelEscalationCaseParams {
  tenantId: TenantId;
  id: string;
  note: string;
  now: Date;
}

/**
 * Closes a case that no longer needs a person because the situation that
 * raised it resolved itself (e.g. a customer who stalled on booking details
 * later supplied them). Distinct from `resolveEscalationCase`: no human
 * decided anything, so no resolver and no APPROVED/REJECTED outcome is
 * recorded. Only an IN_PROGRESS case can be cancelled.
 */
export async function cancelEscalationCase(
  db: Executor,
  params: CancelEscalationCaseParams,
): Promise<boolean> {
  const result = await db.escalationCase.updateMany({
    where: {
      id: params.id,
      tenantId: params.tenantId,
      status: EscalationStatus.IN_PROGRESS,
    },
    data: {
      status: EscalationStatus.CANCELLED,
      resolutionNote: params.note,
      resolvedAt: params.now,
    },
  });
  return result.count > 0;
}

/** Worker SLA sweep — flips `slaBreached` for reporting/notification-escalation only; never relied on for correctness of the case itself (same "housekeeping, self-heals" posture as `expireDueHolds`). */
export async function findBreachedEscalationCases(
  db: Executor,
  now: Date,
): Promise<EscalationCase[]> {
  const rows = await db.escalationCase.findMany({
    where: {
      status: EscalationStatus.IN_PROGRESS,
      slaBreached: false,
      slaDueAt: { lt: now },
    },
  });
  return rows.map(toDomainEscalationCase);
}

export async function markEscalationCaseSlaBreached(db: Executor, id: string): Promise<void> {
  await db.escalationCase.updateMany({
    where: { id, slaBreached: false },
    data: { slaBreached: true },
  });
}
