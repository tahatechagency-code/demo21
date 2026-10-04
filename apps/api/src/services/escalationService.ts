import {
  acquireJourneyLock,
  findEscalationCaseById,
  findJourneyById,
  findJourneyTransitions,
  listEscalationCases,
  PrismaAuditWriter,
  resolveEscalationCase,
  transitionJourney,
  type ListEscalationCasesParams,
  type PrismaClient,
} from '@ai-concierge/db';
import {
  AppError,
  EscalationResolution,
  EscalationStatus,
  JourneyState,
  type EscalationCase,
  type EscalationCaseListItem,
  type ResolveEscalationCaseInput,
  type TenantId,
} from '@ai-concierge/domain';
import { checkTransition } from '@ai-concierge/workflow';

export interface EscalationServiceDeps {
  prisma: PrismaClient;
}

/**
 * The human half of the Event/Workflow Engine — what a worker on the
 * dashboard's Escalation Queue actually does with a case journeyService.ts
 * created. Never decides anything itself: `resolveEscalation`'s APPROVED/
 * REJECTED distinction is the human's own call, recorded verbatim, never
 * inferred or overridden.
 */

export interface ListEscalationsInput {
  tenantId: TenantId;
  status?: ListEscalationCasesParams['status'];
  limit: number;
  offset: number;
}

export async function listEscalations(
  deps: EscalationServiceDeps,
  input: ListEscalationsInput,
): Promise<EscalationCaseListItem[]> {
  return listEscalationCases(deps.prisma, input);
}

export interface ResolveEscalationInput extends ResolveEscalationCaseInput {
  tenantId: TenantId;
  escalationCaseId: string;
  resolvedByUserId: string;
  requestId: string;
}

/**
 * Resolves the case, then resumes the journey — APPROVED returns it to
 * exactly the state it was escalated *from* (read off the case's own
 * `ESCALATED` `JourneyTransition` row, MASTER-PLAN.md's "resumable"
 * reading taken literally: continue where it left off, never skip ahead);
 * REJECTED moves it to DECLINED, the same terminal outcome an INELIGIBLE
 * or a rejected quote already reaches on its own. If the journey has since
 * moved on or ended some other way, the case still resolves — only the
 * (now moot) journey resume step is skipped, never an error the human
 * resolving the case needs to deal with.
 */
export async function resolveEscalation(
  deps: EscalationServiceDeps,
  input: ResolveEscalationInput,
): Promise<EscalationCase> {
  return deps.prisma.$transaction(async (tx) => {
    const escalationCase = await findEscalationCaseById(tx, input.tenantId, input.escalationCaseId);
    if (!escalationCase || escalationCase.status !== EscalationStatus.IN_PROGRESS) {
      throw new AppError('CONFLICT', 'Escalation case is not in progress, or does not exist');
    }

    const resolved = await resolveEscalationCase(tx, {
      tenantId: input.tenantId,
      id: input.escalationCaseId,
      resolvedByUserId: input.resolvedByUserId,
      resolution: input.resolution,
      resolutionNote: input.resolutionNote,
      now: new Date(),
    });
    if (!resolved) {
      throw new AppError('CONFLICT', 'Escalation case was resolved concurrently');
    }

    await new PrismaAuditWriter(tx).record({
      tenantId: input.tenantId,
      actor: `user:${input.resolvedByUserId}`,
      action: 'escalation.resolved',
      entityType: 'EscalationCase',
      entityId: resolved.id,
      after: { resolution: input.resolution, resolutionNote: input.resolutionNote },
      requestId: input.requestId,
    });

    const journey = await findJourneyById(tx, input.tenantId, escalationCase.journeyId);
    if (journey && journey.state === JourneyState.ESCALATED) {
      await acquireJourneyLock(tx, input.tenantId, journey.conversationId);
      const toState =
        input.resolution === EscalationResolution.APPROVED
          ? await resumeStateFor(tx, input.tenantId, journey.id)
          : JourneyState.DECLINED;
      if (
        toState &&
        checkTransition({ from: journey.state, to: toState, reason: input.resolution }).allowed
      ) {
        await transitionJourney(tx, {
          tenantId: input.tenantId,
          journeyId: journey.id,
          expectedVersion: journey.version,
          toState,
          context: journey.context,
          actor: 'HUMAN',
          reason: `Escalation resolved (${input.resolution}): ${input.resolutionNote}`,
        });
      }
    }

    return resolved;
  });
}

/** The state recorded on this journey's most recent transition *into* ESCALATED — where APPROVED resumes to. */
async function resumeStateFor(
  tx: Parameters<typeof findJourneyTransitions>[0],
  tenantId: TenantId,
  journeyId: string,
) {
  const transitions = await findJourneyTransitions(tx, tenantId, journeyId);
  const lastEscalation = [...transitions]
    .reverse()
    .find((t) => t.toState === JourneyState.ESCALATED);
  return lastEscalation?.fromState ?? null;
}
