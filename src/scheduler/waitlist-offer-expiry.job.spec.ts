import { Logger } from '@nestjs/common';
import { WaitlistEntryStatus } from '@prisma/client';
import { WaitlistOfferExpiryJob } from './waitlist-offer-expiry.job';
import type { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_WAITLIST_OFFER_WINDOW_MS } from '../waitlist/waitlist.constants';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

function staleOffer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'offered-1',
    ticketTypeId: 'tt-1',
    offeredAt: new Date(NOW.getTime() - 3 * HOUR_MS),
    offerExpiresAt: new Date(NOW.getTime() - HOUR_MS),
    ...overrides,
  };
}

describe('WaitlistOfferExpiryJob', () => {
  let job: WaitlistOfferExpiryJob;
  let prisma: {
    waitlistEntry: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      updateMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      waitlistEntry: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(),
    };
    // Interactive transactions run the callback against the same mock client.
    prisma.$transaction.mockImplementation(
      (callback: (tx: typeof prisma) => unknown) => callback(prisma),
    );
    job = new WaitlistOfferExpiryJob(prisma as unknown as PrismaService);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('expireOnce', () => {
    it('only looks at OFFERED entries whose window has passed', async () => {
      const counts = await job.expireOnce(NOW);

      expect(prisma.waitlistEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: WaitlistEntryStatus.OFFERED,
            offerExpiresAt: { lte: NOW },
          },
          orderBy: { offerExpiresAt: 'asc' },
        }),
      );
      expect(prisma.waitlistEntry.updateMany).not.toHaveBeenCalled();
      expect(counts).toEqual({ expired: 0, reoffered: 0 });
    });

    it('expires a lapsed offer and offers its slot to the next WAITING entry', async () => {
      prisma.waitlistEntry.findMany.mockResolvedValue([staleOffer()]);
      prisma.waitlistEntry.findFirst.mockResolvedValue({ id: 'waiting-1' });

      const counts = await job.expireOnce(NOW);

      expect(prisma.waitlistEntry.updateMany).toHaveBeenNthCalledWith(1, {
        where: {
          id: 'offered-1',
          status: WaitlistEntryStatus.OFFERED,
          offerExpiresAt: { lte: NOW },
        },
        data: { status: WaitlistEntryStatus.EXPIRED },
      });
      expect(prisma.waitlistEntry.findFirst).toHaveBeenCalledWith({
        where: { ticketTypeId: 'tt-1', status: WaitlistEntryStatus.WAITING },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      // The lapsed offer ran for two hours, so its successor gets two hours.
      expect(prisma.waitlistEntry.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: 'waiting-1', status: WaitlistEntryStatus.WAITING },
        data: {
          status: WaitlistEntryStatus.OFFERED,
          offeredAt: NOW,
          offerExpiresAt: new Date(NOW.getTime() + 2 * HOUR_MS),
        },
      });
      expect(counts).toEqual({ expired: 1, reoffered: 1 });
    });

    it('expires and re-offers inside one transaction per offer', async () => {
      prisma.waitlistEntry.findMany.mockResolvedValue([
        staleOffer({ id: 'offered-1' }),
        staleOffer({ id: 'offered-2', ticketTypeId: 'tt-2' }),
      ]);
      prisma.waitlistEntry.findFirst.mockResolvedValue({ id: 'waiting-1' });

      const counts = await job.expireOnce(NOW);

      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(counts).toEqual({ expired: 2, reoffered: 2 });
    });

    it('falls back to the default window when the lapsed offer has no usable one', async () => {
      prisma.waitlistEntry.findMany.mockResolvedValue([
        staleOffer({ offeredAt: null }),
      ]);
      prisma.waitlistEntry.findFirst.mockResolvedValue({ id: 'waiting-1' });

      await job.expireOnce(NOW);

      expect(prisma.waitlistEntry.updateMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          data: expect.objectContaining({
            offerExpiresAt: new Date(
              NOW.getTime() + DEFAULT_WAITLIST_OFFER_WINDOW_MS,
            ),
          }) as object,
        }),
      );
    });

    it('expires the offer even when nobody is left waiting', async () => {
      prisma.waitlistEntry.findMany.mockResolvedValue([staleOffer()]);
      prisma.waitlistEntry.findFirst.mockResolvedValue(null);

      const counts = await job.expireOnce(NOW);

      expect(prisma.waitlistEntry.updateMany).toHaveBeenCalledTimes(1);
      expect(counts).toEqual({ expired: 1, reoffered: 0 });
    });

    it('leaves an offer alone when it converted after it was read', async () => {
      prisma.waitlistEntry.findMany.mockResolvedValue([staleOffer()]);
      prisma.waitlistEntry.updateMany.mockResolvedValue({ count: 0 });

      const counts = await job.expireOnce(NOW);

      expect(prisma.waitlistEntry.findFirst).not.toHaveBeenCalled();
      expect(prisma.waitlistEntry.updateMany).toHaveBeenCalledTimes(1);
      expect(counts).toEqual({ expired: 0, reoffered: 0 });
    });

    it('moves on to the following entry when the head of the queue was taken concurrently', async () => {
      prisma.waitlistEntry.findMany.mockResolvedValue([staleOffer()]);
      prisma.waitlistEntry.findFirst
        .mockResolvedValueOnce({ id: 'waiting-1' })
        .mockResolvedValueOnce({ id: 'waiting-2' });
      prisma.waitlistEntry.updateMany
        .mockResolvedValueOnce({ count: 1 }) // expire the lapsed offer
        .mockResolvedValueOnce({ count: 0 }) // waiting-1 is no longer WAITING
        .mockResolvedValueOnce({ count: 1 }); // waiting-2 takes the slot

      const counts = await job.expireOnce(NOW);

      expect(prisma.waitlistEntry.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: { id: 'waiting-2', status: WaitlistEntryStatus.WAITING },
        }),
      );
      expect(counts).toEqual({ expired: 1, reoffered: 1 });
    });

    it('does nothing on a second run once the offers are expired', async () => {
      prisma.waitlistEntry.findMany
        .mockResolvedValueOnce([staleOffer()])
        .mockResolvedValue([]);
      prisma.waitlistEntry.findFirst.mockResolvedValue({ id: 'waiting-1' });

      await job.expireOnce(NOW);
      prisma.waitlistEntry.updateMany.mockClear();
      const second = await job.expireOnce(NOW);

      expect(prisma.waitlistEntry.updateMany).not.toHaveBeenCalled();
      expect(second).toEqual({ expired: 0, reoffered: 0 });
    });

    it('keeps reading pages until a short page is returned', async () => {
      const fullPage = Array.from({ length: 100 }, (_, i) =>
        staleOffer({ id: `offered-${i}` }),
      );
      prisma.waitlistEntry.findMany
        .mockResolvedValueOnce(fullPage)
        .mockResolvedValueOnce([staleOffer({ id: 'offered-last' })]);

      const counts = await job.expireOnce(NOW);

      expect(prisma.waitlistEntry.findMany).toHaveBeenCalledTimes(2);
      expect(counts.expired).toBe(101);
    });

    it('stops when a full page expired nothing, instead of re-reading it forever', async () => {
      const fullPage = Array.from({ length: 100 }, (_, i) =>
        staleOffer({ id: `offered-${i}` }),
      );
      prisma.waitlistEntry.findMany.mockResolvedValue(fullPage);
      prisma.waitlistEntry.updateMany.mockResolvedValue({ count: 0 });

      const counts = await job.expireOnce(NOW);

      expect(prisma.waitlistEntry.findMany).toHaveBeenCalledTimes(1);
      expect(counts).toEqual({ expired: 0, reoffered: 0 });
    });
  });

  describe('run', () => {
    it('logs a failure instead of throwing out of the cron callback', async () => {
      prisma.waitlistEntry.findMany.mockRejectedValue(new Error('db down'));
      const error = jest.spyOn(Logger.prototype, 'error');

      await expect(job.run()).resolves.toBeUndefined();

      expect(error).toHaveBeenCalledWith(
        'Waitlist offer expiry failed: db down',
        expect.any(String),
      );
    });

    it('skips a tick while the previous run is still active', async () => {
      let release: (value: never[]) => void = () => undefined;
      prisma.waitlistEntry.findMany.mockReturnValue(
        new Promise<never[]>((resolve) => {
          release = resolve;
        }),
      );

      const first = job.run();
      await job.run();
      release([]);
      await first;

      expect(prisma.waitlistEntry.findMany).toHaveBeenCalledTimes(1);
    });

    it('runs again after a failed run', async () => {
      prisma.waitlistEntry.findMany
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValue([]);

      await job.run();
      await job.run();

      expect(prisma.waitlistEntry.findMany).toHaveBeenCalledTimes(2);
    });
  });
});
