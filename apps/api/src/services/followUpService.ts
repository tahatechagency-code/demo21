import { DEFAULT_REPLY_SUBJECT } from '@ai-concierge/channels';
import { CONTACT_TEAM_LABEL } from '@ai-concierge/ai';
import { createOutboundMessage, findLatestCollectedBookingInfo } from '@ai-concierge/db';
import {
  collectedBookingInfoSchema,
  JourneyState,
  TERMINAL_JOURNEY_STATES,
  type CollectedBookingInfo,
  type TenantId,
} from '@ai-concierge/domain';
import type { AppContext } from '../context.js';
import { dubaiHour } from '../lib/dubaiTime.js';

/**
 * The AI does not let a quiet customer drift away. When the concierge spoke last and the customer has
 * not answered, it checks in once after 3 minutes, again after 30 minutes, and a last time after a
 * week — each time with a short, suitable message that says what is still needed and offers a person
 * ("Contact my team"). A customer's reply starts the count again. Nothing here promises, confirms or
 * prices anything.
 *
 *   - Only while the AI owns the chat: a chat with a person (ESCALATED) or a finished one is left alone.
 *   - Only between 08:00 and 22:00 Dubai time; a nudge that falls due at night goes out in the morning.
 *   - WhatsApp only allows free-text messages within 24 hours of the customer's last message, so the
 *     one-week check-in is for the website chat and email.
 */

export const FollowUpStage = {
  AFTER_3_MINUTES: 'FOLLOWUP_3M',
  AFTER_30_MINUTES: 'FOLLOWUP_30M',
  AFTER_1_WEEK: 'FOLLOWUP_1W',
} as const;
export type FollowUpStageValue = (typeof FollowUpStage)[keyof typeof FollowUpStage];

const MINUTE_MS = 60_000;
/**
 * A check-in is only sent while it is still timely: at most `graceMs` after it fell due. That is long
 * enough to carry a night-time nudge over to the morning (22:00 -> 08:00), and short enough that a chat
 * that went quiet days ago — or one found when the system first starts — is never nudged late.
 */
const STEPS: readonly { stage: FollowUpStageValue; afterMs: number; graceMs: number }[] = [
  { stage: FollowUpStage.AFTER_3_MINUTES, afterMs: 3 * MINUTE_MS, graceMs: 12 * 60 * MINUTE_MS },
  { stage: FollowUpStage.AFTER_30_MINUTES, afterMs: 30 * MINUTE_MS, graceMs: 12 * 60 * MINUTE_MS },
  {
    stage: FollowUpStage.AFTER_1_WEEK,
    afterMs: 7 * 24 * 60 * MINUTE_MS,
    graceMs: 36 * 60 * MINUTE_MS,
  },
];

const WHATSAPP_FREE_TEXT_WINDOW_MS = 24 * 60 * MINUTE_MS;
/** The hours (Dubai time) a customer may be nudged: from 08:00 up to, not including, 22:00. */
const NUDGE_FROM_HOUR = 8;
const NUDGE_UNTIL_HOUR = 22;
/** Conversations whose last AI message is older than the last check-in's window are never read. */
const LOOKBACK_MS = STEPS[STEPS.length - 1]!.afterMs + STEPS[STEPS.length - 1]!.graceMs;
const MAX_CONVERSATIONS_PER_SWEEP = 300;

export interface FollowUpPlanInput {
  now: Date;
  channel: 'WHATSAPP' | 'WEB' | 'EMAIL';
  /** When the AI's last message went out. */
  anchorAt: Date;
  /** When the customer last wrote. */
  lastCustomerAt: Date;
  /** Follow-ups already sent since that AI message. */
  sentStages: ReadonlySet<string>;
}

/** The follow-up due right now, or `null`. If several are due (e.g. after downtime) only the latest is sent. */
export function planFollowUp(input: FollowUpPlanInput): FollowUpStageValue | null {
  const hour = dubaiHour(input.now);
  if (hour < NUDGE_FROM_HOUR || hour >= NUDGE_UNTIL_HOUR) return null;
  const elapsed = input.now.getTime() - input.anchorAt.getTime();
  const due = STEPS.filter(
    (step) =>
      !input.sentStages.has(step.stage) &&
      elapsed >= step.afterMs &&
      elapsed < step.afterMs + step.graceMs,
  );
  const latest = due[due.length - 1];
  if (!latest) return null;
  if (
    input.channel === 'WHATSAPP' &&
    input.now.getTime() - input.lastCustomerAt.getTime() >= WHATSAPP_FREE_TEXT_WINDOW_MS
  ) {
    return null;
  }
  return latest.stage;
}

function stillNeeded(collected: CollectedBookingInfo | null): string {
  if (!collected) return '';
  const missing = [
    collected.vehicle ? null : 'which car you would like',
    collected.pickupDate && collected.returnDate ? null : 'your pickup and return dates',
    collected.pickupLocation ? null : 'where you would like to pick it up',
  ].filter((entry): entry is string => entry !== null);
  if (missing.length === 0) return '';
  const last = missing.pop()!;
  return ` I still need ${missing.length > 0 ? `${missing.join(', ')} and ${last}` : last}.`;
}

export function buildFollowUpText(
  stage: FollowUpStageValue,
  collected: CollectedBookingInfo | null,
): string {
  const need = stillNeeded(collected);
  const team = `If you would rather speak to a person, reply "${CONTACT_TEAM_LABEL}" and a team member will join this chat.`;
  switch (stage) {
    case FollowUpStage.AFTER_3_MINUTES:
      return `Hello, are you still there? Reply whenever you are ready and I will carry on with your booking.${need} ${team}`;
    case FollowUpStage.AFTER_30_MINUTES:
      return `Just checking in again — your enquiry is still open.${need} Reply here at any time and I will pick up where we left off. ${team}`;
    case FollowUpStage.AFTER_1_WEEK:
      return `It has been a week since we last spoke, and your enquiry is still saved.${need} If you would still like to go ahead, just reply here. ${team}`;
  }
}

interface ConversationForFollowUp {
  id: string;
  channel: 'WHATSAPP' | 'WEB' | 'EMAIL';
  customerRef: string;
  journey: { state: string } | null;
  messages: { createdAt: Date }[];
  outboundMessages: { createdAt: Date; source: string; stage: string; status: string }[];
}

/** Where the AI last spoke to a customer who has not answered, and which follow-ups have gone out since. */
export function findFollowUpAnchor(
  conversation: ConversationForFollowUp,
): { anchorAt: Date; lastCustomerAt: Date; sentStages: Set<string> } | null {
  const lastCustomer = conversation.messages[0];
  if (!lastCustomer || !conversation.journey) return null;
  const state = conversation.journey.state;
  if (state === JourneyState.ESCALATED) return null;
  if ((TERMINAL_JOURNEY_STATES as readonly string[]).includes(state)) return null;

  const spoken = conversation.outboundMessages.filter((row) => row.status === 'SENT');
  const last = [...spoken].reverse().find((row) => !row.stage.startsWith('FOLLOWUP_'));
  if (!last || last.source === 'HUMAN' || last.createdAt <= lastCustomer.createdAt) return null;
  return {
    anchorAt: last.createdAt,
    lastCustomerAt: lastCustomer.createdAt,
    sentStages: new Set(
      conversation.outboundMessages
        .filter((row) => row.stage.startsWith('FOLLOWUP_') && row.createdAt > last.createdAt)
        .map((row) => row.stage),
    ),
  };
}

async function sendFollowUp(
  ctx: AppContext,
  tenantId: TenantId,
  conversation: ConversationForFollowUp,
  stage: FollowUpStageValue,
  text: string,
): Promise<'SENT' | 'FAILED' | 'SKIPPED'> {
  let status: 'SENT' | 'FAILED' | 'NOT_CONFIGURED';
  let deliveryError: string | null = null;
  if (conversation.channel === 'WEB') {
    // The customer's chat polls this conversation, so storing the message is delivering it.
    status = 'SENT';
  } else if (conversation.channel === 'WHATSAPP') {
    status = (await ctx.whatsappProvider.sendTextMessage(conversation.customerRef, text)).status;
  } else {
    const result = await ctx.emailProvider.sendEmail(
      conversation.customerRef,
      DEFAULT_REPLY_SUBJECT,
      text,
    );
    status = result.status;
    deliveryError = result.error ?? null;
  }
  if (status === 'NOT_CONFIGURED') return 'SKIPPED';
  await createOutboundMessage(ctx.prisma, {
    tenantId,
    conversationId: conversation.id,
    content: text,
    source: 'TEMPLATE',
    stage,
    status: status === 'SENT' ? 'SENT' : 'FAILED',
    deliveryError,
    ...(conversation.channel === 'EMAIL' ? { subject: DEFAULT_REPLY_SUBJECT } : {}),
  });
  return status === 'SENT' ? 'SENT' : 'FAILED';
}

/** One pass over the chats the AI spoke last in. Returns how many follow-ups went out. */
export async function runFollowUpSweep(ctx: AppContext, now: Date = new Date()): Promise<number> {
  const tenantId = ctx.config.DEFAULT_TENANT_ID;
  const since = new Date(now.getTime() - LOOKBACK_MS);
  const conversations = await ctx.prisma.conversation.findMany({
    where: {
      tenantId,
      outboundMessages: { some: { createdAt: { gte: since } } },
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_CONVERSATIONS_PER_SWEEP,
    select: {
      id: true,
      channel: true,
      customerRef: true,
      journey: { select: { state: true } },
      messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
      outboundMessages: {
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true, source: true, stage: true, status: true },
      },
    },
  });

  let sent = 0;
  for (const conversation of conversations) {
    const anchor = findFollowUpAnchor(conversation);
    if (!anchor) continue;
    const stage = planFollowUp({ now, channel: conversation.channel, ...anchor });
    if (!stage) continue;
    try {
      const raw = await findLatestCollectedBookingInfo(ctx.prisma, tenantId, conversation.id);
      const parsed = collectedBookingInfoSchema.safeParse(raw);
      const text = buildFollowUpText(stage, parsed.success ? parsed.data : null);
      const outcome = await sendFollowUp(ctx, tenantId, conversation, stage, text);
      if (outcome === 'SENT') sent += 1;
      ctx.logger.info(
        { conversationId: conversation.id, channel: conversation.channel, stage, outcome },
        'follow-up check-in',
      );
    } catch (error) {
      ctx.logger.error(
        { err: error, conversationId: conversation.id },
        'follow-up check-in failed',
      );
    }
  }
  return sent;
}

/** Starts the periodic sweep; returns a function that stops it. A missed tick is caught up by the next. */
export function startFollowUpSweep(ctx: AppContext, intervalMs: number): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runFollowUpSweep(ctx)
      .catch((error: unknown) => ctx.logger.error({ err: error }, 'follow-up sweep failed'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
