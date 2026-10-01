import { describe, expect, it } from 'vitest';
import { labelStaffMessage } from './staffReplyService.js';

describe('labelStaffMessage', () => {
  it("marks a person's WhatsApp message as the team's, in bold", () => {
    expect(labelStaffMessage('WHATSAPP', 'How can I help?')).toBe('*Team member*\nHow can I help?');
  });

  it("marks a person's email as the team's", () => {
    expect(labelStaffMessage('EMAIL', 'How can I help?')).toBe('Team member:\n\nHow can I help?');
  });

  it('leaves the website chat text alone — the chat draws its own highlighted label', () => {
    expect(labelStaffMessage('WEB', 'How can I help?')).toBe('How can I help?');
  });
});
