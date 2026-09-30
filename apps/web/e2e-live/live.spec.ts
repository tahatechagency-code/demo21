import { expect, test, type Page } from '@playwright/test';

/**
 * Real browser, real deployed app, real Gemini. Assertions are deliberately about facts and
 * safety (what must and must never be said), not exact wording, because Gemini words some replies.
 */
const INTERNALS = /confidence|AI_UNCERTAIN|undefined|\[object|classif|routing|"intent"/i;

async function openChat(page: Page) {
  await page.goto('/concierge/chat');
  await expect(page.locator('#chat-input')).toBeVisible();
}

/** Sends one message and returns the concierge's newest reply text. */
async function say(page: Page, message: string): Promise<string> {
  const before = await page.locator('[aria-label="Conversation"] li').count();
  await page.locator('#chat-input').fill(message);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Sending…')).toHaveCount(0);
  // one bubble for us, one for the concierge
  await expect
    .poll(async () => page.locator('[aria-label="Conversation"] li').count(), { timeout: 90_000 })
    .toBeGreaterThanOrEqual(before + 2);
  await expect(page.getByLabel('The concierge is typing')).toHaveCount(0);
  const items = page.locator('[aria-label="Conversation"] li');
  await expect.poll(async () => (await items.last().innerText()).trim().length).toBeGreaterThan(0);
  const reply = (await items.last().innerText()).trim();
  expect(reply, 'no internal wording may reach the customer').not.toMatch(INTERNALS);
  return reply;
}

test.describe('deployed concierge chat (real browser + real Gemini)', () => {
  test('cancellation is handed to a person and never claimed as done', async ({ page }) => {
    await openChat(page);
    const reply = await say(page, 'Cancel my BMW booking');
    expect(reply).toMatch(/nothing has been cancelled/i);
    expect(reply.replace(/nothing has been cancelled/i, '')).not.toMatch(/cancelled/i);
  });

  test('a car price comes from the catalogue', async ({ page }) => {
    await openChat(page);
    const reply = await say(page, 'How much is the BMW X5 per day?');
    expect(reply).toMatch(/BMW X5 starts from AED [\d,]+ per day/);
  });

  test('"what cars do you have" lists the fleet', async ({ page }) => {
    await openChat(page);
    const reply = await say(page, 'what cars do you have?');
    expect(reply).toMatch(/We offer:/);
    expect(reply).toMatch(/Lamborghini/);
    expect(reply).toMatch(/Ferrari/);
  });

  test('a request for a person is honoured', async ({ page }) => {
    await openChat(page);
    const reply = await say(page, 'I want to talk to a real person');
    expect(reply).toMatch(/team/i);
  });

  test('unreadable text goes to a person instead of a guess', async ({ page }) => {
    await openChat(page);
    const reply = await say(page, 'asdf qwerty zzz');
    expect(reply).toMatch(/team/i);
  });

  test('a natural, typo-ridden booking is understood and stays on topic', async ({ page }) => {
    await openChat(page);
    const reply = await say(page, 'helo i wana rnt a lamborgini urus for 3 dayz');
    expect(reply).toMatch(/urus|lamborghini|dates|pick|when/i);
    expect(reply).not.toMatch(/member of our team|cancelled/i);
  });

  test('context carries: "the black one" after naming a model', async ({ page }) => {
    await openChat(page);
    await say(page, 'I want to rent the BMW X5');
    const reply = await say(page, 'the black one');
    // The car is settled (black X5), so the next question is about dates/place, never about the car.
    expect(reply).not.toMatch(
      /which (vehicle|car|colou?r)|black or white|member of our team|not a vehicle/i,
    );
  });

  test('"yes" after "book" is never read as a car name', async ({ page }) => {
    await openChat(page);
    await say(page, 'book');
    const reply = await say(page, 'yes');
    expect(reply).not.toMatch(/not a vehicle we currently offer/i);
    expect(reply).not.toMatch(/member of our team/i);
  });

  test('a photo request is answered honestly (only staff-uploaded photos are ever sent)', async ({
    page,
  }) => {
    await openChat(page);
    const reply = await say(page, 'show me a picture of the Ferrari Roma');
    expect(reply).toMatch(/photo|picture|here are/i);
  });

  test('multi-intent: price answered, cancellation handed over, delivery answered', async ({
    page,
  }) => {
    await openChat(page);
    const reply = await say(
      page,
      'How much is the Ferrari Roma, can I cancel my other booking and do you deliver to the airport?',
    );
    expect(reply).toMatch(/Ferrari Roma starts from AED/);
    expect(reply).toMatch(/nothing has been cancelled/i);
    expect(reply).toMatch(/Dubai Airport/);
  });

  // ---- Gemini as the conversational brain: real model, real facts, real browser --------------

  test('asked if it is a bot, it says it is the AI concierge and never denies it', async ({
    page,
  }) => {
    await openChat(page);
    const reply = await say(page, 'am I talking to a robot?');
    expect(reply).toMatch(/AI concierge|AI assistant|\bAI\b/);
    expect(reply).not.toMatch(/not a (?:robot|bot)|i(?:'m| am) (?:a )?human/i);
  });

  test('driver-age question is answered from the real policy (Ferrari needs 25)', async ({
    page,
  }) => {
    await openChat(page);
    const reply = await say(page, 'I am 22, can I rent a Ferrari?');
    expect(reply).toMatch(/25/);
    expect(reply).not.toMatch(/yes,? you (?:definitely )?can/i);
  });

  test('documents come from the real eligibility policy', async ({ page }) => {
    await openChat(page);
    const reply = await say(page, 'whats the deal with my papers');
    expect(reply).toMatch(/passport/i);
    expect(reply).toMatch(/licen[cs]e/i);
  });

  test('a business fact nobody configured is never invented: it asks the team', async ({
    page,
  }) => {
    await openChat(page);
    const reply = await say(page, 'what time are you open on friday?');
    expect(reply).toMatch(/not (?:sure|certain)|don't have|team/i);
    expect(reply).not.toMatch(/24\s?\/\s?7|open (?:daily|every day|all day)|from \d+ ?(?:am|pm)/i);
  });

  test('payment methods are not invented', async ({ page }) => {
    await openChat(page);
    const reply = await say(page, 'can I pay by card or cash?');
    expect(reply).toMatch(/not (?:sure|certain)|don't have|team/i);
    expect(reply).not.toMatch(/we (?:accept|take) (?:both )?(?:card|cash)/i);
  });

  test('thanks is answered warmly and does not call in a person', async ({ page }) => {
    await openChat(page);
    const reply = await say(page, 'thanks a lot, that helps');
    expect(reply).toMatch(/welcome|glad|happy|pleasure/i);
    expect(reply).not.toMatch(/member of our team|asked our team/i);
  });

  test('a message in Arabic is answered in Arabic', async ({ page }) => {
    await openChat(page);
    const reply = await say(page, 'مرحبا، أريد استئجار سيارة');
    expect(reply).toMatch(/[\u0600-\u06FF]/);
  });

  test('an angry customer waiting for a car is handed to a person straight away', async ({
    page,
  }) => {
    await openChat(page);
    const reply = await say(page, "this is ridiculous, I've been waiting an hour for my car!!");
    expect(reply).toMatch(/team/i);
    expect(reply).not.toMatch(/let me check|get back to you/i);
  });

  test('the conversation survives a reload and the page stays usable on a phone', async ({
    page,
  }) => {
    await openChat(page);
    await say(page, 'Hello, I need a car in Dubai');
    await page.reload();
    await expect(page.getByText('Hello, I need a car in Dubai')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflow, 'no horizontal scroll on a 390px phone').toBe(false);
    await page.screenshot({ path: 'e2e-live/last-chat.png', fullPage: true });
  });
});
