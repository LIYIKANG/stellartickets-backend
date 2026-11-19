import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { EventStatus, WaitlistEntryStatus } from '@prisma/client';
import { WaitlistService } from './waitlist.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { OrganizationsService } from '../organizations/organizations.service';
import {
  DEFAULT_WAITLIST_OFFER_WINDOW_MS,
  MAX_WAITLIST_OFFER_COUNT,
  MAX_WAITLIST_OFFER_WINDOW_MS,
  MIN_WAITLIST_OFFER_WINDOW_MS,
} from './waitlist.constants';

/** A sold-out, visible ticket type on a published event. */
function soldOutTicketType(
  overrides: Record<string, unknown> = {},
  event: Record<string, unknown> = {},
) {
  return {
    id: 'tt-1',
    quantityIssued: 10,
    quantityTotal: 10,
    isHidden: false,
    ...overrides,
    event: {
      organizationId: 'org-1',
      status: EventStatus.PUBLISHED,
      deletedAt: null,
      ...event,
    },
  };
}

describe('WaitlistService', () => {
  let service: WaitlistService;
  let prisma: {
    ticketType: { findUnique: jest.Mock };
    waitlistEntry: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
    };
  };
  let organizations: { assertMember: jest.Mock };

  beforeEach(() => {
    prisma = {
      ticketType: { findUnique: jest.fn() },
      waitlistEntry: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
    };
    organizations = { assertMember: jest.fn() };
    service = new WaitlistService(
      prisma as unknown as PrismaService,
      organizations as unknown as OrganizationsService,
    );
  });

  describe('join', () => {
    it('loads the ticket type together with its event', async () => {
      prisma.ticketType.findUnique.mockResolvedValue(null);

      await expect(service.join('user-1', 'tt-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.ticketType.findUnique).toHaveBeenCalledWith({
        where: { id: 'tt-1' },
        include: { event: true },
      });
    });

    it.each([
      ['a hidden ticket type', { isHidden: true }, {}],
      ['a draft event', {}, { status: EventStatus.DRAFT }],
      [
        'a soft-deleted event',
        {},
        { deletedAt: new Date('2026-10-01T00:00:00Z') },
      ],
    ])('reports %s as not found', async (_label, ticketType, event) => {
      prisma.ticketType.findUnique.mockResolvedValue(
        soldOutTicketType(ticketType, event),
      );

      await expect(service.join('user-1', 'tt-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.waitlistEntry.findUnique).not.toHaveBeenCalled();
      expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
      expect(prisma.waitlistEntry.update).not.toHaveBeenCalled();
    });

    it('rejects joining the waitlist of a cancelled event with 400', async () => {
      prisma.ticketType.findUnique.mockResolvedValue(
        soldOutTicketType({}, { status: EventStatus.CANCELLED }),
      );

      await expect(service.join('user-1', 'tt-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.waitlistEntry.findUnique).not.toHaveBeenCalled();
      expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
    });

    it('rejects joining a ticket type that still has capacity', async () => {
      prisma.ticketType.findUnique.mockResolvedValue(
        soldOutTicketType({ quantityIssued: 5 }),
      );

      await expect(service.join('user-1', 'tt-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
    });

    it('rejects a user already WAITING on the same ticket type', async () => {
      prisma.ticketType.findUnique.mockResolvedValue(soldOutTicketType());
      prisma.waitlistEntry.findUnique.mockResolvedValue({
        id: 'entry-1',
        status: WaitlistEntryStatus.WAITING,
      });

      await expect(service.join('user-1', 'tt-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('assigns fair FIFO position based on earlier WAITING entries', async () => {
      prisma.ticketType.findUnique.mockResolvedValue(soldOutTicketType());
      prisma.waitlistEntry.findUnique.mockResolvedValue(null);
      const createdAt = new Date('2026-01-01T00:00:00Z');
      prisma.waitlistEntry.create.mockResolvedValue({
        id: 'entry-2',
        ticketTypeId: 'tt-1',
        userId: 'user-1',
        createdAt,
      });
      prisma.waitlistEntry.count.mockResolvedValue(3);

      const result = await service.join('user-1', 'tt-1');

      expect(prisma.waitlistEntry.count).toHaveBeenCalledWith({
        where: {
          ticketTypeId: 'tt-1',
          status: WaitlistEntryStatus.WAITING,
          createdAt: { lt: createdAt },
        },
      });
      expect(result.position).toBe(4);
    });

    it('re-joins a previously CANCELLED entry instead of erroring', async () => {
      prisma.ticketType.findUnique.mockResolvedValue(soldOutTicketType());
      const createdAt = new Date();
      prisma.waitlistEntry.findUnique.mockResolvedValue({
        id: 'entry-1',
        status: WaitlistEntryStatus.CANCELLED,
        createdAt,
      });
      prisma.waitlistEntry.update.mockResolvedValue({
        id: 'entry-1',
        ticketTypeId: 'tt-1',
        status: WaitlistEntryStatus.WAITING,
        createdAt,
      });
      prisma.waitlistEntry.count.mockResolvedValue(0);

      await service.join('user-1', 'tt-1');

      expect(prisma.waitlistEntry.update).toHaveBeenCalledWith({
        where: { id: 'entry-1' },
        data: {
          status: WaitlistEntryStatus.WAITING,
          offeredAt: null,
          offerExpiresAt: null,
          createdAt: expect.any(Date) as Date,
        },
      });
    });

    it('sends a re-joining user to the back of the queue', async () => {
      const startedAt = Date.now();
      // The user first joined long ago, left, and three others joined since.
      const originalCreatedAt = new Date(startedAt - 60 * 60 * 1000);
      const othersWaitingSince = [
        new Date(startedAt - 30 * 60 * 1000),
        new Date(startedAt - 20 * 60 * 1000),
        new Date(startedAt - 10 * 60 * 1000),
      ];
      prisma.ticketType.findUnique.mockResolvedValue(soldOutTicketType());
      prisma.waitlistEntry.findUnique.mockResolvedValue({
        id: 'entry-1',
        ticketTypeId: 'tt-1',
        userId: 'user-1',
        status: WaitlistEntryStatus.CANCELLED,
        createdAt: originalCreatedAt,
      });
      // Behave like the database: the row keeps its stored values except for
      // the columns the update sets, and position counts rows queued earlier.
      prisma.waitlistEntry.update.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({
            id: 'entry-1',
            ticketTypeId: 'tt-1',
            userId: 'user-1',
            createdAt: originalCreatedAt,
            ...data,
          }),
      );
      prisma.waitlistEntry.count.mockImplementation(
        ({ where }: { where: { createdAt: { lt: Date } } }) =>
          Promise.resolve(
            othersWaitingSince.filter((d) => d < where.createdAt.lt).length,
          ),
      );

      const result = await service.join('user-1', 'tt-1');

      expect(result.entry.createdAt.getTime()).toBeGreaterThanOrEqual(
        startedAt,
      );
      expect(result.position).toBe(othersWaitingSince.length + 1);
    });
  });

  describe('leave', () => {
    it('throws when the user has no active waitlist entry', async () => {
      prisma.waitlistEntry.findUnique.mockResolvedValue(null);

      await expect(service.leave('user-1', 'tt-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('marks a WAITING entry CANCELLED', async () => {
      prisma.waitlistEntry.findUnique.mockResolvedValue({
        id: 'entry-1',
        status: WaitlistEntryStatus.WAITING,
      });

      await service.leave('user-1', 'tt-1');

      expect(prisma.waitlistEntry.update).toHaveBeenCalledWith({
        where: { id: 'entry-1' },
        data: { status: WaitlistEntryStatus.CANCELLED },
      });
    });
  });

  describe('offerNext', () => {
    it('offers entries strictly in FIFO (createdAt asc) order', async () => {
      prisma.ticketType.findUnique.mockResolvedValue({
        id: 'tt-1',
        event: { organizationId: 'org-1' },
      });
      prisma.waitlistEntry.findMany.mockResolvedValue([
        { id: 'entry-1' },
        { id: 'entry-2' },
      ]);

      await service.offerNext('organizer-1', 'tt-1', 2);

      expect(organizations.assertMember).toHaveBeenCalledWith(
        'org-1',
        'organizer-1',
      );
      expect(prisma.waitlistEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ticketTypeId: 'tt-1', status: WaitlistEntryStatus.WAITING },
          orderBy: { createdAt: 'asc' },
          take: 2,
        }),
      );
      expect(prisma.waitlistEntry.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['entry-1', 'entry-2'] } },
          data: expect.objectContaining({
            status: WaitlistEntryStatus.OFFERED,
          }) as object,
        }),
      );
    });

    it('offers a 24 hour window by default', async () => {
      prisma.ticketType.findUnique.mockResolvedValue({
        id: 'tt-1',
        event: { organizationId: 'org-1' },
      });
      prisma.waitlistEntry.findMany.mockResolvedValue([{ id: 'entry-1' }]);

      await service.offerNext('organizer-1', 'tt-1', 1);

      const [{ data }] = prisma.waitlistEntry.updateMany.mock.calls[0] as [
        { data: { offeredAt: Date; offerExpiresAt: Date } },
      ];
      expect(data.offerExpiresAt.getTime() - data.offeredAt.getTime()).toBe(
        DEFAULT_WAITLIST_OFFER_WINDOW_MS,
      );
    });

    it('accepts the largest allowed count', async () => {
      prisma.ticketType.findUnique.mockResolvedValue({
        id: 'tt-1',
        event: { organizationId: 'org-1' },
      });
      prisma.waitlistEntry.findMany.mockResolvedValue([]);

      await service.offerNext('organizer-1', 'tt-1', MAX_WAITLIST_OFFER_COUNT);

      expect(prisma.waitlistEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: MAX_WAITLIST_OFFER_COUNT }),
      );
    });

    it.each([MAX_WAITLIST_OFFER_COUNT + 1, 0, -1, 1.5, Number.NaN])(
      'rejects count=%p before touching the database',
      async (count) => {
        await expect(
          service.offerNext('organizer-1', 'tt-1', count),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(prisma.ticketType.findUnique).not.toHaveBeenCalled();
        expect(prisma.waitlistEntry.updateMany).not.toHaveBeenCalled();
      },
    );

    it.each([
      MIN_WAITLIST_OFFER_WINDOW_MS - 1,
      MAX_WAITLIST_OFFER_WINDOW_MS + 1,
      1.5,
    ])('rejects windowMs=%p', async (windowMs) => {
      await expect(
        service.offerNext('organizer-1', 'tt-1', 1, windowMs),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.waitlistEntry.updateMany).not.toHaveBeenCalled();
    });
  });
});
