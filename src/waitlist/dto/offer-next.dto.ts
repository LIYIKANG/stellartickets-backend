import { IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  MAX_WAITLIST_OFFER_COUNT,
  MAX_WAITLIST_OFFER_WINDOW_MS,
  MIN_WAITLIST_OFFER_WINDOW_MS,
} from '../waitlist.constants';

export class OfferNextDto {
  @IsInt()
  @Min(1)
  @Max(MAX_WAITLIST_OFFER_COUNT)
  count!: number;

  /** Offer validity window in milliseconds. Defaults to 24h in the service. */
  @IsOptional()
  @IsInt()
  @Min(MIN_WAITLIST_OFFER_WINDOW_MS)
  @Max(MAX_WAITLIST_OFFER_WINDOW_MS)
  windowMs?: number;
}
