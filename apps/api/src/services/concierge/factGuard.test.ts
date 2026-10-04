import { describe, expect, it } from 'vitest';
import { keepsFacts, numbersOf } from './factGuard.js';

const NAMES = ['Lamborghini Urus', 'Dubai Marina', 'Jebel Ali'];
const DRAFT = 'Delivery to Dubai Marina is possible: AED 100, about 14 km from our Jebel Ali branch.';

describe('keepsFacts', () => {
  it('accepts a rewrite with the same numbers and names', () => {
    expect(keepsFacts(DRAFT, 'We can bring the car to Dubai Marina for AED 100, around 14 km from our Jebel Ali branch.', NAMES)).toBe(true);
  });

  it('refuses a changed or extra number', () => {
    expect(keepsFacts(DRAFT, 'We can bring the car to Dubai Marina for AED 120, about 14 km from Jebel Ali.', NAMES)).toBe(false);
    expect(keepsFacts(DRAFT, 'Delivery to Dubai Marina is AED 100, about 14 km from Jebel Ali, in 30 minutes.', NAMES)).toBe(false);
  });

  it('refuses a dropped number', () => {
    expect(keepsFacts(DRAFT, 'Delivery to Dubai Marina is possible and costs a small fee from Jebel Ali.', NAMES)).toBe(false);
  });

  it('refuses a rewrite that loses a place or car the draft names', () => {
    expect(keepsFacts(DRAFT, 'Yes, we can deliver there for AED 100, about 14 km from Jebel Ali.', NAMES)).toBe(false);
    expect(keepsFacts('The Lamborghini Urus is AED 3,500 a day.', 'The Urus is AED 3,500 a day.', NAMES)).toBe(false);
  });

  it('refuses a link that was not in the draft, and an invented essay', () => {
    expect(keepsFacts(DRAFT, `${DRAFT} See https://example.com`, NAMES)).toBe(false);
    expect(keepsFacts('Hello!', 'x'.repeat(400), NAMES)).toBe(false);
  });

  it('reads 1,800 and 1800 as the same number', () => {
    expect(numbersOf('AED 1,800')).toEqual(numbersOf('1800 dirhams'));
  });
});
