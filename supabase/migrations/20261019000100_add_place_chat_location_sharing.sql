-- Additive RouteMates upgrade for Places, private trip chat, and opt-in live
-- location Broadcast. Review and apply manually; the frontend never runs SQL.
-- Place IDs are retained. Google names and coordinates are resolved transiently
-- and are not persisted; labels remain the user's own typed search text.

-- Keep historic prices but stop requiring, selecting, or writing the legacy field.
alter table public.trips alter column estimated_fare_per_person drop not null;
revoke select (estimated_fare_per_person), insert (estimated_fare_per_person),
  update (estimated_fare_per_person) on table public.trips from authenticated;

alter table public.trips
  add column pickup_provider text,
  add column pickup_place_id text,
  add column destination_provider text,
  add column destination_place_id text,
  add constraint trips_pickup_provider_place_pair check (
    (pickup_provider is null and pickup_place_id is null)
    or (pickup_provider = 'google' and pickup_place_id is not null
      and char_length(trim(pickup_place_id)) between 1 and 255)
  ),
  add constraint trips_destination_provider_place_pair check (
    (destination_provider is null and destination_place_id is null)
    or (destination_provider = 'google' and destination_place_id is not null
      and char_length(trim(destination_place_id)) between 1 and 255)
  );
create index trips_pickup_place_id_idx on public.trips (pickup_place_id) where pickup_place_id is not null;
create index trips_destination_place_id_idx on public.trips (destination_place_id) where destination_place_id is not null;
grant select (pickup_provider, pickup_place_id, destination_provider, destination_place_id)
  on table public.trips to authenticated;
grant insert (pickup_provider, pickup_place_id, destination_provider, destination_place_id)
  on table public.trips to authenticated;
grant update (pickup_provider, pickup_place_id, destination_provider, destination_place_id)
  on table public.trips to authenticated;

-- Boolean-only, scoped authorization helpers. Neither returns membership rows,
-- profile fields, email addresses, or user IDs.
create function public.is_trip_participant(p_trip_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.trips as t
    where t.id = p_trip_id and (t.user_id = (select auth.uid()) or exists (
      select 1 from public.ride_requests as r
      where r.trip_id = t.id and r.requester_id = (select auth.uid()) and r.status = 'accepted'
    ))
  );
$$;
revoke all on function public.is_trip_participant(uuid) from public, anon, authenticated;
grant execute on function public.is_trip_participant(uuid) to authenticated;

create function public.can_send_trip_message(p_trip_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_trip_participant(p_trip_id) and exists (
    select 1 from public.trips as t where t.id = p_trip_id and t.status in ('open', 'full')
  );
$$;
revoke all on function public.can_send_trip_message(uuid) from public, anon, authenticated;
grant execute on function public.can_send_trip_message(uuid) to authenticated;

-- Chat history is available to the host and accepted riders after trip end;
-- sending is limited to open/full trips. Sender IDs are never granted to clients.
create table public.ride_messages (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  sender_id uuid references public.profiles (id) on delete set null,
  sender_display_name text not null,
  client_nonce uuid not null default gen_random_uuid(),
  body text not null check (char_length(trim(body)) between 1 and 1000),
  created_at timestamptz not null default clock_timestamp(),
  constraint ride_messages_sender_nonce_unique unique (sender_id, client_nonce)
);
create index ride_messages_trip_created_idx on public.ride_messages (trip_id, created_at desc, id desc);
alter table public.ride_messages enable row level security;
revoke all privileges on table public.ride_messages from public, anon, authenticated;
grant select (id, trip_id, sender_display_name, client_nonce, body, created_at)
  on table public.ride_messages to authenticated;
grant insert (trip_id, client_nonce, body) on table public.ride_messages to authenticated;
create policy "Accepted trip participants read trip messages"
  on public.ride_messages for select to authenticated
  using (public.is_trip_participant(trip_id));
create policy "Accepted trip participants send messages as themselves"
  on public.ride_messages for insert to authenticated
  with check (sender_id = (select auth.uid()) and public.can_send_trip_message(trip_id));

-- Set sender identity and the public, self-reported name from Auth/profile. The
-- client cannot supply either column, so message impersonation is blocked.
create function public.prepare_ride_message()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_display_name text;
  v_trip_status text;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if char_length(trim(new.body)) not between 1 and 1000 then
    raise exception 'Message must contain between one and 1000 characters' using errcode = '23514';
  end if;
  if not public.is_trip_participant(new.trip_id) then
    raise exception 'Only accepted trip participants can send messages' using errcode = '42501';
  end if;
  -- Serialize a message send against trip cancellation/completion. The trigger
  -- runs with the function owner's table access; clients keep no trip UPDATE
  -- privilege and this function is not directly executable by API roles.
  select t.status into v_trip_status from public.trips as t where t.id = new.trip_id for update;
  if not found or v_trip_status not in ('open', 'full') then
    raise exception 'Messages can only be sent before the trip ends' using errcode = '23514';
  end if;
  if not public.is_trip_participant(new.trip_id) then
    raise exception 'Only accepted trip participants can send messages' using errcode = '42501';
  end if;
  select p.display_name into v_display_name from public.profiles as p where p.id = v_actor;
  if not found then
    raise exception 'A RouteMates profile is required to send a message' using errcode = '23514';
  end if;
  new.sender_id := v_actor;
  new.sender_display_name := v_display_name;
  new.body := trim(new.body);
  return new;
end;
$$;
revoke all on function public.prepare_ride_message() from public, anon, authenticated;
create trigger ride_messages_prepare_insert before insert on public.ride_messages
for each row execute function public.prepare_ride_message();

-- Broadcast only the opaque message row ID. Clients then fetch the authorized
-- row through get_trip_messages, so Realtime never carries sender IDs or text.
create function public.broadcast_ride_message_notice()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send(jsonb_build_object('message_id', new.id), 'message_created',
    'trip:' || new.trip_id::text || ':chat', true);
  return new;
end;
$$;
revoke all on function public.broadcast_ride_message_notice() from public, anon, authenticated;
create trigger ride_messages_broadcast_notice after insert on public.ride_messages
for each row execute function public.broadcast_ride_message_notice();

-- History RPC derives is_self without returning sender account IDs.
create function public.get_trip_messages(p_trip_id uuid)
returns table (id uuid, trip_id uuid, sender_display_name text, client_nonce uuid,
  body text, created_at timestamptz, is_self boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not public.is_trip_participant(p_trip_id) then
    raise exception 'Only accepted trip participants can read this conversation' using errcode = '42501';
  end if;
  return query
    select m.id, m.trip_id, m.sender_display_name, m.client_nonce, m.body, m.created_at,
      m.sender_id = (select auth.uid())
    from public.ride_messages as m
    where m.trip_id = p_trip_id order by m.created_at desc, m.id desc limit 100;
end;
$$;
revoke all on function public.get_trip_messages(uuid) from public, anon, authenticated;
grant execute on function public.get_trip_messages(uuid) to authenticated;

-- Persist only a user's opt-in bit and rate-limit timestamp. Coordinates are
-- never written to public application tables.
create table public.trip_location_shares (
  trip_id uuid not null references public.trips (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  share_key uuid unique,
  enabled boolean not null default false,
  last_broadcast_at timestamptz,
  expires_at timestamptz,
  changed_at timestamptz not null default clock_timestamp(),
  primary key (trip_id, user_id),
  constraint trip_location_share_lease_consistent check (
    (enabled and share_key is not null and expires_at is not null)
    or (not enabled and share_key is null and expires_at is null)
  )
);
create index trip_location_shares_enabled_idx on public.trip_location_shares (trip_id, user_id) where enabled;
alter table public.trip_location_shares enable row level security;
revoke all privileges on table public.trip_location_shares from public, anon, authenticated;

create function public.get_trip_location_share_states(p_trip_id uuid)
returns table (public_display_name text, is_self boolean, is_sharing boolean, share_key uuid)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
begin
  if v_actor is null or not public.is_trip_participant(p_trip_id) then
    raise exception 'Only accepted trip participants can view sharing status' using errcode = '42501';
  end if;
  return query
    with participants as (
      select t.user_id as member_id from public.trips as t where t.id = p_trip_id
      union
      select r.requester_id from public.ride_requests as r
      where r.trip_id = p_trip_id and r.status = 'accepted'
    )
    select p.display_name, p.id = v_actor,
      coalesce(s.enabled and s.expires_at > statement_timestamp(), false),
      case when s.enabled and s.expires_at > statement_timestamp() then s.share_key else null end
    from participants as member
    join public.profiles as p on p.id = member.member_id
    left join public.trip_location_shares as s on s.trip_id = p_trip_id and s.user_id = p.id
    order by (p.id = v_actor) desc, p.display_name;
end;
$$;
revoke all on function public.get_trip_location_share_states(uuid) from public, anon, authenticated;
grant execute on function public.get_trip_location_share_states(uuid) to authenticated;

-- Opt-in and opt-out lock trip then share row. Trip cancellation/completion
-- takes the same order and atomically disables shares.
create function public.set_trip_location_sharing(p_trip_id uuid, p_enabled boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_trip public.trips%rowtype;
  v_display_name text;
  v_share_key uuid;
begin
  if v_actor is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if p_enabled is null then raise exception 'Sharing choice is required' using errcode = '22023'; end if;
  if not public.is_trip_participant(p_trip_id) then
    raise exception 'Only accepted trip participants can share location' using errcode = '42501';
  end if;
  select t.* into v_trip from public.trips as t where t.id = p_trip_id for update;
  if not found then raise exception 'Trip not found' using errcode = 'P0002'; end if;
  if not public.is_trip_participant(p_trip_id) then
    raise exception 'Only accepted trip participants can share location' using errcode = '42501';
  end if;
  if p_enabled and v_trip.status not in ('open', 'full') then
    raise exception 'Location sharing is unavailable after a trip ends' using errcode = '23514';
  end if;
  select p.display_name into v_display_name from public.profiles as p where p.id = v_actor;
  if p_enabled then
    insert into public.trip_location_shares (trip_id, user_id, share_key, enabled, expires_at, changed_at)
    values (p_trip_id, v_actor, gen_random_uuid(), true, clock_timestamp() + interval '30 seconds', clock_timestamp())
    on conflict (trip_id, user_id) do update
      set share_key = gen_random_uuid(), enabled = true,
        expires_at = clock_timestamp() + interval '30 seconds', changed_at = clock_timestamp()
    returning trip_location_shares.share_key into v_share_key;
  else
    select s.share_key into v_share_key from public.trip_location_shares as s
    where s.trip_id = p_trip_id and s.user_id = v_actor for update;
    update public.trip_location_shares
    set enabled = false, changed_at = clock_timestamp(), expires_at = null, share_key = null
    where trip_id = p_trip_id and user_id = v_actor;
  end if;
  perform realtime.send(
    jsonb_build_object('kind', 'sharing_status', 'display_name', v_display_name,
      'enabled', p_enabled, 'share_key', v_share_key, 'sent_at', clock_timestamp()),
    'location_event', 'trip:' || p_trip_id::text || ':location', true
  );
  if p_enabled then return v_share_key; end if;
  return null;
end;
$$;
revoke all on function public.set_trip_location_sharing(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_trip_location_sharing(uuid, boolean) to authenticated;

-- Every fix is re-authorized in SQL (Realtime channel authorization is cached
-- for a connection). A 3-second database throttle backstops the client throttle.
create function public.broadcast_trip_location(p_trip_id uuid, p_share_key uuid, p_latitude double precision, p_longitude double precision)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_trip_status text;
  v_share public.trip_location_shares%rowtype;
  v_display_name text;
  v_now timestamptz;
begin
  if v_actor is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if p_latitude is null or p_longitude is null
     or p_latitude <> p_latitude or p_longitude <> p_longitude
     or p_latitude not between -90 and 90 or p_longitude not between -180 and 180 then
    raise exception 'Location coordinates are invalid' using errcode = '22023';
  end if;
  if not public.is_trip_participant(p_trip_id) then
    raise exception 'Only accepted trip participants can share location' using errcode = '42501';
  end if;
  -- Keep the same trip-then-share lock order used by opt-in and trip lifecycle
  -- updates so a cancellation serializes cleanly against an in-flight fix.
  select t.status into v_trip_status from public.trips as t where t.id = p_trip_id for update;
  if not found or v_trip_status is distinct from 'open' and v_trip_status is distinct from 'full' then
    raise exception 'Location sharing is unavailable after a trip ends' using errcode = '23514';
  end if;
  select s.* into v_share from public.trip_location_shares as s
  where s.trip_id = p_trip_id and s.user_id = v_actor for update;
  v_now := clock_timestamp();
  if not found or not v_share.enabled or v_share.share_key is distinct from p_share_key
     or v_share.expires_at is null or v_share.expires_at <= v_now then
    raise exception 'Enable location sharing before sending a location' using errcode = '42501';
  end if;
  if v_share.last_broadcast_at is not null
     and v_share.last_broadcast_at > v_now - interval '3 seconds' then
    raise exception 'Location updates are temporarily rate limited' using errcode = 'P0001';
  end if;
  if not public.is_trip_participant(p_trip_id) then
    raise exception 'Only accepted trip participants can share location' using errcode = '42501';
  end if;
  select p.display_name into v_display_name from public.profiles as p where p.id = v_actor;
  update public.trip_location_shares set last_broadcast_at = v_now, expires_at = v_now + interval '30 seconds'
    where trip_id = p_trip_id and user_id = v_actor;
  perform realtime.send(
    jsonb_build_object('kind', 'location', 'display_name', v_display_name, 'share_key', p_share_key,
      'latitude', p_latitude, 'longitude', p_longitude, 'sent_at', v_now),
    'location_event', 'trip:' || p_trip_id::text || ':location', true
  );
end;
$$;
revoke all on function public.broadcast_trip_location(uuid, uuid, double precision, double precision) from public, anon, authenticated;
grant execute on function public.broadcast_trip_location(uuid, uuid, double precision, double precision) to authenticated;

-- Lifecycle transitions stop all participants' opt-in in the same transaction.
create function public.stop_trip_location_sharing_on_terminal()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('cancelled', 'completed') and old.status is distinct from new.status then
    update public.trip_location_shares
    set enabled = false, share_key = null, expires_at = null, changed_at = clock_timestamp()
    where trip_id = new.id and enabled;
    perform realtime.send(jsonb_build_object('kind', 'trip_ended', 'sent_at', clock_timestamp()),
      'location_event', 'trip:' || new.id::text || ':location', true);
  end if;
  return new;
end;
$$;
revoke all on function public.stop_trip_location_sharing_on_terminal() from public, anon, authenticated;
create trigger trips_stop_live_shares_on_terminal after update of status on public.trips
for each row execute function public.stop_trip_location_sharing_on_terminal();

-- Private Realtime reads are restricted to participant-only, exact trip topics.
-- Supabase owns realtime.messages; only a policy is added, not table changes.
create function public.can_read_trip_realtime_topic(p_topic text, p_extension text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_match text[];
  v_trip_status text;
begin
  if p_extension is distinct from 'broadcast' then return false; end if;
  v_match := regexp_match(p_topic, '^trip:([0-9a-fA-F-]{36}):(chat|location)$');
  if v_match is null then return false; end if;
  if v_match[2] = 'location' then
    select t.status into v_trip_status from public.trips as t where t.id = v_match[1]::uuid;
    if v_trip_status is distinct from 'open' and v_trip_status is distinct from 'full' then
      return false;
    end if;
  end if;
  return public.is_trip_participant(v_match[1]::uuid);
exception when invalid_text_representation then
  return false;
end;
$$;
revoke all on function public.can_read_trip_realtime_topic(text, text) from public, anon, authenticated;
grant execute on function public.can_read_trip_realtime_topic(text, text) to authenticated;

drop policy if exists "RouteMates participants read private trip channels" on realtime.messages;
create policy "RouteMates participants read private trip channels"
  on realtime.messages for select to authenticated
  using (public.can_read_trip_realtime_topic(realtime.topic(), realtime.messages.extension));
-- No authenticated INSERT policy is granted on realtime.messages. Live location
-- sends must pass broadcast_trip_location's per-message opt-in check.

-- No publication/table replication change is required: chat notifications and
-- location fixes use private Realtime Broadcast, and message data stays behind
-- the table RLS policy and participant-checked history function.
