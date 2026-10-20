# RouteMates

RouteMates is a React + TypeScript + Vite prototype for students and nearby hostel/PG residents coordinating a shared cab. The tagline is **“Same way. One ride.”**

It has two modes:

- With Supabase credentials, people can sign in, publish trips, discover eligible open trips, request a seat, and accept/decline through database functions.
- Without Supabase credentials, fictional trips and actions stay in browser-local demo state. Demo people are fictional and do not represent real users.

## Run locally

```sh
npm install
cp .env.example .env.local
npm run dev
```

Add the required settings below to `.env.local`, then restart Vite. `.env.local` was intentionally left untouched for this task. `.env` and `.env.*` files are ignored by Git except the placeholder-only `.env.example`.

## Environment variables

```dotenv
VITE_SUPABASE_URL=https://your-test-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-test-project-anon-or-publishable-key
VITE_GOOGLE_MAPS_API_KEY=your-browser-restricted-google-maps-key
```

`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` connect the browser client to Supabase. The anon/publishable key is public; Row Level Security must protect data. Never put a service-role key, database password, or secret in browser code or a `VITE_` variable.

`VITE_GOOGLE_MAPS_API_KEY` is optional. Without it, users can type locations manually; text-only matches are lower confidence and do not verify proximity. With the key, the app loads Google Maps JavaScript API and Places API (New) for autocomplete. Maps are only shown inside an accepted trip when a participant has opted in to location sharing.

For a Google key:

1. Enable Maps JavaScript API and Places API (New) in the Google Cloud project and configure billing.
2. Restrict the browser key by HTTP referrer to the local origin and the exact preview hostnames you use. Restrict API access to the two browser APIs above, set quotas/budget alerts, and do not use an unrestricted key.
3. Keep Google's autocomplete attribution visible. The app stores a Google Place ID and the user's own typed location text; provider names and coordinates are fetched into page memory for matching and are not written to RouteMates tables or browser storage.

Google recommends unique Places session tokens and browser-key restrictions; see [Place Autocomplete Data API](https://developers.google.com/maps/documentation/javascript/place-autocomplete-data), [Maps JavaScript API policies](https://developers.google.com/maps/documentation/javascript/policies), and [Maps Platform key security](https://developers.google.com/maps/api-security-best-practices).

## Supabase setup and migrations

1. Use the separate `routemates-test` Supabase project for testing. Enable Email Auth and sign-up. Set the Auth Site URL and allowed redirect URLs to the local origin, for example `http://localhost:5173`.
2. The existing base migration is `supabase/migrations/20261018000100_create_routemates_tables.sql`. The app's original Auth, trip, and request workflows expect it to be applied.
3. Review and apply the new additive migration manually, in order: `supabase/migrations/20261019000100_add_place_chat_location_sharing.sql`. It makes the legacy fare field nullable, adds place IDs, and creates chat/location-sharing tables, policies, and functions. This project never executes SQL automatically. Do not apply it to production for this prototype.
4. Do not use a service-role key in the frontend. Authenticated API access remains subject to RLS and narrowly granted database functions.

The new migration has **not** been executed or runtime-validated by this task. It must be reviewed and manually applied before the updated frontend can load new trip columns or use chat/location features. The test plan is `supabase/tests/SECURITY_TEST_PLAN.md`.

## Places and route matching

- Autocomplete uses the Google Places Autocomplete (New) JavaScript API, with an India region preference and Bengaluru location bias. Suggestions are debounced and use a fresh session token per search/select flow.
- The form stores the user's typed location label and the selected Google Place ID. Google place names/coordinates are resolved transiently in the current page session; no coordinate columns, localStorage, or sessionStorage cache is added.
- Matching compares endpoints independently. When both sides have coordinates, pickup must be within 3 km and destination within 5 km; a known distant coordinate pair always rejects even if the text is similar. Exact Place IDs are used when endpoint coordinates are unavailable. Normalized/fuzzy text is a lower-confidence fallback only for endpoints that lack both a coordinate pair and matching Place IDs. Direction is checked when all four route coordinates resolve. These are straight-line proximity thresholds, not road-route matching.
- Each Find shared rides search resolves at most 12 future trip candidates and may request up to 24 Google Place details for their endpoints (often fewer because results are de-duplicated in memory). These calls may incur Google Maps Platform charges. Configure project quotas and billing alerts, and avoid repeatedly searching while testing.
- Public Discover has no map. There is no road-route geometry or real route-overlap engine. Location points can only appear in an accepted trip after each participant separately opts in; this prototype flow still requires multi-device verification.

## Trip chat and location sharing

- Chat is available only to the trip host and accepted riders. Message identity/name is assigned from the authenticated user and profile. Message history remains readable after cancellation/completion; new messages stop when a trip becomes terminal.
- Location sharing is separately opt-in for each accepted participant. It requires browser permission and HTTPS (localhost is suitable for development). A database function checks the opt-in and trip state on every coordinate send. Coordinates are broadcast on a participant-scoped private Realtime channel and are not stored in RouteMates trip/message tables. The app stops the watcher on opt-out, sign-out, page cleanup, hidden page, and trip end, and server-side opt-in leases expire after 30 seconds without updates.
- Supabase Realtime Broadcast is transient but may retain event payloads for up to three days. Coordinate payloads contain precise location, so use fictional test accounts/devices and decide whether that retention is acceptable before enabling sharing.
- Private topic authorization should be tested with **Allow public access** disabled in Supabase Realtime settings. Sharing/chat must be verified with multiple sessions; the UI and SQL alone do not prove authorization behavior.

## Checks and two-account test

Run the local checks:

```sh
npm test
npm run build
npm run lint
```

`npm test` includes unit tests for date/time/seats validation and route text/coordinate matching plus static SQL contract checks. The SQL checks do not parse or execute PostgreSQL. They do not prove RLS behavior, Realtime authorization, locking, or concurrent acceptance.

After reviewing/applying the migration to `routemates-test`:

1. Open two separate browser profiles. Sign up Host A and Rider B with clearly fictional names.
2. As Host A, create a future trip with two seats and a clear manually typed route or selected Places IDs.
3. As Rider B, search the route. Try near, distant, reverse-direction, and text-only variants. Verify the match reason explains coordinate or lower-confidence text matching.
4. As Rider B, request a seat. As Host A, accept it and confirm one seat remains. Reopen the trip in both sessions and send messages; verify a third pending/unrelated account cannot read or send.
5. On both accepted-member devices, test location permission denial, opt-in, marker updates, and Stop Sharing. Test HTTPS preview or localhost. Try ending the trip while a share is active and verify it stops.
6. Repeat the existing seat-capacity race with two riders and one seat in separate host sessions. Exactly one acceptance should succeed. This race has not been runtime-tested by this task.
7. Remove all Supabase variables and restart Vite. Verify local fictional demo interactions remain available and the UI says demo mode. Restore credentials; a database failure must show an error rather than fake data.

## Prototype limitations

The Google Maps key, Supabase settings, new migration, chat and live-location flows need manual configuration and multi-account verification. This work did not deploy the app, execute SQL, connect to Supabase, or test live GPS on separate HTTPS devices. No road route matching, payments, cab booking, identity/student verification, or public production launch is included. Account deletion remains blocked when accepted-request history exists under the base schema.
