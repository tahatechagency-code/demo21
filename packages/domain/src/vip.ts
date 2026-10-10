/**
 * VIP booking: a customer who chooses it is looked after entirely by the senior team. The concierge offers it once,
 * with its first booking question; the web chat also offers it up front. Shared by the API and the web app so the
 * offer, the button and the dashboard's VIP section always agree.
 */

/** The highlighted line added (once per chat) to the concierge's first booking question. */
export const VIP_OFFER_TEXT =
  '⭐ VIP booking: would you like our senior team to arrange everything for you personally? Reply VIP.';

/** What the web chat's VIP button sends; the concierge reads it as a VIP request. */
export const VIP_REQUEST_TEXT = 'I would like a VIP booking';

/** The escalation detail of a VIP case; the dashboard's VIP section lists the cases that start with it. */
export const VIP_CASE_DETAIL = 'VIP customer';

/** True for an escalation case that belongs to the VIP section. */
export function isVipCaseDetail(detail: string): boolean {
  return detail.startsWith(VIP_CASE_DETAIL);
}
