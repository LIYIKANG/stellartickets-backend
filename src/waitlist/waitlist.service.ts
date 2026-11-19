import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventStatus, WaitlistEntryStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationsService } from '../organizations/organizations.service';
import {
  DEFAULT_WAITLIST_OFFER_WINDOW_MS,
  MAX_WAITLIST_OFFER_COUNT,
  MAX_WAITLIST_OFFER_WINDOW_MS,
  MIN_WAITLIST_OFFER_WINDOW_MS,
} from './waitlist.constants';

@Injectable()
export class WaitlistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationsService,
  ) {}

  /**
   * Joins the waitlist for a sold-out ticket type. Ordering is fair: a row's
   * place in line is its rank by `createdAt` among still-WAITING entries, so
   * there is no separate counter to drift out of sync with insertion order.
   */
  async join(userId: string, ticketTypeId: string) {
    const ticketType = await this.prisma.ticketType.findUnique({
      where: { id: ticketTypeId },
      include: { event: true },
    });
    // A hidden type, or any type on a soft-deleted or unpublished event, is
    // not visible to attendees. It is reported exactly like a missing type so
    // the response does not confirm that it exists.
    if (!ticketType || ticketType.isHidden || ticketType.event.deletedAt) {
      throw new NotFoundException('Ticket type not found');
    }
    if (ticketType.event.status === EventStatus.CANCELLED) {
      throw new BadRequestException(
        'This event has been cancelled; its waitlist is closed',
      );
    }
    if (ticketType.event.status !== EventStatus.PUBLISHED) {
      throw new NotFoundException('Ticket type not found');
    }
    if (ticketType.quantityIssued < ticketType.quantityTotal) {
      throw new ConflictException(
        'This ticket type still has capacity; join the waitlist once it sells out',
      );
    }

    const existing = await this.prisma.waitlistEntry.findUnique({
      where: { ticketTypeId_userId: { ticketTypeId, userId } },
    });
    if (existing && existing.status === WaitlistEntryStatus.WAITING) {
      throw new ConflictException('You are already on this waitlist');
    }

    const entry = existing
      ? await this.prisma.waitlistEntry.update({
          where: { id: existing.id },
          data: {
            status: WaitlistEntryStatus.WAITING,
            offeredAt: null,
            offerExpiresAt: null,
            // Position is the rank by `createdAt` among WAITING entries, so a
            // returning user is re-stamped and queues behind everyone who is
            // already waiting instead of reclaiming their old spot.
            createdAt: new Date(),
          },
        })
      : await this.prisma.waitlistEntry.create({
          data: { ticketTypeId, userId },
        });

    return { entry, position: await this.positionOf(entry) };
  }

  async leave(userId: string, ticketTypeId: string) {
    const entry = await this.prisma.waitlistEntry.findUnique({
      where: { ticketTypeId_userId: { ticketTypeId, userId } },
    });
    if (!entry || entry.status !== WaitlistEntryStatus.WAITING) {
      throw new NotFoundException('You are not waiting on this ticket type');
    }
    return this.prisma.waitlistEntry.update({
      where: { id: entry.id },
      data: { status: WaitlistEntryStatus.CANCELLED },
    });
  }

  async myEntry(userId: string, ticketTypeId: string) {
    const entry = await this.prisma.waitlistEntry.findUnique({
      where: { ticketTypeId_userId: { ticketTypeId, userId } },
    });
    if (!entry || entry.status !== WaitlistEntryStatus.WAITING) {
      throw new NotFoundException('You are not waiting on this ticket type');
    }
    return { entry, position: await this.positionOf(entry) };
  }

  /** Organizer-only: the full, ordered queue for a ticket type. */
  async listForOrganizer(userId: string, ticketTypeId: string) {
    const ticketType = await this.prisma.ticketType.findUnique({
      where: { id: ticketTypeId },
      include: { event: true },
    });
    if (!ticketType) {
      throw new NotFoundException('Ticket type not found');
    }
    await this.organizations.assertMember(
      ticketType.event.organizationId,
      userId,
    );

    return this.prisma.waitlistEntry.findMany({
      where: { ticketTypeId, status: WaitlistEntryStatus.WAITING },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
  }

  /**
   * Offers the next `count` WAITING entries a purchase window. Called by
   * organizers (or a future capacity-freed hook) once inventory reopens --
   * e.g. a cancellation. Entries are offered strictly in FIFO order.
   */
  async offerNext(
    userId: string,
    ticketTypeId: string,
    count: number,
    windowMs = DEFAULT_WAITLIST_OFFER_WINDOW_MS,
  ) {
    // `OfferNextDto` enforces these limits for HTTP callers. They are repeated
    // here so an internal caller cannot offer an unbounded batch either.
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > MAX_WAITLIST_OFFER_COUNT
    ) {
      throw new BadRequestException(
        `count must be an integer from 1 to ${MAX_WAITLIST_OFFER_COUNT}`,
      );
    }
    if (
      !Number.isInteger(windowMs) ||
      windowMs < MIN_WAITLIST_OFFER_WINDOW_MS ||
      windowMs > MAX_WAITLIST_OFFER_WINDOW_MS
    ) {
      throw new BadRequestException(
        `windowMs must be an integer from ${MIN_WAITLIST_OFFER_WINDOW_MS} to ${MAX_WAITLIST_OFFER_WINDOW_MS}`,
      );
    }

    const ticketType = await this.prisma.ticketType.findUnique({
      where: { id: ticketTypeId },
      include: { event: true },
    });
    if (!ticketType) {
      throw new NotFoundException('Ticket type not found');
    }
    await this.organizations.assertMember(
      ticketType.event.organizationId,
      userId,
    );

    const next = await this.prisma.waitlistEntry.findMany({
      where: { ticketTypeId, status: WaitlistEntryStatus.WAITING },
      orderBy: { createdAt: 'asc' },
      take: count,
    });

    const now = new Date();
    const offerExpiresAt = new Date(now.getTime() + windowMs);
    await this.prisma.waitlistEntry.updateMany({
      where: { id: { in: next.map((e) => e.id) } },
      data: {
        status: WaitlistEntryStatus.OFFERED,
        offeredAt: now,
        offerExpiresAt,
      },
    });
    return next.map((e) => ({ ...e, status: WaitlistEntryStatus.OFFERED }));
  }

  /** Marks an OFFERED entry CONVERTED once the offered user actually buys. */
  async markConverted(ticketTypeId: string, userId: string) {
    await this.prisma.waitlistEntry.updateMany({
      where: {
        ticketTypeId,
        userId,
        status: WaitlistEntryStatus.OFFERED,
      },
      data: { status: WaitlistEntryStatus.CONVERTED },
    });
  }

  /** Position among still-WAITING entries, 1-indexed. */
  private async positionOf(entry: { ticketTypeId: string; createdAt: Date }) {
    const aheadCount = await this.prisma.waitlistEntry.count({
      where: {
        ticketTypeId: entry.ticketTypeId,
        status: WaitlistEntryStatus.WAITING,
        createdAt: { lt: entry.createdAt },
      },
    });
    return aheadCount + 1;
  }
}
