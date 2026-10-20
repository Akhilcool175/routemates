import assert from 'node:assert/strict';
import test from 'node:test';
import { relayTripLocation } from '../../supabase/functions/share-trip-location/relay.mjs';
import { createLocationShareGeneration } from '../../src/lib/locationShareLifecycle.mjs';

const actorId = '10000000-0000-4000-8000-000000000001';
const tripId = '20000000-0000-4000-8000-000000000002';
const shareKey = '30000000-0000-4000-8000-000000000003';
const validBody = { trip_id: tripId, share_key: shareKey, latitude: 12.9716, longitude: 77.5946 };

function errorWithCode(code) {
  return Object.assign(new Error('mock authorization failure'), { code });
}

test('location relay rejects missing/invalid authenticated identity before authorization or delivery', async () => {
  let authorizationCalls = 0;
  let deliveries = 0;
  await assert.rejects(relayTripLocation({
    actorId: '', body: validBody,
    authorize: async () => { authorizationCalls += 1; return {}; },
    send: async () => { deliveries += 1; },
  }), (error) => error.status === 401);
  assert.equal(authorizationCalls, 0);
  assert.equal(deliveries, 0);
});

test('wrong, disabled, or expired share keys are denied by the authoritative server check', async () => {
  let deliveries = 0;
  await assert.rejects(relayTripLocation({
    actorId, body: validBody,
    authorize: async () => { throw errorWithCode('42501'); },
    send: async () => { deliveries += 1; },
  }), (error) => error.code === '42501');
  assert.equal(deliveries, 0);
});

test('server rate-limit rejection is propagated without publishing coordinates', async () => {
  let deliveries = 0;
  await assert.rejects(relayTripLocation({
    actorId, body: validBody,
    authorize: async () => { throw errorWithCode('P0001'); },
    send: async () => { deliveries += 1; },
  }), (error) => error.code === 'P0001');
  assert.equal(deliveries, 0);
});

test('malformed coordinates and forged actor fields are rejected before database access', async () => {
  let authorizationCalls = 0;
  const authorize = async () => { authorizationCalls += 1; return {}; };
  const send = async () => assert.fail('invalid input must not reach transport');
  for (const body of [
    { ...validBody, latitude: Number.NaN },
    { ...validBody, latitude: 91 },
    { ...validBody, longitude: -181 },
    { ...validBody, user_id: '40000000-0000-4000-8000-000000000004' },
  ]) {
    await assert.rejects(relayTripLocation({ actorId, body, authorize, send }), (error) => error.status === 400);
  }
  assert.equal(authorizationCalls, 0);
});

test('authorized delivery uses the exact private trip topic and location event payload', async () => {
  let authorization;
  let publication;
  await relayTripLocation({
    actorId, body: validBody,
    authorize: async (input) => {
      authorization = input;
      return { display_name: 'Fictional Rider', sent_at: '2031-05-13T09:45:00.000Z' };
    },
    send: async (input) => { publication = input; },
  });
  assert.deepEqual(authorization, { actorId, tripId, shareKey });
  assert.deepEqual(publication, {
    topic: `trip:${tripId}:location`,
    event: 'location_event',
    payload: {
      kind: 'location', display_name: 'Fictional Rider', share_key: shareKey,
      latitude: 12.9716, longitude: 77.5946, sent_at: '2031-05-13T09:45:00.000Z',
    },
  });
});

test('a stop/sign-out/unmount generation invalidates a pending geolocation callback', () => {
  const startGeneration = createLocationShareGeneration();
  let enableRequests = 0;
  const pendingToken = startGeneration.begin();
  const delayedDeviceCallback = () => {
    if (startGeneration.isCurrent(pendingToken)) enableRequests += 1;
  };

  startGeneration.invalidate();
  delayedDeviceCallback();
  assert.equal(enableRequests, 0);

  const nextToken = startGeneration.begin();
  delayedDeviceCallback();
  assert.equal(enableRequests, 0);
  assert.equal(startGeneration.isCurrent(nextToken), true);
});
