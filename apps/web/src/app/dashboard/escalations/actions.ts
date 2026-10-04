'use server';

import { revalidatePath } from 'next/cache';
import { resolveEscalation } from '../../../lib/adminApi';

const MAX_NOTE_LENGTH = 1000;

/** The resolution note is optional in the form; the record always carries one. */
function noteFrom(formData: FormData, fallback: string): string {
  const typed = formData.get('note');
  const note = typeof typed === 'string' ? typed.trim() : '';
  return (note || fallback).slice(0, MAX_NOTE_LENGTH);
}

/** The person is done: the AI carries on with the customer from where the chat was escalated. */
export async function handBackToAiAction(
  escalationCaseId: string,
  formData: FormData,
): Promise<void> {
  await resolveEscalation(escalationCaseId, {
    resolution: 'APPROVED',
    resolutionNote: noteFrom(formData, 'Handed back to the AI by staff'),
  });
  revalidatePath('/dashboard/escalations');
}

/** The person closes the conversation; it ends as declined. */
export async function endChatAction(escalationCaseId: string, formData: FormData): Promise<void> {
  await resolveEscalation(escalationCaseId, {
    resolution: 'REJECTED',
    resolutionNote: noteFrom(formData, 'Chat ended by staff'),
  });
  revalidatePath('/dashboard/escalations');
}
