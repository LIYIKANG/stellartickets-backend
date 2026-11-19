# Changelog

All notable changes to the backend API are documented here.
This project follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- Organization invitations: `POST /organizations/:id/invitations` (OWNER/ADMIN) invites an email address with an `ADMIN` or `STAFF` role, and `POST /organizations/invitations/accept` creates the `OrganizationMember`; invites expire after 7 days (`410` once expired)
- `GET /tickets/:ticketId` (owner or organization staff), `GET /tickets/:ticketId/qr` (PNG QR code, owner only) and `GET /tickets/:ticketId/qr-token` (short-lived signed QR token, configurable via `QR_TOKEN_TTL_SECONDS` / `QR_TOKEN_CLOCK_SKEW_SECONDS`) which `GET /tickets/verify/:value` also accepts
- Controller unit specs for events, tickets, organizations and users (route wiring, guards, DTO validation, error propagation) and an auth-flow e2e suite (register, login, `/users/me`)
- Auth (register/login, JWT)
- Organizations, events, ticket types
- Non-custodial ticket lifecycle: issue, purchase, transfer, check-in,
  revoke, resale marketplace
- Users module: profile, wallet connect, email lookup
- Shared `PaginationQueryDto` (`?page=&limit=`, default 20, max 100) and
  `Paginated<T>` response body (`items`, `total`, `page`, `limit`) with a
  `PaginatedResponseInterceptor`; see docs/API.md
- Weak ETags on GET responses; a matching `If-None-Match` returns `304`
- `TRUST_PROXY` env var for Express `trust proxy`; see docs/DEPLOYMENT.md
- `GET /organizations/:id/events` is paginated (`?page=`, `?limit=`) and returns
  `{ items, total, page, limit }`; shared `PaginationQueryDto`
- Cache abstraction with memory and Redis drivers (`CACHE_DRIVER`)
- Optional BullMQ queue for outbound webhooks (`WEBHOOK_QUEUE_ENABLED`, off by default)
- Scheduler module with a sample cron job (`SCHEDULER_ENABLED`)
- `WaitlistOfferExpiryJob`: every five minutes, waitlist offers past their
  `offerExpiresAt` become `EXPIRED` and the slot is offered to the next
  waiting entry; see docs/SCHEDULER.md

### Changed
- `POST /ticket-types/:ticketTypeId/waitlist/offer-next` accepts a `count` of
  at most 100 (was 500) and a `windowMs` of at most seven days; larger values
  return `400`
- `POST /ticket-types/:ticketTypeId/waitlist` returns `404` for a hidden ticket
  type or a draft or deleted event, and `400` for a cancelled event
- Re-joining a waitlist after leaving it now queues the user at the back
  instead of restoring their original position
- `GET /events` is paginated and returns `{ items, total, page, limit }`
  instead of a bare array
