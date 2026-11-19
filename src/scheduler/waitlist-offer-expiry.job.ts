import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WaitlistEntryStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_WAITLIST_OFFER_WINDOW_MS } from '../waitlist/waitlist.constants';

export const WAITLIST_OFFER_EXPIRY_JOB_NAME = 'waitlist-offer-expiry';
const EXPIRY_PAGE_SIZE = 100;

export interface WaitlistOfferExpiryCounts {
  /** Offers moved from OFFERED to EXPIRED. */
  expired: number;
  /** Freed slots handed to the next WAITING entry. */
  reoffered: number;
}

interface StaleOffer {
  id: string;
  ticketTypeId: string;
  offeredAt: Date | null;
  offerExpiresAt: Date | null;
}

/**
 * The window the lapsed offer was given, reused for the entry that inherits
 * its slot so an organizer's chosen window survives the roll-forward.
 */
function offerWindowMs(offer: StaleOffer): number {
  if (offer.offeredAt && offer.offerExpiresAt) {
    const windowMs = offer.offerExpiresAt.getTime() - offer.offeredAt.getTime();
    if (windowMs > 0) {
      return windowMs;
    }
  }
  return DEFAULT_WAITLIST_OFFER_WINDOW_MS;
}

/**
 * Expires waitlist offers whose purchase window has passed and offers each
 * freed slot to the next person in line, so an unanswered offer no longer
 * blocks the queue forever.
 */
@Injectable()
export class WaitlistOfferExpiryJob {
  private readonly logger = new Logger(WaitlistOfferExpiryJob.name);
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_5_MINUTES, {
    name: WAITLIST_OFFER_EXPIRY_JOB_NAME,
  })
  async run(): Promise<void> {
    if (this.running) {
      this.logger.warn(
        'Skipping waitlist offer expiry; previous run is still active',
      );
      return;
    }

    this.running = true;
    try {
      const counts = await this.expireOnce();
      if (counts.expired > 0) {
        this.logger.log(
          `Waitlist offer expiry complete: expired=${counts.expired}, reoffered=${counts.reoffered}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Waitlist offer expiry failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
    } finally {
      this.running = false;
    }
  }

  async expireOnce(now: Date = new Date()): Promise<WaitlistOfferExpiryCounts> {
    const counts: WaitlistOfferExpiryCounts = { expired: 0, reoffered: 0 };

    while (true) {
      const stale: StaleOffer[] = await this.prisma.waitlistEntry.findMany({
        where: {
          status: WaitlistEntryStatus.OFFERED,
          offerExpiresAt: { lte: now },
        },
        select: {
          id: true,
          ticketTypeId: true,
          offeredAt: true,
          offerExpiresAt: true,
        },
        orderBy: { offerExpiresAt: 'asc' },
        take: EXPIRY_PAGE_SIZE,
      });
      if (stale.length === 0) {
        break;
      }

      let expiredInPage = 0;
      for (const offer of stale) {
        const result = await this.prisma.$transaction((tx) =>
          this.rollForward(tx, offer, now),
        );
        if (result.expired) {
          expiredInPage++;
          counts.expired++;
        }
        if (result.reoffered) {
          counts.reoffered++;
        }
      }

      // A short page was the last one. A full page that expired nothing means
      // every row was handled concurrently; stop rather than re-read it.
      if (stale.length < EXPIRY_PAGE_SIZE || expiredInPage === 0) {
        break;
      }
    }

    return counts;
  }

  /**
   * Expires one offer and hands its slot on, atomically. Both writes are
   * conditional on the row still being in the state that was read, so an
   * entry that converted in the meantime is left alone and an overlapping run
   * on another instance matches nothing instead of offering the slot twice.
   */
  private async rollForward(
    tx: Prisma.TransactionClient,
    offer: StaleOffer,
    now: Date,
  ): Promise<{ expired: boolean; reoffered: boolean }> {
    const expired = await tx.waitlistEntry.updateMany({
      where: {
        id: offer.id,
        status: WaitlistEntryStatus.OFFERED,
        offerExpiresAt: { lte: now },
      },
      data: { status: WaitlistEntryStatus.EXPIRED },
    });
    if (expired.count === 0) {
      return { expired: false, reoffered: false };
    }

    const offerExpiresAt = new Date(now.getTime() + offerWindowMs(offer));
    while (true) {
      const next = await tx.waitlistEntry.findFirst({
        where: {
          ticketTypeId: offer.ticketTypeId,
          status: WaitlistEntryStatus.WAITING,
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (!next) {
        return { expired: true, reoffered: false };
      }

      const offered = await tx.waitlistEntry.updateMany({
        where: { id: next.id, status: WaitlistEntryStatus.WAITING },
        data: {
          status: WaitlistEntryStatus.OFFERED,
          offeredAt: now,
          offerExpiresAt,
        },
      });
      if (offered.count > 0) {
        return { expired: true, reoffered: true };
      }
      // That entry left or was offered by someone else between the read and
      // the write; it is no longer WAITING, so the next read returns a
      // different head of the queue.
    }
  }
}
