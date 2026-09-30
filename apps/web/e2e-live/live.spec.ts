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
  const items = page.locator('[aria-label="Conversation"] li');
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
    expect(reply).toMatch(/member of our team/i);
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
    expect(reply).not.toMatch(/which (vehicle|car|colou?r)|black or white|member of our team|not a vehicle/i);
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
