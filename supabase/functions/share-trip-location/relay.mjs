const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class RelayError extends Error {
  constructor(message, status, code = 'relay_error') {
    super(message);
    this.name = 'RelayError';
    this.status = status;
    this.code = code;
  }
}

export function validateRelayInput(actorId, body) {
  if (typeof actorId !== 'string' || !UUID_PATTERN.test(actorId)) {
    throw new RelayError('A valid signed-in user is required.', 401, 'unauthenticated');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RelayError('The location update is invalid.', 400, 'invalid_body');
  }

  const permitted = new Set(['trip_id', 'share_key', 'latitude', 'longitude']);
  if (Object.keys(body).some((key) => !permitted.has(key))
    || typeof body.trip_id !== 'string' || !UUID_PATTERN.test(body.trip_id)
    || typeof body.share_key !== 'string' || !UUID_PATTERN.test(body.share_key)) {
    throw new RelayError('The location update is invalid.', 400, 'invalid_body');
  }
  if (typeof body.latitude !== 'number' || !Number.isFinite(body.latitude)
    || body.latitude < -90 || body.latitude > 90
    || typeof body.longitude !== 'number' || !Number.isFinite(body.longitude)
    || body.longitude < -180 || body.longitude > 180) {
    throw new RelayError('The location coordinates are invalid.', 400, 'invalid_coordinates');
  }

  return {
    actorId,
    tripId: body.trip_id,
    shareKey: body.share_key,
    latitude: body.latitude,
    longitude: body.longitude,
  };
}

export async function relayTripLocation({ actorId, body, authorize, send }) {
  const input = validateRelayInput(actorId, body);
  const authorization = await authorize({
    actorId: input.actorId,
    tripId: input.tripId,
    shareKey: input.shareKey,
  });
  if (!authorization || typeof authorization.display_name !== 'string'
    || !authorization.display_name.trim() || typeof authorization.sent_at !== 'string'
    || !Number.isFinite(Date.parse(authorization.sent_at))) {
    throw new RelayError('Location sharing is no longer active for this account.', 403, 'not_authorized');
  }

  const topic = `trip:${input.tripId}:location`;
  const payload = {
    kind: 'location',
    display_name: authorization.display_name,
    share_key: input.shareKey,
    latitude: input.latitude,
    longitude: input.longitude,
    sent_at: authorization.sent_at,
  };

  try {
    await send({ topic, event: 'location_event', payload });
  } catch {
    throw new RelayError('The location update could not be delivered. Sharing will expire if no fresh update arrives.', 502, 'delivery_failed');
  }
  return { ok: true };
}
