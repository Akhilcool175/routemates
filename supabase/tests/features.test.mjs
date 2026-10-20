import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { matchRoute, normalizePlaceText, distanceKm } from '../../src/lib/routeMatching.mjs';
import { validateTripForm } from '../../src/lib/tripValidation.mjs';

const root = new URL('../../', import.meta.url);
const app = await readFile(new URL('src/App.tsx', root), 'utf8');
const places = await readFile(new URL('src/lib/places.ts', root), 'utf8');
const locationInput = await readFile(new URL('src/components/LocationInput.tsx', root), 'utf8');
const styles = await readFile(new URL('src/styles.css', root), 'utf8');
const baseMigration = await readFile(new URL('supabase/migrations/20261018000100_create_routemates_tables.sql', root), 'utf8');
const featureMigration = await readFile(new URL('supabase/migrations/20261019000100_add_place_chat_location_sharing.sql', root), 'utf8');
const testPlan = await readFile(new URL('supabase/tests/SECURITY_TEST_PLAN.md', root), 'utf8');

test('place labels normalize case, whitespace, punctuation and stated aliases', () => {
  assert.equal(normalizePlaceText('  BLR  Intl. Apt '), 'bengaluru international airport');
  assert.equal(normalizePlaceText('St. Marks Rd.'), 'street marks road');
  assert.equal(normalizePlaceText('Bengaluru'), normalizePlaceText('Bangalore'));
});

test('text-only route matching reports lower-confidence compatible endpoints', () => {
  const result = matchRoute(
    { pickup: { label: 'BLR Majestic Bus Stand' }, destination: { label: 'Kempegowda Intl Apt' } },
    { pickup: { label: 'Bangalore Majestic Bus Stand' }, destination: { label: 'Kempegowda International Airport' } },
  );
  assert.equal(result?.confidence, 'text');
  assert.match(result?.reason ?? '', /proximity is not verified/i);
});

test('partial coordinate matching never lets similar text override a known distant endpoint', () => {
  const search = {
    pickup: { label: 'Campus pickup', coordinates: { lat: 12.9716, lng: 77.5946 } },
    destination: { label: 'Kempegowda International Airport' },
  };
  const distant = {
    pickup: { label: 'Campus pickup', coordinates: { lat: 19.076, lng: 72.877 } },
    destination: { label: 'Kempegowda Intl Apt' },
  };
  assert.equal(matchRoute(search, distant), null);

  const nearbyPickup = {
    pickup: { label: 'Different pickup name', coordinates: { lat: 12.973, lng: 77.596 } },
    destination: { label: 'Kempegowda Intl Apt' },
  };
  const mixed = matchRoute(search, nearbyPickup);
  assert.equal(mixed?.confidence, 'mixed');
  assert.match(mixed?.reason ?? '', /Nearby pickup/);
  assert.match(mixed?.reason ?? '', /similar destination text/);
});

test('matching prefers identical Place IDs when coordinates are unavailable, but coordinates override IDs', () => {
  const selected = {
    pickup: { label: 'Typed campus name', placeId: 'pickup-id' },
    destination: { label: 'Typed airport name', placeId: 'destination-id' },
  };
  const samePlaces = {
    pickup: { label: 'Different campus wording', placeId: 'pickup-id' },
    destination: { label: 'Different airport wording', placeId: 'destination-id' },
  };
  assert.equal(matchRoute(selected, samePlaces)?.confidence, 'place-id');
  assert.equal(matchRoute(
    { ...selected, pickup: { ...selected.pickup, coordinates: { lat: 12.9716, lng: 77.5946 } } },
    { ...samePlaces, pickup: { ...samePlaces.pickup, coordinates: { lat: 19.076, lng: 72.877 } } },
  ), null);
});

test('coordinate matching checks pickup, destination and direction without text override', () => {
  const origin = { lat: 12.976, lng: 77.572 };
  const airport = { lat: 13.198, lng: 77.706 };
  const nearOrigin = { lat: 12.978, lng: 77.574 };
  const nearAirport = { lat: 13.199, lng: 77.708 };
  const search = { pickup: { label: 'Same words', coordinates: origin }, destination: { label: 'Same words', coordinates: airport } };
  const nearby = { pickup: { label: 'Different', coordinates: nearOrigin }, destination: { label: 'Different', coordinates: nearAirport } };
  assert.equal(matchRoute(search, nearby)?.confidence, 'coordinate');
  assert.ok((distanceKm(origin, nearOrigin) ?? Infinity) < 3);
  const distant = { pickup: { label: 'Same words', coordinates: { lat: 19.076, lng: 72.877 } }, destination: { label: 'Same words', coordinates: airport } };
  assert.equal(matchRoute(search, distant), null);
  const farDestination = { pickup: nearby.pickup, destination: { label: 'Same words', coordinates: { lat: 19.076, lng: 72.877 } } };
  assert.equal(matchRoute(search, farDestination), null);
  const reverse = { pickup: { label: 'Airport', coordinates: airport }, destination: { label: 'Campus', coordinates: origin } };
  assert.equal(matchRoute(search, reverse), null);
});

test('trip validation requires local date/time and an explicit 1–4 seat choice', () => {
  const now = new Date(2031, 4, 12, 8, 0).getTime();
  const past = validateTripForm({ pickup: 'Campus', destination: 'Airport', date: '2031-05-12', time: '07:30', seats: '2', note: '' }, now);
  assert.equal(past.errors.time, 'Departure must be in the future.');
  const missing = validateTripForm({ pickup: 'Campus', destination: 'Airport', date: '', time: '', seats: '', note: '' }, now);
  assert.ok(missing.errors.date);
  assert.ok(missing.errors.time);
  assert.ok(missing.errors.seats);
  const valid = validateTripForm({ pickup: 'Campus', destination: 'Airport', date: '2031-05-13', time: '09:45', seats: '3', note: 'One bag' }, now);
  assert.equal(valid.errors.time, undefined);
  assert.equal(valid.value?.departure_at, new Date(2031, 4, 13, 9, 45).toISOString());
  assert.equal(valid.value?.seats_available, 3);
});

test('Google Places adapter uses a session token, regional bias and a public key variable only', () => {
  assert.match(places, /VITE_GOOGLE_MAPS_API_KEY/);
  assert.match(places, /AutocompleteSessionToken/);
  assert.match(places, /sessionToken/);
  assert.match(places, /locationBias/);
  assert.match(places, /includedRegionCodes:\s*\['in'\]/);
  assert.match(places, /callback: '__routematesGoogleMapsReady'/);
  assert.match(places, /importLibrary\('places'\)/);
  assert.match(places, /importLibrary\('marker'\)/);
  assert.match(places, /function loadPlacesLibrary\(\): Promise<PlacesLibrary>/);
  assert.match(places, /function loadMapsLibrary\(\): Promise<MapsLibrary>/);
  assert.match(places, /function loadMarkerLibrary\(\): Promise<MarkerLibrary>/);
  assert.match(places, /if \(!isPlacesLibrary\(value\)\)/);
  assert.match(places, /if \(!isMapsLibrary\(value\)\)/);
  assert.match(places, /if \(!isMarkerLibrary\(value\)\)/);
  assert.match(places, /googleMaps\.places/);
  assert.match(places, /if \(scriptLoader\) return scriptLoader/);
  assert.match(places, /data-routemates-google-maps/);
  assert.match(places, /gm_authFailure/);
  assert.match(places, /referrer restriction/);
  assert.doesNotMatch(places, /libraries:\s*'places'/);
  assert.doesNotMatch(places, /Google Maps loaded, but the Places or Maps library is incomplete/);
  assert.doesNotMatch(places, /Google Maps loaded without the expected Places library/);
  assert.doesNotMatch(places, /VITE_GOOGLE_MAPS_API_KEY\s*=\s*['"][^'"]{10,}/);
});

test('Discover is a focused route search without a decorative map or extra trip filters', () => {
  assert.doesNotMatch(app, /MapStage/);
  assert.doesNotMatch(app, /className="location-link"/);
  assert.doesNotMatch(styles, /\.location-link\s*\{/);
  assert.match(app, /Where are you headed/);
  assert.match(app, /label="From"/);
  assert.match(app, /label="To"/);
  assert.match(app, /Find shared rides/);
  assert.doesNotMatch(app.slice(app.indexOf('function DiscoverPage'), app.indexOf('function TripCard')), /DATE|DEPARTURE|Browse all dates|Best location match/);
  assert.doesNotMatch(app.slice(app.indexOf('function DiscoverPage'), app.indexOf('function TripCard')), /fare|price|₹/i);
});

test('place input exposes keyboard, empty, error, selection and manual fallback states', () => {
  assert.match(locationInput, /ArrowDown/);
  assert.match(locationInput, /ArrowUp/);
  assert.match(locationInput, /event\.key === 'Enter'/);
  assert.match(locationInput, /event\.key === 'Escape'/);
  assert.match(locationInput, /No places found/);
  assert.match(locationInput, /setError\(caught instanceof Error/);
  assert.match(locationInput, /selectPlace\(suggestion, text\)/);
  assert.match(locationInput, /proximity is unverified/);
  assert.match(locationInput, /aria-activedescendant/);
});

test('route detail lookup is bounded to reduce accidental Places API cost', () => {
  assert.match(app, /const MAX_ROUTE_CANDIDATES = 12/);
  assert.match(app, /slice\(0, MAX_ROUTE_CANDIDATES\)/);
  assert.match(app, /eligibleCandidates\.length > candidates\.length/);
  assert.match(app, /Checked the \$\{MAX_ROUTE_CANDIDATES\} soonest available trips/);
});

test('Create Trip UI exposes editable date, time, seats, note and inline errors with no fare UI', () => {
  assert.match(app, /Departure date<input type="date" value=\{form\.date\}/);
  assert.match(app, /Departure time<input type="time" value=\{form\.time\}/);
  assert.match(app, /Available seats<select value=\{form\.seats\}/);
  assert.match(app, /Choose seats/);
  assert.match(app, /Trip note/);
  assert.doesNotMatch(app, /estimated_fare_per_person|farePerPerson|₹/);
});

test('additive migration preserves legacy fares while allowing fare-free new trips', () => {
  assert.match(featureMigration, /alter column estimated_fare_per_person drop not null/i);
  assert.match(featureMigration, /revoke select \(estimated_fare_per_person\)[\s\S]*?from authenticated/i);
  assert.match(baseMigration, /estimated_fare_per_person numeric\(10, 2\) not null/i);
});

test('chat writes derive sender identity and only accepted trip members can read/send', () => {
  assert.match(featureMigration, /new\.sender_id := v_actor/i);
  assert.match(featureMigration, /new\.sender_display_name := v_display_name/i);
  const prepareMessage = featureMigration.slice(featureMigration.indexOf('create function public.prepare_ride_message'), featureMigration.indexOf('create trigger ride_messages_prepare_insert'));
  assert.match(prepareMessage, /security definer set search_path = ''/i);
  const participantChecks = [...prepareMessage.matchAll(/public\.is_trip_participant\(new\.trip_id\)/g)].map((match) => match.index ?? -1);
  const tripLock = prepareMessage.indexOf('from public.trips as t where t.id = new.trip_id for update');
  assert.ok(participantChecks.length >= 2 && participantChecks[0] < tripLock && participantChecks[1] > tripLock);
  assert.match(featureMigration, /create policy "Accepted trip participants read trip messages"[\s\S]*?public\.is_trip_participant\(trip_id\)/i);
  assert.match(featureMigration, /public\.can_send_trip_message\(trip_id\)/i);
  assert.match(featureMigration, /revoke all privileges on table public\.ride_messages from public, anon, authenticated/i);
  assert.match(featureMigration, /grant select \(id, trip_id, sender_display_name, client_nonce, body, created_at\)/i);
  assert.doesNotMatch(featureMigration, /grant select \([^)]*sender_id[^)]*\) on table public\.ride_messages/i);
  assert.match(featureMigration, /status in \('open', 'full'\)/i);
});

test('private Realtime topics are participant scoped and location sends recheck opt-in per update', () => {
  const broadcast = featureMigration.slice(featureMigration.indexOf('create function public.broadcast_trip_location'));
  assert.match(featureMigration, /create policy "RouteMates participants read private trip channels"/i);
  assert.match(featureMigration, /public\.can_read_trip_realtime_topic\(realtime\.topic\(\), realtime\.messages\.extension\)/i);
  assert.match(featureMigration, /if v_match\[2\] = 'location' then[\s\S]*?v_trip_status is distinct from 'open'/i);
  assert.match(featureMigration, /No authenticated INSERT policy is granted on realtime\.messages/i);
  assert.match(broadcast, /v_share\.share_key is distinct from p_share_key/i);
  assert.match(broadcast, /v_share\.expires_at <= v_now/i);
  assert.match(broadcast, /last_broadcast_at > v_now - interval '3 seconds'/i);
  assert.ok(broadcast.indexOf('from public.trips as t where t.id = p_trip_id for update')
    < broadcast.indexOf('from public.trip_location_shares as s'));
  assert.match(featureMigration, /expires_at > statement_timestamp\(\)/i);
  assert.match(featureMigration, /set enabled = false, share_key = null, expires_at = null/i);
  assert.match(testPlan, /private Realtime|private trip channel/i);
});

test('message Realtime notification sends an opaque ID only; history RPC checks membership', () => {
  const notify = featureMigration.slice(featureMigration.indexOf('create function public.broadcast_ride_message_notice'));
  assert.match(notify, /jsonb_build_object\('message_id', new\.id\)/i);
  assert.doesNotMatch(notify, /new\.(body|sender_id|sender_display_name)/i);
  assert.match(featureMigration, /not public\.is_trip_participant\(p_trip_id\)/i);
});

test('test plan covers cross-account chat and consent-based location rejection cases', () => {
  assert.match(testPlan, /pending, declined, cancelled and unrelated users cannot read/i);
  assert.match(testPlan, /Share live location/i);
  assert.match(testPlan, /Stop sharing/i);
  assert.match(testPlan, /expired|stale/i);
});
