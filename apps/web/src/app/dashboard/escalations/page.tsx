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
import { EscalationActions } from './EscalationActions';

/** There is no "All" and no "Open" lane: every chat the AI could not handle is In progress until a person hands it back. */
const STATUS_TABS: { label: string; value: EscalationStatusValue }[] = [
  { label: 'In progress', value: EscalationStatus.IN_PROGRESS },
  { label: 'Resolved', value: EscalationStatus.RESOLVED },
  { label: 'Cancelled', value: EscalationStatus.CANCELLED },
];

function parseStatus(raw: string | undefined): EscalationStatusValue {
  return STATUS_TABS.find((tab) => tab.value === raw)?.value ?? EscalationStatus.IN_PROGRESS;
}

function statusTone(status: EscalationStatusValue): 'success' | 'warning' | 'neutral' {
  if (status === EscalationStatus.IN_PROGRESS) return 'warning';
  if (status === EscalationStatus.RESOLVED) return 'success';
  return 'neutral';
}

/** A chat a person has already answered turns green, with a tick; one still waiting for a first reply stays plain. */
function cardTone(escalationCase: EscalationCaseListItem): string {
  return escalationCase.status === EscalationStatus.IN_PROGRESS && escalationCase.humanReplied
    ? 'border-success/60 bg-success/15'
    : 'border-white/10 bg-emerald-700/55';
}

export const metadata = { title: 'Escalations · AI Concierge' };

export default async function EscalationsPage({
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
    items = (await fetchEscalations({ status, limit: 50, offset: 0 })).items;
  } catch (error) {
    if (error instanceof SessionExpiredError) redirect('/login');
    throw error;
  }

  return (
    <div className="mx-auto max-w-3xl py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-lg uppercase tracking-[0.14em] text-cream-50">
            Escalation queue
          </h1>
          <p className="mt-2 text-sm text-cream-50/70">
            Chats the AI could not understand. Open the chat, answer the customer, and hand it back
            to the AI when you are done — until then it stays here.
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
                ? '/dashboard/escalations'
                : `/dashboard/escalations?status=${tab.value}`
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
                ? 'No chats are waiting for a person.'
                : 'Nothing here yet.'}
            </p>
          </GlassCard>
        )}

        {items.map((escalationCase) => (
          <div
            key={escalationCase.id}
            data-testid="escalation-case"
            data-human-replied={escalationCase.humanReplied}
            className={`rounded-card border p-5 shadow-[0_14px_34px_rgba(0,0,0,0.38)] backdrop-blur-sm transition-colors duration-200 ${cardTone(escalationCase)}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip tone="neutral">{escalationCase.tier}</StatusChip>
              <StatusChip tone={statusTone(escalationCase.status)}>
                {formatEnumLabel(escalationCase.status)}
              </StatusChip>
              {escalationCase.status === EscalationStatus.IN_PROGRESS &&
                escalationCase.humanReplied && (
                  <StatusChip tone="success">✓ Team replied</StatusChip>
                )}
              {escalationCase.slaBreached &&
                escalationCase.status === EscalationStatus.IN_PROGRESS && (
                  <StatusChip tone="danger">SLA breached</StatusChip>
                )}
              <span className="ml-auto text-xs text-cream-50/50">
                {formatDateTime(escalationCase.createdAt)}
              </span>
            </div>

            <h2 className="mt-3 text-sm font-medium text-cream-50">
              {formatEnumLabel(escalationCase.reason)}
            </h2>
            <p className="mt-1 text-sm text-cream-50/70">{escalationCase.detail}</p>
            <p className="mt-2 text-xs text-cream-50/50">
              {formatEnumLabel(escalationCase.channel)} · {escalationCase.customerRef}
            </p>

            <Link
              href={`/dashboard/journeys/${escalationCase.conversationId}`}
              className="mt-4 inline-flex items-center justify-center rounded-pill border border-copper-300 px-5 py-2 text-sm font-medium tracking-wide text-copper-100 transition-colors duration-150 hover:bg-emerald-700/40"
            >
              Open chat
            </Link>

            {escalationCase.status !== EscalationStatus.IN_PROGRESS && (
              <div className="mt-3 rounded-2xl border border-white/10 bg-emerald-900/40 p-3 text-sm">
                {escalationCase.resolution && (
                  <p className="text-cream-50">{formatEnumLabel(escalationCase.resolution)}</p>
                )}
                {escalationCase.resolutionNote && (
                  <p className="mt-1 text-cream-50/70">{escalationCase.resolutionNote}</p>
                )}
                {escalationCase.resolvedAt && (
                  <p className="mt-1 text-xs text-cream-50/40">
                    {formatDateTime(escalationCase.resolvedAt)}
                  </p>
                )}
              </div>
            )}

            {escalationCase.status === EscalationStatus.IN_PROGRESS && (
              <EscalationActions
                escalationCaseId={escalationCase.id}
                assignedToUserId={escalationCase.assignedToUserId}
                currentUserId={user.id}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
