/** Most entries a single `offer-next` call may move to OFFERED. */
export const MAX_WAITLIST_OFFER_COUNT = 100;

/** Shortest purchase window an offer may carry (one minute). */
export const MIN_WAITLIST_OFFER_WINDOW_MS = 60_000;

/** Longest purchase window an offer may carry (seven days). */
export const MAX_WAITLIST_OFFER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Purchase window used when the caller does not choose one (24 hours). */
export const DEFAULT_WAITLIST_OFFER_WINDOW_MS = 24 * 60 * 60 * 1000;
