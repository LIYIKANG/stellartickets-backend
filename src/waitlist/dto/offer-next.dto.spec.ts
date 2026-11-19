import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OfferNextDto } from './offer-next.dto';
import {
  MAX_WAITLIST_OFFER_COUNT,
  MAX_WAITLIST_OFFER_WINDOW_MS,
  MIN_WAITLIST_OFFER_WINDOW_MS,
} from '../waitlist.constants';

async function errorsFor(body: Record<string, unknown>) {
  const dto = plainToInstance(OfferNextDto, body);
  return (await validate(dto)).map((e) => e.property);
}

describe('OfferNextDto', () => {
  it('caps count at 100', () => {
    expect(MAX_WAITLIST_OFFER_COUNT).toBe(100);
  });

  it('accepts a count with no window', async () => {
    expect(await errorsFor({ count: 1 })).toEqual([]);
  });

  it('accepts the largest allowed count', async () => {
    expect(await errorsFor({ count: MAX_WAITLIST_OFFER_COUNT })).toEqual([]);
  });

  it('rejects a count above the cap', async () => {
    expect(await errorsFor({ count: MAX_WAITLIST_OFFER_COUNT + 1 })).toEqual([
      'count',
    ]);
  });

  it.each([0, -1, 1.5, '10', null, undefined])(
    'rejects count=%p',
    async (count) => {
      expect(await errorsFor({ count })).toEqual(['count']);
    },
  );

  it('accepts a window at either bound', async () => {
    expect(
      await errorsFor({ count: 1, windowMs: MIN_WAITLIST_OFFER_WINDOW_MS }),
    ).toEqual([]);
    expect(
      await errorsFor({ count: 1, windowMs: MAX_WAITLIST_OFFER_WINDOW_MS }),
    ).toEqual([]);
  });

  it('rejects a window outside the bounds', async () => {
    expect(
      await errorsFor({
        count: 1,
        windowMs: MIN_WAITLIST_OFFER_WINDOW_MS - 1,
      }),
    ).toEqual(['windowMs']);
    expect(
      await errorsFor({
        count: 1,
        windowMs: MAX_WAITLIST_OFFER_WINDOW_MS + 1,
      }),
    ).toEqual(['windowMs']);
  });
});
