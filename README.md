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
2. The base migration is `supabase/migrations/20261018000100_create_routemates_tables.sql`. The app's original Auth, trip, and request workflows expect it to be applied.
3. Review and apply the additive migrations manually, in order: `supabase/migrations/20261019000100_add_place_chat_location_sharing.sql`, `supabase/migrations/20261021000100_expire_location_share_state.sql`, then `supabase/migrations/20261022000100_ephemeral_location_relay.sql`. The newest migration revokes the old coordinate RPC, blocks direct browser Broadcast writes, replaces share lifecycle functions, and adds server-only authorization plus scheduled cleanup. It clears existing ephemeral share rows but does not rewrite old Realtime message partitions.
4. Deploy `supabase/functions/share-trip-location/` to the same TEST project after reviewing its source. `supabase/config.toml` keeps JWT verification enabled. The Edge runtime must provide the platform variables `SUPABASE_URL` and `SUPABASE_SECRET_KEYS`; the latter is server-only and must never be copied into Vite variables or browser code. `@supabase/server` reads the Supabase-injected keys. No service-role/secret key belongs in `.env.local`, Vercel frontend variables, or Git.
5. Enable Supabase Cron (`pg_cron`) in Integrations > Cron, then add a recurring every-minute job with this command:

   ```sql
   select public.cleanup_trip_location_shares();
   ```

   Use job name `routemates-location-share-cleanup` and schedule `* * * * *`. This scheduling step is manual; until it is configured, expired state is rejected by the relay but its non-coordinate metadata may remain in the share table.

   SQL Editor alternative after enabling the extension (review and run manually):

   ```sql
   select cron.schedule(
     'routemates-location-share-cleanup',
     '* * * * *',
     'select public.cleanup_trip_location_shares();'
   );
   ```
6. In Supabase Realtime settings, disable **Allow public access**. Do not grant browser roles `INSERT` on `realtime.messages`. Never execute SQL or apply this migration automatically from the frontend.

The new migrations have **not** been executed or runtime-validated by this task. Review and manually apply them to the test project, deploy the Edge Function, and configure Cron before testing sharing. The test plan is `supabase/tests/SECURITY_TEST_PLAN.md`.

## Places and route matching

- Autocomplete uses the Google Places Autocomplete (New) JavaScript API, with an India region preference and Bengaluru location bias. Suggestions are debounced and use a fresh session token per search/select flow.
- The form stores the user's typed location label and the selected Google Place ID. Google place names/coordinates are resolved transiently in the current page session; no coordinate columns, localStorage, or sessionStorage cache is added.
- Matching compares endpoints independently. When both sides have coordinates, pickup must be within 3 km and destination within 5 km; a known distant coordinate pair always rejects even if the text is similar. Exact Place IDs are used when endpoint coordinates are unavailable. Normalized/fuzzy text is a lower-confidence fallback only for endpoints that lack both a coordinate pair and matching Place IDs. Direction is checked when all four route coordinates resolve. These are straight-line proximity thresholds, not road-route matching.
- Each Find shared rides search resolves at most 12 future trip candidates and may request up to 24 Google Place details for their endpoints (often fewer because results are de-duplicated in memory). These calls may incur Google Maps Platform charges. Configure project quotas and billing alerts, and avoid repeatedly searching while testing.
- Public Discover has no map. There is no road-route geometry or real route-overlap engine. Location points can only appear in an accepted trip after each participant separately opts in; this prototype flow still requires multi-device verification.

## Trip chat and location sharing

- Chat is available only to the trip host and accepted riders. Message identity/name is assigned from the authenticated user and profile. Message history remains readable after cancellation/completion; new messages stop when a trip becomes terminal.
- Location sharing is separately opt-in for each accepted participant. It requires browser permission and HTTPS (localhost is suitable for development). Each update goes to the authenticated `share-trip-location` Edge Function, which derives actor identity from verified JWT claims and calls a service-role-only SQL authorization/rate-limit function. Coordinates are not passed to PostgreSQL. The function uses `channel.httpSend()` for a private Realtime REST Broadcast; the REST transport sends to connected clients without inserting the payload into `realtime.messages`. The app stops the watcher on opt-out, sign-out, pending-start cancellation, page cleanup, hidden page, GPS error, and trip end. The server lease expires after 30 seconds without a fresh position; stale markers are removed from the view after 60 seconds. Sharing runs only while RouteMates is open and visible; background GPS is not supported.
- Current coordinates exist briefly in ChatPanel/Google Maps memory and transit Supabase's Realtime service for delivery. The application does not store coordinate history or log coordinates. REST Broadcast avoids Database Broadcast history, but provider-level operational logging/retention behavior was not verified and must not be treated as zero-retention. Older coordinates sent by the previous database Broadcast path may remain in `realtime.messages` until Supabase retention cleanup (up to about four days); the additive migration does not erase those earlier partitions.
- RouteMates tables hold only each participant's enabled state, random share key, last update time, lease expiry, and change time. Explicit stop and trip termination delete share rows; the scheduled `cleanup_trip_location_shares()` job removes expired rows and disabled legacy metadata. If the user does not configure the Cron job, expired rows can persist even though the relay rejects their keys.
- The live map passes current marker positions to the configured Google Maps JavaScript SDK; this task did not verify Google's provider-side handling. Use fictional test accounts/devices. Keep **Allow public access** disabled in Supabase Realtime settings and verify cross-account delivery, direct publish denial, Edge authentication, lease expiry, and Cron operation manually. The UI and SQL alone do not prove runtime behavior.

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
5. Review/apply the new location relay migration, deploy the `share-trip-location` Edge Function, and configure its required platform-managed runtime inputs (`SUPABASE_URL`, `SUPABASE_SECRET_KEYS`) without exposing them to the frontend. Enable the `pg_cron` extension and schedule `cleanup_trip_location_shares()` every minute.
6. On both accepted-member devices, test location permission denial, opt-in, marker updates, Stop Sharing, cancellation while the browser permission prompt is open, direct client Broadcast denial, and cleanup after lease expiry. Test HTTPS preview or localhost. Try ending the trip while a share is active and verify it stops. Inspect Database Broadcast history for the test topic and verify precise new coordinates never appear there.
7. Repeat the existing seat-capacity race with two riders and one seat in separate host sessions. Exactly one acceptance should succeed. This race has not been runtime-tested by this task.
8. Remove all Supabase variables and restart Vite. Verify local fictional demo interactions remain available and the UI says demo mode. Restore credentials; a database failure must show an error rather than fake data.

## Prototype limitations

The Google Maps key, Supabase settings, new migration, Edge Function, Cron job, chat and live-location flows need manual configuration and multi-account/device verification. The REST relay requires a Supabase Realtime server that supports `httpSend` (Realtime server v2.97.0 or later; this project has not been checked). This work did not deploy the app or function, execute SQL, connect to Supabase, or test live GPS on separate HTTPS devices. No road route matching, payments, cab booking, identity/student verification, or public production launch is included. Account deletion remains blocked when accepted-request history exists under the base schema.
