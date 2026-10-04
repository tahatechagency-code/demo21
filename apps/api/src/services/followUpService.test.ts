import type { CollectedBookingInfo } from '@ai-concierge/domain';
import { describe, expect, it } from 'vitest';
import {
  buildFollowUpText,
  findFollowUpAnchor,
  FollowUpStage,
  planFollowUp,
  type FollowUpStageValue,
} from './followUpService.js';

/** 2026-10-01 at the given Dubai hour (Dubai is UTC+4). */
const dubai = (hour: number, minute = 0): Date => new Date(Date.UTC(2026, 9, 1, hour - 4, minute));
const minutesAfter = (date: Date, minutes: number): Date =>
  new Date(date.getTime() + minutes * 60_000);

describe('planFollowUp', () => {
  const anchorAt = dubai(12);
  const base = {
    channel: 'WEB' as const,
    anchorAt,
    lastCustomerAt: minutesAfter(anchorAt, -1),
    sentStages: new Set<string>(),
  };

  it('does nothing before 3 minutes', () => {
    expect(planFollowUp({ ...base, now: minutesAfter(anchorAt, 2) })).toBeNull();
  });

  it('checks in after 3 minutes, then after 30, then after a week — once each', () => {
    expect(planFollowUp({ ...base, now: minutesAfter(anchorAt, 3) })).toBe(
      FollowUpStage.AFTER_3_MINUTES,
    );
    expect(
      planFollowUp({
        ...base,
        now: minutesAfter(anchorAt, 10),
        sentStages: new Set([FollowUpStage.AFTER_3_MINUTES]),
      }),
    ).toBeNull();
    expect(
      planFollowUp({
        ...base,
        now: minutesAfter(anchorAt, 30),
        sentStages: new Set([FollowUpStage.AFTER_3_MINUTES]),
      }),
    ).toBe(FollowUpStage.AFTER_30_MINUTES);
    expect(
      planFollowUp({
        ...base,
        now: minutesAfter(anchorAt, 7 * 24 * 60),
        sentStages: new Set([FollowUpStage.AFTER_3_MINUTES, FollowUpStage.AFTER_30_MINUTES]),
      }),
    ).toBe(FollowUpStage.AFTER_1_WEEK);
  });

  it('never repeats a check-in that was already sent', () => {
    expect(
      planFollowUp({
        ...base,
        now: minutesAfter(anchorAt, 7 * 24 * 60 + 5),
        sentStages: new Set(Object.values(FollowUpStage)),
      }),
    ).toBeNull();
  });

  it('after downtime sends only the latest check-in that is due, not a burst', () => {
    expect(planFollowUp({ ...base, now: minutesAfter(anchorAt, 90) })).toBe(
      FollowUpStage.AFTER_30_MINUTES,
    );
  });

  it('once the 30-minute check-in went out, the 3-minute one is never sent after it', () => {
    expect(
      planFollowUp({
        ...base,
        now: minutesAfter(anchorAt, 31),
        sentStages: new Set([FollowUpStage.AFTER_30_MINUTES]),
      }),
    ).toBeNull();
  });

  it('never nudges a chat late: a check-in that fell due long ago is dropped', () => {
    // Quiet for two days: neither the 3-minute nor the 30-minute check-in is timely any more.
    expect(planFollowUp({ ...base, now: minutesAfter(anchorAt, 2 * 24 * 60) })).toBeNull();
    // The week check-in is dropped once its window has also passed.
    expect(
      planFollowUp({
        ...base,
        now: minutesAfter(anchorAt, 9 * 24 * 60),
        sentStages: new Set([FollowUpStage.AFTER_3_MINUTES, FollowUpStage.AFTER_30_MINUTES]),
      }),
    ).toBeNull();
  });

  it('holds a night-time check-in until 08:00 Dubai time', () => {
    const lateAnchor = dubai(21, 50);
    const late = { ...base, anchorAt: lateAnchor, lastCustomerAt: minutesAfter(lateAnchor, -1) };
    expect(planFollowUp({ ...late, now: dubai(21, 55) })).toBe(FollowUpStage.AFTER_3_MINUTES);
    expect(planFollowUp({ ...late, now: dubai(22, 5) })).toBeNull();
    expect(planFollowUp({ ...late, now: dubai(3, 0) })).toBeNull();
    expect(
      planFollowUp({
        ...late,
        now: new Date(dubai(8, 0).getTime() + 24 * 60 * 60_000),
        sentStages: new Set([FollowUpStage.AFTER_3_MINUTES]),
      }),
    ).toBe(FollowUpStage.AFTER_30_MINUTES);
  });

  it('does not use WhatsApp free text after its 24-hour window; web and email still get the week check-in', () => {
    const week = minutesAfter(anchorAt, 7 * 24 * 60);
    const sent = new Set<string>([FollowUpStage.AFTER_3_MINUTES, FollowUpStage.AFTER_30_MINUTES]);
    expect(planFollowUp({ ...base, channel: 'WHATSAPP', now: week, sentStages: sent })).toBeNull();
    expect(planFollowUp({ ...base, channel: 'EMAIL', now: week, sentStages: sent })).toBe(
      FollowUpStage.AFTER_1_WEEK,
    );
    expect(planFollowUp({ ...base, channel: 'WEB', now: week, sentStages: sent })).toBe(
      FollowUpStage.AFTER_1_WEEK,
    );
  });
});

describe('findFollowUpAnchor', () => {
  const customerAt = dubai(12);
  const reply = (
    minutes: number,
    over: Partial<{ source: string; stage: string; status: string }> = {},
  ) => ({
    createdAt: minutesAfter(customerAt, minutes),
    source: 'AI_GENERATED',
    stage: 'COLLECTING_MISSING_INFO',
    status: 'SENT',
    ...over,
  });
  const chat = (
    outboundMessages: ReturnType<typeof reply>[],
    state = 'COLLECTING_MISSING_INFO',
  ) => ({
    id: 'c1',
    channel: 'WEB' as const,
    customerRef: 'web:1',
    journey: { state },
    messages: [{ createdAt: customerAt }],
    outboundMessages,
  });

  it('anchors on the AI message the customer has not answered', () => {
    const anchor = findFollowUpAnchor(chat([reply(1)]));
    expect(anchor?.anchorAt).toEqual(minutesAfter(customerAt, 1));
    expect(anchor?.sentStages.size).toBe(0);
  });

  it('counts only the check-ins sent since that AI message', () => {
    const anchor = findFollowUpAnchor(
      chat([reply(1), reply(5, { stage: FollowUpStage.AFTER_3_MINUTES, source: 'TEMPLATE' })]),
    );
    expect([...anchor!.sentStages]).toEqual([FollowUpStage.AFTER_3_MINUTES]);
  });

  it('leaves a chat alone when a person spoke last', () => {
    expect(
      findFollowUpAnchor(chat([reply(1), reply(2, { source: 'HUMAN', stage: 'STAFF_REPLY' })])),
    ).toBeNull();
  });

  it('leaves a chat alone when the customer spoke last', () => {
    expect(findFollowUpAnchor(chat([reply(-5)]))).toBeNull();
  });

  it('leaves a chat with a person, and a finished chat, alone', () => {
    expect(findFollowUpAnchor(chat([reply(1)], 'ESCALATED'))).toBeNull();
    expect(findFollowUpAnchor(chat([reply(1)], 'CLOSED'))).toBeNull();
    expect(findFollowUpAnchor(chat([reply(1)], 'CANCELLED'))).toBeNull();
  });

  it('ignores a message that was never delivered', () => {
    expect(findFollowUpAnchor(chat([reply(1, { status: 'FAILED' })]))).toBeNull();
  });
});

describe('buildFollowUpText', () => {
  const missingEverything = {
    vehicle: null,
    pickupDate: null,
    returnDate: null,
    pickupLocation: null,
  } as unknown as CollectedBookingInfo;
  const stages: FollowUpStageValue[] = Object.values(FollowUpStage);

  it.each(stages)('offers a person and says what is still needed (%s)', (stage) => {
    const text = buildFollowUpText(stage, missingEverything);
    expect(text).toContain('Contact my team');
    expect(text).toContain('which car you would like');
    expect(text).toContain('your pickup and return dates');
  });

  it.each(stages)('never states a price, an availability or a confirmation (%s)', (stage) => {
    const text = buildFollowUpText(stage, null);
    expect(text).not.toMatch(/\$|\d/);
    expect(text).not.toMatch(/available|confirmed|booked|reserved/i);
  });

  it('asks for nothing when the booking has everything', () => {
    const complete = {
      vehicle: { make: 'Lamborghini', model: 'Urus', color: 'Yellow' },
      pickupDate: '2026-10-15',
      returnDate: '2026-10-19',
      pickupLocation: { normalized: 'dubai marina' },
    } as unknown as CollectedBookingInfo;
    expect(buildFollowUpText(FollowUpStage.AFTER_3_MINUTES, complete)).not.toContain(
      'I still need',
    );
  });
});
