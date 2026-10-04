import { PillButton } from '../../../components/ui/PillButton';
import { endChatAction, handBackToAiAction } from './actions';

/**
 * What a person does with a chat the AI could not handle: answer the customer (Open chat), then hand
 * the chat back to the AI, or end it. The chat stays In progress until one of those two is done — a
 * person who has not handed it back is still the one looking after it.
 */
export function EscalationActions({
  escalationCaseId,
  assignedToUserId,
  currentUserId,
}: {
  escalationCaseId: string;
  assignedToUserId: string | null;
  currentUserId: string;
}) {
  if (assignedToUserId !== null && assignedToUserId !== currentUserId) {
    return (
      <p className="mt-4 text-xs uppercase tracking-wide text-cream-50/50">
        Another staff member is handling this chat
      </p>
    );
  }

  return (
    <div className="mt-4 space-y-3 border-t border-white/10 pt-4">
      <form action={handBackToAiAction.bind(null, escalationCaseId)} className="space-y-3">
        <input
          name="note"
          maxLength={1000}
          placeholder="Note for the record (optional)"
          className="w-full rounded-2xl border border-white/10 bg-emerald-900/60 px-4 py-2 text-sm text-cream-50 placeholder:text-cream-50/40 focus:border-copper-300 focus:outline-none"
        />
        <div className="flex flex-wrap gap-3">
          <PillButton type="submit">Hand over to AI</PillButton>
          <PillButton
            type="submit"
            variant="outline"
            formAction={endChatAction.bind(null, escalationCaseId)}
          >
            End chat
          </PillButton>
        </div>
      </form>
      <p className="text-xs text-cream-50/50">
        Hand over to AI: the AI carries on with the customer from where the chat was escalated. End
        chat: the conversation is declined and closed.
      </p>
    </div>
  );
}
