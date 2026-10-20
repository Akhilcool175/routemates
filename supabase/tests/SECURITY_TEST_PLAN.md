# RouteMates migration security test plan

`npm test` runs static source-contract checks in `migration-contract.test.mjs`. These assertions guard key SQL patterns but do not run PostgreSQL, exercise RLS in a live project, or prove concurrency/locking behavior. The two-session checks below remain manual database tests.

Manual checks for a disposable Supabase project, after a human reviews and separately applies both migrations in timestamp order. The 20261018000100 migration is the base schema; 20261019000100 adds locations, chat and location-sharing support. This plan has not been run for the current frontend integration. Do not use a service-role key for ordinary client/API checks. Without database credentials the frontend remains in fictional local demo mode.

Signup copies the display name from user-supplied Auth metadata into the member's profile; members may later edit their own profile display name. Names are self-reported and unverified; a returned name is not proof of identity or campus membership.

## Setup

Create three Auth users: **Host A**, **Rider B**, and **Rider C**, with distinct display-name metadata. Use separate authenticated sessions for concurrent API calls.

1. Verify signup creates exactly one `profiles` row using the new Auth user's ID. Check that an empty display-name value falls back to `RouteMates member`; treat all metadata names as unverified.
2. As Host A, create an open trip with a finite future `departure_at`, 1–4 seats, and optional note. Omit `user_id`, `status`, fare, and ID fields. Verify owner and open status defaults. The later migration makes fare optional; old fare values stay in the database but are not selected or shown by the app.
3. Keep a two-seat trip for ordinary checks, a one-seat trip for capacity checks, and a short-future trip whose departure can be allowed to pass for expiry checks.

## Profiles and safe discovery

- Host A can select and update only Host A's own profile. Rider B's profile query returns only Rider B's row; selecting Host A by ID returns no profile row.
- Direct profile insert, setting another user's profile ID, updating profile ID, or deleting a profile is denied. Deleting an Auth user with no accepted trip/request history cascades normally; deleting a host with an accepted trip or a rider with an accepted request is blocked so accepted history and consumed-seat accounting remain intact. The schema does not anonymize accepted history, so account removal remains blocked while such a request exists.
- With Rider B holding an accepted request, attempt to delete Rider B's Auth account through the Auth admin flow. Verify the operation fails atomically: the Auth user, profile, accepted request, and decremented trip seat all remain. Confirm deleting a rider with only pending/declined/cancelled requests still follows the documented cascade behavior.
- Rider B can read an open future trip's granted discovery columns but cannot select `user_id`. `get_open_trip_host_names([trip_id])` returns only the trip ID and the host's self-reported public display name—no campus or account ID. The result does not assert that the name is verified.
- After the short-future trip's departure passes while it remains `open` with seats available, Rider B cannot see it in discovery, `get_open_trip_host_names` returns no name, and inserting a request for it fails. Creating a trip or changing a departure to either `'-infinity'::timestamptz` or `'infinity'::timestamptz` is rejected.
- In a disposable test project only, seed fixtures for both `'-infinity'::timestamptz` and `'infinity'::timestamptz` using a privileged setup that temporarily bypasses only `trips_validate_write`, then re-enable it before testing. For each value, use one fixture with a pending request created while its departure is finite, then set the infinite departure; use a second fixture with no request. As Rider C, verify the fixtures are excluded from discovery and `get_open_trip_host_names`, request insertion against the second fixture fails, and Host A's acceptance and `complete_trip` calls against the first fixture fail. Remove the fixtures afterward. Do not bypass the trigger in a production project.
- Host A can call `get_ride_requester_names([request_id])` for a request on Host A's trip. Rider C calling it for that request receives no name.
- An anonymous `anon` session cannot select/insert/update/delete these tables or execute the RPCs. `PUBLIC` has no table or RPC access.

## Ownership and request permissions

- Rider B inserts a request for Host A's open future trip with only `trip_id` and optional `message`. `requester_id` defaults to Rider B and status to `pending`.
- Attempts to supply Host A's `requester_id`, request Rider B's own trip, or request a cancelled, completed, full, zero-seat, or expired trip are denied.
- A second request by Rider B for the same trip fails the unique `(trip_id, requester_id)` constraint.
- Rider C cannot cancel Rider B's request. Rider B can cancel their own pending request through `cancel_ride_request`; repeating it or cancelling after a host decision fails.
- Direct updates to request status are denied for requester and host. Rider C cannot invoke the host decision function for Host A's request. Host A can decline a pending request, but cannot decide another host's request or decide it again after it leaves `pending`.
- Requester UUIDs cannot be selected or changed through the API. Identity is assigned from `auth.uid()` and checked inside the functions.

## Trip lifecycle and capacity

- Direct authenticated updates to trip `status` are denied, including attempts to cancel, complete, fill, or reopen a trip. Direct updates to `seats_available` and `user_id` are denied.
- `cancel_trip` succeeds for the owning host when the trip is `open` or `full`; another user cannot call it. Repeating cancellation or trying to cancel a `cancelled`/`completed` trip fails. A cancelled trip cannot be reopened.
- `complete_trip` fails before departure and succeeds for the owning host after a finite departure when the trip is `open` or `full`. It rejects both negative and positive infinite departure values. It cannot complete another user's trip or a cancelled/completed trip. A completed trip cannot be reopened.
- Cancellation is allowed even when accepted riders exist. The trip becomes `cancelled`; accepted request rows remain `accepted` as history and seats are not restored. Clients should treat the trip status as cancelled. Pending requests remain pending until a requester cancels or the host declines them; they cannot be accepted after cancellation.
- On a cancelled trip with pending requests, Rider B can cancel only Rider B's own pending request through `cancel_ride_request`; verify it becomes `cancelled`. On another pending request on that cancelled trip, Host A can decline it through `respond_to_ride_request(..., 'declined')`; verify it becomes `declined`.
- On a separate cancelled trip that still has a pending request, Host A's attempt to accept it through `respond_to_ride_request(..., 'accepted')` fails. Verify the request remains pending and no seat is consumed.
- Concurrently insert a request as Rider B and cancel the same open trip as Host A in separate sessions. If insertion locks the trip first, it may commit as pending before cancellation; cancellation then commits and the request remains pending but cannot be accepted. If cancellation locks and commits first, the insert trigger must recheck the locked row and reject the request. Verify no request is inserted after cancellation commits and that neither outcome leaves a deadlock or a request accepted on the cancelled trip.
- On Host A's one-seat trip, Rider B and Rider C each create a distinct pending request. In two Host A sessions, call `respond_to_ride_request(request_b, 'accepted')` and `respond_to_ride_request(request_c, 'accepted')` concurrently. Exactly one succeeds; the other fails after acquiring the trip lock and seeing no seats. Verify zero seats, `full` status, and exactly one accepted request. Repeating acceptance fails.
- On a separate open trip with a pending request, concurrently call `respond_to_ride_request(request_id, 'accepted')` and `cancel_trip(trip_id)` as Host A. If acceptance obtains the trip lock first, it may succeed and cancellation then succeeds; the request remains accepted and the final trip status is cancelled. If cancellation obtains the lock first, acceptance fails and the request remains pending. No request may become accepted after cancellation commits.
- Creating a trip with zero seats, a past departure, negative infinity, or positive infinity fails. Changing a departure to the past, negative infinity, or positive infinity fails; changing it to another finite future time succeeds. An unrelated edit to a trip whose departure has passed may succeed, but it remains undiscoverable and cannot receive requests.

## Deletion protections

- An authenticated host's direct `DELETE` on `public.trips` is denied; normal app flows use `cancel_trip` instead.
- If a trusted database operator retains a hard-delete path, test the `BEFORE DELETE` guard on a disposable trip with an accepted request: deletion must fail and preserve both trip and request. For a pending request, deletion may cascade only through that privileged path.
- To test deletion racing acceptance, use two database sessions on a disposable trip with one pending request: one privileged session attempts the trip delete while Host A calls `respond_to_ride_request(..., 'accepted')`. If acceptance commits first, deletion must fail and the accepted request must remain. If deletion obtains the trip lock first, the trip/request may be removed and acceptance must fail. No accepted request may be deleted. Authenticated API clients have no concurrent trip-delete path.

## Frontend Auth and two-account manual checks

These are manual integration checks; they have not been run by the frontend build. Use the public anon/publishable key in the browser and ordinary authenticated sessions. Do not put a service-role key in the app.

1. Configure `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. In Supabase Auth, enable the Email provider and **Allow new users to sign up**; choose whether **Confirm Email** is enabled; set the Site URL to the local app origin for confirmation links and allow `http://localhost:5173/**` under redirect URLs. Configure SMTP if confirmation emails need to reach addresses beyond the project's built-in sender restrictions. Start two separate browser profiles or private windows.
2. Create **Host A** with a display name and optional campus. If email confirmation is enabled, confirm the email and then sign in. Verify the session persists after reload and the profile screen can edit the account's display name and private campus field.
3. In Host A's session, create a trip with a future departure and two seats. Verify it appears under My Trips and in the database with `status = open` and two seats remaining. Price/fare is not part of the UI.
4. Sign in as **Rider B** in the second browser profile. Search that route and verify the trip appears with Host A's self-reported display name, route details, and remaining seats. Verify no campus, email, or account UUID is shown.
5. As Rider B, request to join. Verify Requests shows `pending`; reload the page and verify the request persists. Repeating the request for that trip should show the existing status or surface the unique-request constraint instead of creating another row.
6. Return to Host A. Verify the request appears under Requests with only the requester's public display name and optional message. Accept it. Verify the request becomes `accepted`, the trip's remaining seats decrease from two to one, and My Trips reflects the new value after refresh.
7. Use another pending request to test decline, and another pending request to test Rider B's cancellation. Verify each status persists after reload and only the permitted account can perform each action.
8. Sign out and verify the protected screens return to the Auth view. Sign in again and confirm trip/request state is loaded from Supabase.
9. Remove both environment values and restart Vite. Verify the interface labels **Demo mode · local only** and all fictional interactions remain in this browser. Restore the settings and verify a database/network failure is shown as an error rather than replaced with sample trips.

## Place search, matching, and fare-free trips

These checks require the browser-restricted Google Maps key for autocomplete and map display. Without the key, manual location labels remain available; they are text-only and are explicitly lower confidence.

- Set `VITE_GOOGLE_MAPS_API_KEY` with the Maps JavaScript API and Places API (New) enabled. Use the Bengaluru bias, type partial values such as `ma`, `maj`, `mall`, and `air`, and verify suggestions load after a short pause. Check no-results, provider-error, mouse selection, Arrow Up/Down, Enter, and Escape behavior.
- Select a pickup and destination. Verify the canonical result is used only in the current browser session and that the saved trip contains the user's own typed label plus the Google Place ID. Confirm there are no stored Google coordinates or place names in `trips`, localStorage, or sessionStorage. Confirm the map, if shown with Places content, is a Google map with visible Google attribution.
- Search using case, whitespace, punctuation, alias, and spelling variants. For selected places verify nearby pickup within 3 km, nearby destination within 5 km, and compatible direction match. Verify far coordinates and reverse-direction routes are rejected even if labels are identical.
- For a trip with missing place IDs, verify the text fallback can return a lower-confidence match and clearly says it did not verify proximity. Confirm trip cards explain the match and do not claim road-route overlap.
- Create a trip without fare and verify it succeeds after applying the additive migration. Confirm old rows with legacy fare values still load, but no fare/rupee labels or inputs appear on any page.
- Verify the Maps API key is HTTP referrer restricted to local/preview app origins and API restricted to the browser Maps JavaScript and Places APIs. Confirm billing alerts/quotas and attribution; do not use an unrestricted key.

## Private trip chat

Use Host A, accepted Rider B, pending Rider C, and an unrelated Rider D with separate authenticated browser sessions. Apply the new migration before these checks.

- Pending, declined, cancelled and unrelated users cannot read messages or join either private trip channel.

- Before acceptance, Rider B and Rider C cannot load a chat or call `get_trip_messages` for Host A's trip. Rider D cannot read or send messages on that trip either. A requester with declined or cancelled status remains denied.
- Host A and Rider B can load chat history after Rider B is accepted. Rider C (pending) and Rider D (unrelated) cannot select `ride_messages`, call `get_trip_messages`, join `trip:<id>:chat`, or observe message notifications.
- As Rider B, try to insert a message with Host A's sender ID or a forged display name; the API must deny the column write, and the database trigger must set sender and display name from Rider B's auth/profile. A message with whitespace-only body or over 1000 characters fails. A second participant sees the correct self/other state and timestamp.
- Verify persisted messages survive reload. Realtime Broadcast contains only the opaque message row ID; clients fetch body and author through the participant-checked function. No email or sender UUID is returned to clients.
- After trip cancellation or completion, participants can read prior chat history but cannot send new messages. Pending/declined/cancelled riders remain excluded.
- In separate sessions, race a participant's message insert against `cancel_trip`. The insert trigger must lock the trip row first: a message may commit before cancellation obtains its lock, but after cancellation commits all new messages must be rejected.
- In Supabase Realtime settings, disable **Allow public access** so private-only topics are enforced. Confirm the app uses private channels. Do not add authenticated `INSERT` permission to `realtime.messages`; both chat notices and location updates are sent through the migration's database functions.

## Consent-based live location

Test on two separate accepted-member devices or browser profiles over HTTPS (localhost is valid for one-device development). Do not use actual student travel coordinates during testing.

- Before Rider B is accepted, verify the UI has no share control and Rider B cannot call `set_trip_location_sharing` or `broadcast_trip_location` successfully. After acceptance, Host A and Rider B each see their own independent opt-in control and the other participant's sharing status.
- Deny browser location permission. Verify a clear message appears, no coordinates are sent, and chat remains usable. Grant permission and opt in; verify only the host and accepted riders on this trip see the live marker. A different authenticated user and a user on another trip cannot join the private location topic or receive a fix.
- Attempt direct calls with coordinates outside latitude/longitude bounds, `NaN`, another trip ID, a different participant's share key, or too many updates inside three seconds. Verify each is rejected. Verify location updates refresh a 30-second database share lease and the client throttles to at least five seconds / meaningful movement.
- Press **Share live location** and later **Stop sharing**. Verify the device watcher stops, server opt-in is cleared, a stop event removes the marker, and future broadcast RPCs fail. Reload the page, sign out, hide/close the page, and confirm cleanup stops the share; after a crashed tab, wait for the 30-second lease to expire and verify new broadcasts are rejected and stale markers disappear within 60 seconds.
- Cancel or complete the trip while sharing in another session. Verify the database trigger disables all share rows in the same transaction, emits a trip-ended event, clears markers/watchers, and prevents subsequent broadcasts. Repeat with one participant's browser offline and verify any old marker ages out.
- After the trip is cancelled or completed, verify an accepted participant can no longer newly authorize the `:location` topic, even though they may still read trip chat history.
- In separate sessions, race `broadcast_trip_location` against `cancel_trip` for an opted-in participant. The location function must acquire the trip lock before the share-row lock, matching cancellation's order. A location update may complete before cancellation commits; after cancellation commits, every later location call must fail and the trip-ended event must clear markers.
- Inspect `public.trip_location_shares`: it may contain opt-in state, random share key, and timestamps only; it must not contain coordinates. Realtime Broadcast events are transient but Supabase may retain them for up to three days; account for that retention when deciding whether to enable this preview feature.
