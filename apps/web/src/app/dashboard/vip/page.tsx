import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  EscalationStatus,
  type EscalationCaseListItem,
  type EscalationStatusValue,
} from '@ai-concierge/domain';
import { fetchEscalations, SessionExpiredError } from '../../../lib/adminApi';
import { AutoRefresh } from '../../../components/dashboard/AutoRefresh';
import { getCurrentUser } from '../../../lib/getCurrentUser';
import { GlassCard } from '../../../components/ui/GlassCard';
import { StatusChip } from '../../../components/ui/StatusChip';
import { formatDateTime, formatEnumLabel } from '../../../lib/format';
import { EscalationActions } from '../escalations/EscalationActions';

const STATUS_TABS: { label: string; value: EscalationStatusValue }[] = [
  { label: 'Open', value: EscalationStatus.IN_PROGRESS },
  { label: 'Done', value: EscalationStatus.RESOLVED },
  { label: 'Cancelled', value: EscalationStatus.CANCELLED },
];

function parseStatus(raw: string | undefined): EscalationStatusValue {
  return STATUS_TABS.find((tab) => tab.value === raw)?.value ?? EscalationStatus.IN_PROGRESS;
}

/** A VIP chat the team has already answered turns green; one still waiting for its first reply glows copper. */
function cardTone(vip: EscalationCaseListItem): string {
  if (vip.status !== EscalationStatus.IN_PROGRESS) return 'border-white/10 bg-emerald-700/55';
  return vip.humanReplied
    ? 'border-success/60 bg-success/15'
    : 'border-copper-300 bg-copper-500/15 shadow-[0_0_26px_rgba(224,150,90,0.35)]';
}

export const metadata = { title: 'VIP bookings · AI Concierge' };

/**
 * VIP bookings: customers who chose a VIP booking on WhatsApp or the web chat. The senior team handles each one
 * fully in the same chat — the concierge stays quiet in it — and hands it back or closes it from here when done.
 */
export default async function VipBookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status: rawStatus } = await searchParams;
  const status = parseStatus(rawStatus);
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  let items: EscalationCaseListItem[];
  try {
    items = (await fetchEscalations({ status, kind: 'vip', limit: 50, offset: 0 })).items;
  } catch (error) {
    if (error instanceof SessionExpiredError) redirect('/login');
    throw error;
  }

  return (
    <div className="mx-auto max-w-3xl py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-lg uppercase tracking-[0.14em] text-copper-100">
            ⭐ VIP bookings
          </h1>
          <p className="mt-2 text-sm text-cream-50/70">
            Customers who chose a VIP booking. Your team handles each one fully: open the chat,
            arrange the car, delivery and paperwork with the customer, and close it here when done.
            The AI stays quiet in these chats.
          </p>
        </div>
        <AutoRefresh />
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        {STATUS_TABS.map((tab) => (
          <Link
            key={tab.value}
            href={
              tab.value === EscalationStatus.IN_PROGRESS
                ? '/dashboard/vip'
                : `/dashboard/vip?status=${tab.value}`
            }
            className={`rounded-pill px-4 py-2 text-xs font-medium uppercase tracking-wide transition-colors duration-150 ${
              status === tab.value
                ? 'bg-copper-gradient text-ink-900'
                : 'border border-white/10 text-cream-50/70 hover:bg-emerald-700/40'
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      <div className="mt-6 space-y-4">
        {items.length === 0 && (
          <GlassCard>
            <p className="text-sm text-cream-50/70">
              {status === EscalationStatus.IN_PROGRESS
                ? 'No VIP bookings are waiting.'
                : 'Nothing here yet.'}
            </p>
          </GlassCard>
        )}

        {items.map((vip) => (
          <div
            key={vip.id}
            data-testid="vip-case"
            data-human-replied={vip.humanReplied}
            className={`rounded-card border p-5 shadow-[0_14px_34px_rgba(0,0,0,0.38)] backdrop-blur-sm transition-colors duration-200 ${cardTone(vip)}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip tone="warning">⭐ VIP</StatusChip>
              <StatusChip tone="neutral">{formatEnumLabel(vip.channel)}</StatusChip>
              {vip.status === EscalationStatus.IN_PROGRESS && vip.humanReplied && (
                <StatusChip tone="success">✓ Team replied</StatusChip>
              )}
              {vip.status === EscalationStatus.IN_PROGRESS && !vip.humanReplied && (
                <StatusChip tone="danger">Waiting for the team</StatusChip>
              )}
              {vip.slaBreached && vip.status === EscalationStatus.IN_PROGRESS && (
                <StatusChip tone="danger">SLA breached</StatusChip>
              )}
              <span className="ml-auto text-xs text-cream-50/50">
                {formatDateTime(vip.createdAt)}
              </span>
            </div>

            <p className="mt-3 text-sm text-cream-50">{vip.customerRef}</p>
            {vip.detail !== 'VIP customer' && (
              <p className="mt-1 text-xs text-cream-50/60">{vip.detail}</p>
            )}

            <Link
              href={`/dashboard/journeys/${vip.conversationId}`}
              className="mt-4 inline-flex items-center justify-center rounded-pill bg-copper-gradient px-5 py-2 text-sm font-semibold tracking-wide text-ink-900"
            >
              Open chat
            </Link>

            {vip.status !== EscalationStatus.IN_PROGRESS && (
              <div className="mt-3 rounded-2xl border border-white/10 bg-emerald-900/40 p-3 text-sm">
                {vip.resolution && (
                  <p className="text-cream-50">{formatEnumLabel(vip.resolution)}</p>
                )}
                {vip.resolutionNote && (
                  <p className="mt-1 text-cream-50/70">{vip.resolutionNote}</p>
                )}
                {vip.resolvedAt && (
                  <p className="mt-1 text-xs text-cream-50/40">{formatDateTime(vip.resolvedAt)}</p>
                )}
              </div>
            )}

            {vip.status === EscalationStatus.IN_PROGRESS && (
              <EscalationActions
                escalationCaseId={vip.id}
                assignedToUserId={vip.assignedToUserId}
                currentUserId={user.id}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
