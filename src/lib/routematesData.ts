import type { User } from '@supabase/supabase-js';
import { supabase, type Database, type RideRequestStatus, type TripStatus } from './supabase';

type ProfileRow = Database['public']['Tables']['profiles']['Row'];
type TripRow = Database['public']['Tables']['trips']['Row'];
type RequestRow = Database['public']['Tables']['ride_requests']['Row'];
type TripSelect = Pick<TripRow,
  'id' | 'pickup_label' | 'destination_label' | 'departure_at' | 'seats_available' |
  'pickup_provider' | 'pickup_place_id' | 'destination_provider' | 'destination_place_id' |
  'note' | 'status' | 'created_at'>;
type RequestSelect = Pick<RequestRow, 'id' | 'trip_id' | 'message' | 'status' | 'created_at'>;

export type TripView = {
  id: string;
  hostName: string;
  pickup: string;
  destination: string;
  pickupProvider: 'google' | null;
  pickupPlaceId: string | null;
  destinationProvider: 'google' | null;
  destinationPlaceId: string | null;
  departureAt: string;
  seatsAvailable: number;
  note: string;
  status: TripStatus;
  owned: boolean;
  requestStatus: RideRequestStatus | null;
  chatAvailable: boolean;
};

export type RequestView = {
  id: string;
  tripId: string;
  direction: 'sent' | 'received';
  status: RideRequestStatus;
  message: string | null;
  createdAt: string;
  otherPerson: string;
  trip: TripView | null;
};

export type AppData = { trips: TripView[]; requests: RequestView[] };

export type NewTrip = {
  pickup_label: string;
  destination_label: string;
  pickup_provider: 'google' | null;
  pickup_place_id: string | null;
  destination_provider: 'google' | null;
  destination_place_id: string | null;
  departure_at: string;
  seats_available: number;
  note: string | null;
};

export type TripMessage = {
  id: string;
  tripId: string;
  senderName: string;
  clientNonce: string;
  body: string;
  createdAt: string;
  isSelf: boolean;
};

export type LocationShareState = { displayName: string; isSelf: boolean; isSharing: boolean; shareKey: string | null };

function getClient() {
  if (!supabase) throw new Error('Supabase is not configured.');
  return supabase;
}

function throwIfError(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

export async function loadOwnProfile(userId: string): Promise<ProfileRow | null> {
  const { data, error } = await getClient()
    .from('profiles')
    .select('id, display_name, campus, created_at')
    .eq('id', userId)
    .maybeSingle();
  throwIfError(error);
  return data;
}

export async function updateOwnProfile(userId: string, displayName: string, campus: string): Promise<ProfileRow> {
  const { data, error } = await getClient()
    .from('profiles')
    .update({ display_name: displayName.trim(), campus: campus.trim() || null })
    .eq('id', userId)
    .select('id, display_name, campus, created_at')
    .single();
  throwIfError(error);
  if (!data) throw new Error('The profile update did not return a row.');
  return data;
}

async function checkOwnership(trips: TripSelect[]): Promise<Map<string, boolean>> {
  const client = getClient();
  const ownership = new Map<string, boolean>();
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < trips.length) {
      const trip = trips[nextIndex++];
      const { data, error } = await client.rpc('is_trip_owner', { p_trip_id: trip.id });
      throwIfError(error);
      ownership.set(trip.id, data === true);
    }
  };
  await Promise.all(Array.from({ length: Math.min(12, trips.length) }, () => worker()));
  return ownership;
}

export async function loadAppData(displayName: string): Promise<AppData> {
  const client = getClient();
  const [tripResult, requestResult] = await Promise.all([
    client.from('trips')
      .select('id, pickup_label, destination_label, departure_at, seats_available, pickup_provider, pickup_place_id, destination_provider, destination_place_id, note, status, created_at')
      .order('departure_at', { ascending: true })
      .limit(500),
    client.from('ride_requests')
      .select('id, trip_id, message, status, created_at')
      .order('created_at', { ascending: false })
      .limit(1000),
  ]);
  throwIfError(tripResult.error);
  throwIfError(requestResult.error);

  const tripRows = (tripResult.data ?? []) as TripSelect[];
  const requestRows = (requestResult.data ?? []) as RequestSelect[];
  const [ownership, hostNames, requesterNames] = await Promise.all([
    checkOwnership(tripRows),
    tripRows.length
      ? client.rpc('get_open_trip_host_names', { p_trip_ids: tripRows.map((trip) => trip.id) })
      : Promise.resolve({ data: [], error: null }),
    requestRows.length
      ? client.rpc('get_ride_requester_names', { p_request_ids: requestRows.map((request) => request.id) })
      : Promise.resolve({ data: [], error: null }),
  ]);
  throwIfError(hostNames.error);
  throwIfError(requesterNames.error);

  const hostNameByTripId = new Map((hostNames.data ?? []).map((row) => [row.trip_id, row.public_display_name]));
  const ownedTripIds = new Set(tripRows.filter((trip) => ownership.get(trip.id)).map((trip) => trip.id));
  const requesterNameById = new Map((requesterNames.data ?? []).map((row) => [row.request_id, row.public_display_name]));
  const ownRequestByTripId = new Map(requestRows
    .filter((request) => !ownedTripIds.has(request.trip_id))
    .map((request) => [request.trip_id, request.status]));

  const tripViews: TripView[] = tripRows.map((trip) => {
    const owned = ownership.get(trip.id) === true;
    return {
      id: trip.id,
      hostName: owned ? displayName : hostNameByTripId.get(trip.id) ?? 'RouteMates member',
      pickup: trip.pickup_label,
      destination: trip.destination_label,
      pickupProvider: trip.pickup_provider === 'google' ? 'google' : null,
      pickupPlaceId: trip.pickup_place_id,
      destinationProvider: trip.destination_provider === 'google' ? 'google' : null,
      destinationPlaceId: trip.destination_place_id,
      departureAt: trip.departure_at,
      seatsAvailable: trip.seats_available,
      note: trip.note ?? '',
      status: trip.status,
      owned,
      requestStatus: ownRequestByTripId.get(trip.id) ?? null,
      chatAvailable: owned
        ? requestRows.some((request) => request.trip_id === trip.id && request.status === 'accepted')
        : ownRequestByTripId.get(trip.id) === 'accepted',
    };
  });
  const tripById = new Map(tripViews.map((trip) => [trip.id, trip]));

  const requests: RequestView[] = requestRows.map((request) => {
    const direction = ownedTripIds.has(request.trip_id) ? 'received' : 'sent';
    const trip = tripById.get(request.trip_id) ?? null;
    return {
      id: request.id,
      tripId: request.trip_id,
      direction,
      status: request.status,
      message: request.message,
      createdAt: request.created_at,
      otherPerson: direction === 'received'
        ? requesterNameById.get(request.id) ?? 'Profile unavailable'
        : trip?.hostName ?? 'Trip details unavailable',
      trip,
    };
  });

  return { trips: tripViews, requests };
}

export async function createTrip(values: NewTrip): Promise<void> {
  const { error } = await getClient().from('trips').insert(values);
  throwIfError(error);
}

export async function loadTripMessages(tripId: string): Promise<TripMessage[]> {
  const { data, error } = await getClient().rpc('get_trip_messages', { p_trip_id: tripId });
  throwIfError(error);
  return (data ?? []).slice().reverse().map((message) => ({
    id: message.id,
    tripId: message.trip_id,
    senderName: message.sender_display_name,
    clientNonce: message.client_nonce,
    body: message.body,
    createdAt: message.created_at,
    isSelf: message.is_self,
  }));
}

export async function sendTripMessage(tripId: string, body: string, clientNonce: string): Promise<TripMessage> {
  const { data, error } = await getClient().from('ride_messages')
    .insert({ trip_id: tripId, body: body.trim(), client_nonce: clientNonce })
    .select('id, trip_id, sender_display_name, client_nonce, body, created_at')
    .single();
  throwIfError(error);
  if (!data) throw new Error('The message was not returned by the database.');
  return {
    id: data.id,
    tripId: data.trip_id,
    senderName: data.sender_display_name,
    clientNonce: data.client_nonce,
    body: data.body,
    createdAt: data.created_at,
    isSelf: true,
  };
}

export async function loadTripLocationShareStates(tripId: string): Promise<LocationShareState[]> {
  const { data, error } = await getClient().rpc('get_trip_location_share_states', { p_trip_id: tripId });
  throwIfError(error);
  return (data ?? []).map((state) => ({
    displayName: state.public_display_name,
    isSelf: state.is_self,
    isSharing: state.is_sharing,
    shareKey: state.share_key,
  }));
}

export async function setTripLocationSharing(tripId: string, enabled: boolean): Promise<string | null> {
  const { data, error } = await getClient().rpc('set_trip_location_sharing', { p_trip_id: tripId, p_enabled: enabled });
  throwIfError(error);
  return data;
}

export async function relayTripLocation(tripId: string, shareKey: string, latitude: number, longitude: number): Promise<void> {
  const { error } = await getClient().functions.invoke('share-trip-location', {
    body: { trip_id: tripId, share_key: shareKey, latitude, longitude },
  });
  throwIfError(error);
}

export async function createRideRequest(tripId: string, message = ''): Promise<void> {
  const { error } = await getClient().from('ride_requests').insert({
    trip_id: tripId,
    message: message.trim() || null,
  });
  throwIfError(error);
}

export async function respondToRideRequest(requestId: string, decision: 'accepted' | 'declined'): Promise<void> {
  const { error } = await getClient().rpc('respond_to_ride_request', {
    p_request_id: requestId,
    p_decision: decision,
  });
  throwIfError(error);
}

export async function cancelRideRequest(requestId: string): Promise<void> {
  const { error } = await getClient().rpc('cancel_ride_request', { p_request_id: requestId });
  throwIfError(error);
}

export async function cancelTrip(tripId: string): Promise<void> {
  const { error } = await getClient().rpc('cancel_trip', { p_trip_id: tripId });
  throwIfError(error);
}

export async function completeTrip(tripId: string): Promise<void> {
  const { error } = await getClient().rpc('complete_trip', { p_trip_id: tripId });
  throwIfError(error);
}

export async function signUp(email: string, password: string, displayName: string, campus: string) {
  return getClient().auth.signUp({
    email: email.trim(),
    password,
    options: { data: { display_name: displayName.trim(), campus: campus.trim() || null } },
  });
}

export async function signIn(email: string, password: string) {
  return getClient().auth.signInWithPassword({ email: email.trim(), password });
}

export async function signOut() {
  return getClient().auth.signOut();
}

export type AuthUser = User;
