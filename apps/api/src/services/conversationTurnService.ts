import {
  createOutboundMessage,
  findMessagesForConversation,
  findOutboundMessagesForConversation,
  type Channel,
  type OutboundMessageSourceValue,
} from '@ai-concierge/db';
import {
  computeCollectedFingerprint,
  CustomerTimelineEventType,
  MissingInfoStatus,
  type Journey,
  type OutboundAttachment,
  type TenantId,
} from '@ai-concierge/domain';
import type { AppContext } from '../context.js';
import { resolvePiiKey } from '../lib/piiKey.js';
import { MAX_RECENT_TURNS_FOR_REPLY, type RecentTurn } from './conversationalReplyService.js';
import { syncCustomerFromJourney } from './crmService.js';
import {
  runFullEnquiryPipeline,
  type FullEnquiryPipelineResult,
} from './enquiryPipelineService.js';
import { advanceJourneyAutomatically } from './journeyAutopilotService.js';
import type { JourneyProgress } from './journeyProgress.js';
import { buildWhatsAppReplyText } from '@ai-concierge/channels';
import { generateJourneyReply, type JourneyReply } from './journeyReplyService.js';
import { notifyOpenCaseOfCustomerMessage, syncJourneyAfterMissingInfo } from './journeyService.js';
import { runConciergeEngine, type EngineOverride } from './concierge/engine.js';
import { buildPhotoReply } from './vehiclePhotoReplyService.js';

export interface InboundTurnInput {
  channel: Channel;
  /** The customer's identity on the channel (phone number, email address). */
  customerRef: string;
  /** The customer's message text. */
  body: string;
  requestId: string;
}

export interface InboundTurnResult {
  conversationId: string;
  reply: JourneyReply;
  progress: JourneyProgress;
  missingInfoStatus: string;
  /** Car photos to send with the reply (stored as ids; each channel turns them into what it can send). */
  attachments: OutboundAttachment[];
}

/**
 * One line per processed message: ids, intent, stage and the fields still
 * missing — everything needed to debug *why* a reply was sent, without ever
 * logging the message itself. `conversationId`/`messageId` are opaque ids and
 * each `missingFields` entry keeps only `field`/`reason` (never `detail`,
 * which can echo the customer's own text). `ctx.logger`'s redact paths are a
 * second, independent backstop.
 */
function logPipelineDecision(
  ctx: AppContext,
  channel: Channel,
  requestId: string,
  pipeline: FullEnquiryPipelineResult,
  progress: JourneyProgress,
): void {
  const intent = pipeline.enquiry.intent;
  const missingInfo = pipeline.missingInfo.missingInfo;
  ctx.logger.info(
    {
      requestId,
      channel,
      conversationId: pipeline.enquiry.conversationId,
      messageId: pipeline.enquiry.messageId,
      intentType: intent.intentType,
      intentStatus: intent.status,
      decisionEngine: intent.modelMetadata.engine,
      stage: missingInfo.status,
      journeyProgress: progress.stage,
      missingFields: missingInfo.missingFields.map((field) => ({
        field: field.field,
        reason: field.reason,
      })),
      promptInjectionDetected: missingInfo.flags.promptInjectionDetectedAnywhere,
    },
    'inbound pipeline decision',
  );
}

/** Both sides of the conversation, oldest first, capped to what the reply prompt needs. */
async function loadTurns(
  ctx: AppContext,
  tenantId: TenantId,
  conversationId: string,
): Promise<RecentTurn[]> {
  const [customerMessages, outboundMessages] = await Promise.all([
    findMessagesForConversation(ctx.prisma, tenantId, conversationId),
    findOutboundMessagesForConversation(
      ctx.prisma,
      tenantId,
      conversationId,
      MAX_RECENT_TURNS_FOR_REPLY,
    ),
  ]);
  return [
    ...customerMessages.map((row) => ({
      role: 'customer' as const,
      content: row.content,
      stage: undefined as string | undefined,
      at: row.createdAt.getTime(),
    })),
    ...outboundMessages.map((row) => ({
      role: 'assistant' as const,
      content: row.content,
      stage: row.stage as string | undefined,
      at: row.createdAt.getTime(),
    })),
  ]
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_RECENT_TURNS_FOR_REPLY)
    .map(({ role, content, stage }) => ({ role, content, ...(stage ? { stage } : {}) }));
}

/**
 * Everything that happens between "a customer message arrived" and "here is
 * the reply to send", identical for every channel: Steps 1-4, the persisted
 * journey and CRM sync, the automatic Steps 5-8 chain, and the reply itself.
 * Each channel webhook keeps only what is genuinely channel-specific —
 * signature verification, the idempotency claim, and the actual send.
 *
 * The journey/CRM sync is best-effort and caught locally, never allowed to
 * fail the turn: a failure there must not make the channel redeliver the
 * webhook and re-send a reply the customer already got.
 */
export async function handleInboundTurn(
  ctx: AppContext,
  input: InboundTurnInput,
): Promise<InboundTurnResult> {
  const tenantId = ctx.config.DEFAULT_TENANT_ID;

  const pipeline = await runFullEnquiryPipeline(
    {
      prisma: ctx.prisma,
      intentEngine: ctx.intentEngine,
      postEnquiryQueue: ctx.postEnquiryQueue,
      dateLocationOrchestrator: ctx.dateLocationOrchestrator,
      vehicleOrchestrator: ctx.vehicleOrchestrator,
      missingInfoOrchestrator: ctx.missingInfoOrchestrator,
    },
    {
      tenantId,
      channel: input.channel,
      customerRef: input.customerRef,
      message: input.body,
      requestId: input.requestId,
    },
  );
  const conversationId = pipeline.enquiry.conversationId;
  const missingInfo = pipeline.missingInfo.missingInfo;
  const sentBefore = await findMessagesForConversation(ctx.prisma, tenantId, conversationId);
  const normalise = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
  const repeatedMessage = sentBefore
    .slice(0, -1)
    .some((row) => normalise(row.content) === normalise(input.body));

  let journey: Journey | null = null;
  try {
    journey = await syncJourneyAfterMissingInfo(
      { prisma: ctx.prisma, notificationProvider: ctx.notificationProvider },
      {
        tenantId,
        conversationId,
        messageId: pipeline.enquiry.messageId,
        resolvedVehicleId: pipeline.vehicle.determination.resolvedVehicle?.id ?? null,
        missingInfoStatus: missingInfo.status,
        collectedFingerprint:
          missingInfo.status === MissingInfoStatus.NEEDS_INFO
            ? computeCollectedFingerprint(missingInfo.collected)
            : null,
        requestId: input.requestId,
        repeatedMessage,
      },
    );
    await syncCustomerFromJourney(
      { prisma: ctx.prisma },
      {
        tenantId,
        conversationId,
        journeyId: journey.id,
        eventType: CustomerTimelineEventType.JOURNEY_STARTED,
        eventSummary: `Journey started on ${input.channel} (${missingInfo.status})`,
        vehicleId: pipeline.vehicle.determination.resolvedVehicle?.id ?? null,
        quoteId: null,
        bookingCompleted: false,
      },
    );
  } catch (error) {
    ctx.logger.error({ err: error }, 'journey/CRM sync failed after inbound pipeline');
  }

  // The automatic Steps 5-8 chain. Without a journey (the sync above failed)
  // there is nothing to advance, so the customer just gets the Step 4 reply.
  const progress: JourneyProgress = journey
    ? await advanceJourneyAutomatically(
        {
          prisma: ctx.prisma,
          notificationProvider: ctx.notificationProvider,
          aiProvider: ctx.aiProvider,
          logger: ctx.logger,
          eligibilityOrchestrator: ctx.eligibilityOrchestrator,
          reservationLockService: ctx.reservationLockService,
          alternativeRecommendationOrchestrator: ctx.alternativeRecommendationOrchestrator,
          pricingRules: ctx.pricingRules,
          quoteValidator: ctx.quoteValidator,
          integritySecret: ctx.config.WEBHOOK_SIGNING_SECRET,
          piiKey: resolvePiiKey(ctx.config),
        },
        {
          tenantId,
          conversationId,
          requestId: input.requestId,
          journey,
          missingInfoStatus: missingInfo.status,
          collected: missingInfo.collected,
          customerMessage: input.body,
          intentType: pipeline.enquiry.intent.intentType,
        },
      )
    : { stage: 'STEP4_PENDING' };

  logPipelineDecision(ctx, input.channel, input.requestId, pipeline, progress);

  const turns = await loadTurns(ctx, tenantId, conversationId);
  const resolvedVehicleId = pipeline.vehicle.determination.resolvedVehicle?.id ?? null;

  // A person already owns this case: they are paged for every new customer message, so a reply in this
  // chat never waits to be noticed. The concierge keeps answering below — it is never muted.
  if (progress.stage === 'ESCALATED_WAITING') {
    try {
      await notifyOpenCaseOfCustomerMessage(
        { prisma: ctx.prisma, notificationProvider: ctx.notificationProvider },
        { tenantId, conversationId },
      );
    } catch (error) {
      ctx.logger.error({ err: error }, 'could not page the case owner about a new customer message');
    }
  }

  // The Conversation Engine: fleet-first rules -> Gemini -> options -> a person in the same chat.
  // `null` means the booking pipeline's own reply stands.
  let override: EngineOverride | null = null;
  try {
    override = await runConciergeEngine(ctx, {
      message: input.body,
      conversationId,
      requestId: input.requestId,
      progress,
      collected: missingInfo.collected,
      missingInfoStatus: missingInfo.status,
      resolvedVehicleId,
      turns,
    });
  } catch (error) {
    ctx.logger.error({ err: error }, 'concierge engine failed, using the booking pipeline reply');
  }
  if (override && !override.continuePipeline) {
    const overriddenProgress: JourneyProgress = override.escalated
      ? { stage: 'HUMAN_REVIEW', cause: 'CUSTOMER_REQUESTED', handoffRecorded: true }
      : progress;
    return {
      conversationId,
      reply: {
        text: override.text,
        source: 'DETERMINISTIC_FALLBACK',
        stage: override.stage,
      },
      progress: overriddenProgress,
      missingInfoStatus: missingInfo.status,
      attachments: override.attachments ?? [],
    };
  }

  // When the engine already answered the customer's question, the booking question that follows is the
  // fixed template: a free-text rewrite would see the question again and could answer it a second time,
  // with facts of its own.
  const afterAnswer = Boolean(override?.continuePipeline) && progress.stage === 'STEP4_PENDING';
  const reply = afterAnswer
    ? {
        text: buildWhatsAppReplyText(missingInfo),
        source: 'DETERMINISTIC_FALLBACK' as const,
        stage: progress.stage as string,
      }
    : await generateJourneyReply(
        { aiProvider: ctx.aiProvider, logger: ctx.logger },
        { progress, missingInfo, turns },
      );

  // A short fact in front of the booking reply ("delivery to the Marina is AED 100 ...").
  let replyText = override?.continuePipeline ? `${override.text}\n\n${reply.text}` : reply.text;
  let attachments: OutboundAttachment[] = [];
  // "Send me a photo of the Range Rover" mid-booking: attach the photos staff uploaded for it.
  try {
    const photoReply = await buildPhotoReply(
      { prisma: ctx.prisma },
      { tenantId, message: input.body, resolvedVehicleId },
    );
    if (photoReply) {
      replyText = `${photoReply.text}\n\n${replyText}`;
      attachments = photoReply.attachments;
    }
  } catch (error) {
    ctx.logger.error({ err: error }, 'could not build the car photo reply');
  }

  return {
    conversationId,
    reply: { ...reply, text: replyText },
    progress,
    missingInfoStatus: missingInfo.status,
    attachments,
  };
}

/**
 * Persists what the concierge actually told the customer. Called by the
 * channel webhook only after the message was really delivered — recording a
 * reply that never left (channel NOT_CONFIGURED, a send failure) would put
 * words in the conversation history the customer never saw.
 */
export async function recordOutboundReply(
  ctx: AppContext,
  input: {
    conversationId: string;
    text: string;
    source: OutboundMessageSourceValue;
    stage: string;
    attachments?: OutboundAttachment[];
  },
): Promise<void> {
  try {
    await createOutboundMessage(ctx.prisma, {
      tenantId: ctx.config.DEFAULT_TENANT_ID,
      conversationId: input.conversationId,
      content: input.text,
      source: input.source,
      stage: input.stage,
      ...(input.attachments && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
    });
  } catch (error) {
    ctx.logger.error({ err: error }, 'could not record the outbound reply');
  }
}

/**
 * The email-only counterpart to `recordOutboundReply`: a send the provider
 * actually rejected. Unlike a delivered reply, this *is* persisted — with
 * `status: 'FAILED'` — precisely so it is not lost: it becomes visible on
 * the dashboard and eligible for the resend sweep (`emailResendSweep.ts`)
 * or a staff-triggered resend (`emailResendService.ts`). Never used for
 * WhatsApp/Web: Meta's Cloud API already has its own delivery/retry
 * semantics, and web chat delivery is just storing the row, which cannot
 * fail the way an external HTTP call to Mailgun can.
 */
export async function recordFailedEmailReply(
  ctx: AppContext,
  input: {
    conversationId: string;
    text: string;
    source: OutboundMessageSourceValue;
    stage: string;
    authorUserId?: string | null;
    deliveryError: string | null;
    /** The subject actually used for this attempt — recovered on resend instead of falling back to a generic one. */
    subject: string;
  },
): Promise<void> {
  try {
    await createOutboundMessage(ctx.prisma, {
      tenantId: ctx.config.DEFAULT_TENANT_ID,
      conversationId: input.conversationId,
      content: input.text,
      source: input.source,
      stage: input.stage,
      authorUserId: input.authorUserId ?? null,
      subject: input.subject,
      status: 'FAILED',
      deliveryError: input.deliveryError,
    });
  } catch (error) {
    ctx.logger.error({ err: error }, 'could not record the failed email reply for later resend');
  }
}
