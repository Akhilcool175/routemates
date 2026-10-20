-- RouteMates initial schema. Review this migration before applying it.
-- This file is not executed by the app or build.

-- Tables ----------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 1 and 80),
  campus text check (campus is null or char_length(campus) <= 120),
  created_at timestamptz not null default now()
);
comment on column public.profiles.display_name is
  'Self-reported, unverified public display name; it is not proof of identity.';

create table public.trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  pickup_label text not null check (char_length(trim(pickup_label)) between 1 and 200),
  destination_label text not null check (char_length(trim(destination_label)) between 1 and 200),
  departure_at timestamptz not null,
  -- Remaining unclaimed seats, initialized to the host's posted amount and
  -- decremented once per accepted request. Zero remaining seats means full.
  seats_available smallint not null check (seats_available between 0 and 4),
  estimated_fare_per_person numeric(10, 2) not null
    check (estimated_fare_per_person >= 0 and estimated_fare_per_person <> 'NaN'::numeric),
  note text check (note is null or char_length(note) <= 500),
  status text not null default 'open'
    check (status in ('open', 'full', 'cancelled', 'completed')),
  constraint trips_distinct_locations check (lower(trim(pickup_label)) <> lower(trim(destination_label))),
  constraint trips_open_full_capacity_consistency check (
    (status = 'open' and seats_available > 0)
    or (status = 'full' and seats_available = 0)
    or status in ('cancelled', 'completed')
  ),
  created_at timestamptz not null default now()
);

create table public.ride_requests (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  requester_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  message text check (message is null or char_length(message) <= 500),
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at timestamptz not null default now(),
  constraint ride_requests_one_per_rider unique (trip_id, requester_id)
);

create index trips_open_departure_idx on public.trips (departure_at)
  where status = 'open' and seats_available > 0;
create index trips_user_id_idx on public.trips (user_id);
create index ride_requests_requester_id_idx on public.ride_requests (requester_id);
create index ride_requests_trip_id_idx on public.ride_requests (trip_id);

-- Auth profile creation and trip validation -----------------------------------
-- Auth creates a profile from the new auth.users row. The function takes no
-- caller-supplied ID. Metadata is user-supplied: public display names are
-- self-reported and unverified. Campus remains private under profile RLS.
create function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name, campus)
  values (
    new.id,
    coalesce(nullif(left(trim(new.raw_user_meta_data ->> 'display_name'), 80), ''), 'RouteMates member'),
    nullif(left(trim(new.raw_user_meta_data ->> 'campus'), 120), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
revoke all on function public.handle_new_auth_user() from public, anon, authenticated;

create trigger on_auth_user_created_create_profile
after insert on auth.users for each row
execute function public.handle_new_auth_user();

-- Backfill auth accounts that predate this migration; Auth remains the source
-- of profile IDs. Existing profile rows are left untouched.
insert into public.profiles (id, display_name, campus)
select u.id,
       coalesce(nullif(left(trim(u.raw_user_meta_data ->> 'display_name'), 80), ''), 'RouteMates member'),
       nullif(left(trim(u.raw_user_meta_data ->> 'campus'), 120), '')
from auth.users as u
on conflict (id) do nothing;

-- New trips and changed departures must use finite future departures. Hosts
-- cannot reopen terminal trips; only the RPCs below may cancel or complete.
create function public.validate_trip_write()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_now timestamptz;
begin
  if tg_op = 'INSERT' then
    if new.seats_available not between 1 and 4 then
      raise exception 'A new trip must start with between one and four available seats' using errcode = '23514';
    end if;
    v_now := clock_timestamp();
    if new.departure_at <= '-infinity'::timestamptz
       or new.departure_at >= 'infinity'::timestamptz
       or new.departure_at <= v_now then
      raise exception 'Trip departure must be a finite future time' using errcode = '22007';
    end if;
  elsif tg_op = 'UPDATE' then
    if new.departure_at is distinct from old.departure_at then
      v_now := clock_timestamp();
      if new.departure_at <= '-infinity'::timestamptz
         or new.departure_at >= 'infinity'::timestamptz
         or new.departure_at <= v_now then
        raise exception 'Trip departure must be a finite future time' using errcode = '22007';
      end if;
    end if;

    if new.status is distinct from old.status then
      if old.status = 'open' and new.status = 'full' and new.seats_available = 0 then
        -- Only capacity acceptance should normally perform this transition.
        null;
      elsif old.status in ('open', 'full') and new.status = 'cancelled' then
        -- Cancellation is terminal and does not erase accepted request history.
        null;
      elsif old.status in ('open', 'full') and new.status = 'completed' then
        v_now := clock_timestamp();
        if new.departure_at <= '-infinity'::timestamptz
           or new.departure_at >= 'infinity'::timestamptz
           or new.departure_at > v_now then
          raise exception 'A trip can be completed only after its finite departure time' using errcode = '23514';
        end if;
      else
        raise exception 'Invalid trip status transition from % to %', old.status, new.status using errcode = '23514';
      end if;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.validate_trip_write() from public, anon, authenticated;

create trigger trips_validate_write
before insert or update of departure_at, status on public.trips
for each row execute function public.validate_trip_write();

-- Request insertion locks and rechecks the trip so cancellation cannot race a
-- stale RLS snapshot into creating a request on a cancelled or expired trip.
create function public.validate_ride_request_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_trip public.trips%rowtype;
  v_now timestamptz;
begin
  if v_actor is null or new.requester_id <> v_actor then
    raise exception 'Request identity must match the authenticated user' using errcode = '42501';
  end if;

  select t.* into v_trip
  from public.trips as t
  where t.id = new.trip_id
  for update;
  if not found then
    raise exception 'Trip not found' using errcode = 'P0002';
  end if;
  if v_trip.user_id = v_actor then
    raise exception 'Hosts cannot request their own trips' using errcode = '42501';
  end if;

  v_now := clock_timestamp();
  if v_trip.status <> 'open' or v_trip.seats_available < 1
     or v_trip.departure_at <= '-infinity'::timestamptz
     or v_trip.departure_at >= 'infinity'::timestamptz
     or v_trip.departure_at <= v_now then
    raise exception 'Requests require an open trip with seats and a future departure' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.validate_ride_request_insert() from public, anon, authenticated;

create trigger ride_requests_validate_insert
before insert on public.ride_requests
for each row execute function public.validate_ride_request_insert();

-- Auth account deletion may cascade through profiles to ride_requests. Keep an
-- accepted request as trip history so deleting a rider cannot erase the record
-- for a seat that has already been consumed. This guard intentionally blocks
-- that account deletion; the schema has no safe anonymized-history mechanism.
create function public.prevent_accepted_request_delete()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'accepted' then
    raise exception 'Rider accounts with accepted ride history cannot be deleted' using errcode = '23514';
  end if;
  return old;
end;
$$;
revoke all on function public.prevent_accepted_request_delete() from public, anon, authenticated;

create trigger ride_requests_prevent_accepted_delete
before delete on public.ride_requests
for each row execute function public.prevent_accepted_request_delete();

-- Backstop for privileged/auth-cascade deletion. Lock request rows in the same
-- trip-then-request order used by acceptance before checking accepted history.
create function public.prevent_trip_delete_with_accepted_requests()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_request_status text;
begin
  for v_request_status in
    select r.status
    from public.ride_requests as r
    where r.trip_id = old.id
    order by r.id
    for update
  loop
    if v_request_status = 'accepted' then
      raise exception 'Trips with accepted riders cannot be deleted; cancel the trip instead' using errcode = '23514';
    end if;
  end loop;
  return old;
end;
$$;
revoke all on function public.prevent_trip_delete_with_accepted_requests() from public, anon, authenticated;

create trigger trips_prevent_delete_with_accepted_requests
before delete on public.trips
for each row execute function public.prevent_trip_delete_with_accepted_requests();

-- RLS -------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.trips enable row level security;
alter table public.ride_requests enable row level security;

-- A member reads and edits only their own full profile. No client insert/delete:
-- Auth creates profiles. Deleting a host with accepted trip history or a rider
-- with accepted request history is blocked so the seat/accounting history stays.
create policy "Members read their own profile"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy "Members update their own profile"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- SECURITY DEFINER ownership predicate is needed by cross-table policies without
-- granting the API access to trips.user_id.
create function public.is_trip_owner(p_trip_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null
    and exists (
      select 1 from public.trips as t
      where t.id = p_trip_id and t.user_id = (select auth.uid())
    );
$$;
revoke all on function public.is_trip_owner(uuid) from public, anon, authenticated;
grant execute on function public.is_trip_owner(uuid) to authenticated;

-- Signed-in members discover only future open trips with seats left; owners also
-- see their own trips in any status. The function hides the private owner ID.
create policy "Members read discoverable trips and their own trips"
  on public.trips for select to authenticated
  using (
    (status = 'open' and seats_available > 0
      and departure_at > '-infinity'::timestamptz
      and departure_at < 'infinity'::timestamptz
      and departure_at > statement_timestamp())
    or public.is_trip_owner(id)
  );
create policy "Members create their own trips"
  on public.trips for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "Owners update their own trips"
  on public.trips for update to authenticated
  using (public.is_trip_owner(id))
  with check (user_id = (select auth.uid()));
-- Requesters and hosts can read their relevant requests. No direct update or
-- delete policy: request and trip state transitions are available only through
-- the guarded RPCs below.
create policy "Requesters and trip owners read requests"
  on public.ride_requests for select to authenticated
  using (
    requester_id = (select auth.uid())
    or exists (
      select 1 from public.trips as t
      where t.id = ride_requests.trip_id and public.is_trip_owner(t.id)
    )
  );
create policy "Members request open trips as themselves"
  on public.ride_requests for insert to authenticated
  with check (
    requester_id = (select auth.uid())
    and exists (
      select 1 from public.trips as t
      where t.id = ride_requests.trip_id
        and t.status = 'open'
        and t.seats_available > 0
        and t.departure_at > '-infinity'::timestamptz
        and t.departure_at < 'infinity'::timestamptz
        and t.departure_at > statement_timestamp()
        and not public.is_trip_owner(t.id)
    )
  );

-- Narrow public-name lookups ---------------------------------------------------
-- trips.user_id and profiles rows are not exposed by discovery. This RPC returns
-- only self-reported, unverified names for future open trips with seats left.
create function public.get_open_trip_host_names(p_trip_ids uuid[])
returns table (trip_id uuid, public_display_name text)
language sql stable security definer set search_path = '' as $$
  select t.id, p.display_name
  from public.trips as t join public.profiles as p on p.id = t.user_id
  where (select auth.uid()) is not null
    and t.id = any(coalesce(p_trip_ids, array[]::uuid[]))
    and t.status = 'open' and t.seats_available > 0
    and t.departure_at > '-infinity'::timestamptz
    and t.departure_at < 'infinity'::timestamptz
    and t.departure_at > statement_timestamp();
$$;
revoke all on function public.get_open_trip_host_names(uuid[]) from public, anon, authenticated;
grant execute on function public.get_open_trip_host_names(uuid[]) to authenticated;

-- Hosts can resolve only the public display names for requesters on trips they
-- own. Requester UUIDs are not included in the result.
create function public.get_ride_requester_names(p_request_ids uuid[])
returns table (request_id uuid, public_display_name text)
language sql stable security definer set search_path = '' as $$
  select r.id, p.display_name
  from public.ride_requests as r
  join public.trips as t on t.id = r.trip_id
  join public.profiles as p on p.id = r.requester_id
  where (select auth.uid()) is not null
    and r.id = any(coalesce(p_request_ids, array[]::uuid[]))
    and t.user_id = (select auth.uid());
$$;
revoke all on function public.get_ride_requester_names(uuid[]) from public, anon, authenticated;
grant execute on function public.get_ride_requester_names(uuid[]) to authenticated;

-- Hosts cancel trips through this row lock, which serializes against acceptance.
-- Existing accepted requests remain accepted as history; the cancelled trip
-- must be shown as cancelled, and no new request can be accepted for it.
create function public.cancel_trip(p_trip_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_trip public.trips%rowtype;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select t.* into v_trip
  from public.trips as t
  where t.id = p_trip_id
  for update;
  if not found then
    raise exception 'Trip not found' using errcode = 'P0002';
  end if;
  if v_trip.user_id <> v_actor then
    raise exception 'Only the trip host can cancel it' using errcode = '42501';
  end if;
  if v_trip.status not in ('open', 'full') then
    raise exception 'Only open or full trips can be cancelled' using errcode = '23514';
  end if;

  update public.trips set status = 'cancelled' where id = v_trip.id;
  return 'cancelled';
end;
$$;
revoke all on function public.cancel_trip(uuid) from public, anon, authenticated;
grant execute on function public.cancel_trip(uuid) to authenticated;

-- Completion is terminal and is allowed only after a finite departure time.
create function public.complete_trip(p_trip_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_trip public.trips%rowtype;
  v_now timestamptz;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select t.* into v_trip
  from public.trips as t
  where t.id = p_trip_id
  for update;
  if not found then
    raise exception 'Trip not found' using errcode = 'P0002';
  end if;
  if v_trip.user_id <> v_actor then
    raise exception 'Only the trip host can complete it' using errcode = '42501';
  end if;
  if v_trip.status not in ('open', 'full') then
    raise exception 'Only open or full trips can be completed' using errcode = '23514';
  end if;

  v_now := clock_timestamp();
  if v_trip.departure_at <= '-infinity'::timestamptz
     or v_trip.departure_at >= 'infinity'::timestamptz
     or v_trip.departure_at > v_now then
    raise exception 'A trip can be completed only after its finite departure time' using errcode = '23514';
  end if;

  update public.trips set status = 'completed' where id = v_trip.id;
  return 'completed';
end;
$$;
revoke all on function public.complete_trip(uuid) from public, anon, authenticated;
grant execute on function public.complete_trip(uuid) to authenticated;

-- Request cancellation and host decision -------------------------------------
-- Requesters may cancel only their own pending request. The row lock serializes
-- a cancellation against a host decision.
create function public.cancel_ride_request(p_request_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_request public.ride_requests%rowtype;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  select r.* into v_request from public.ride_requests as r
  where r.id = p_request_id for update;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if v_request.requester_id <> v_actor then
    raise exception 'Only the requester can cancel this request' using errcode = '42501';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'Only pending requests can be cancelled' using errcode = '23514';
  end if;
  update public.ride_requests set status = 'cancelled' where id = p_request_id;
  return 'cancelled';
end;
$$;
revoke all on function public.cancel_ride_request(uuid) from public, anon, authenticated;
grant execute on function public.cancel_ride_request(uuid) to authenticated;

-- Host accept/decline RPC. Lock trip then request, matching cancellation and
-- request insertion. Acceptance revalidates after the locks and atomically
-- consumes one remaining seat; the final seat sets status to full.
create function public.respond_to_ride_request(p_request_id uuid, p_decision text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_trip_id uuid;
  v_request public.ride_requests%rowtype;
  v_trip public.trips%rowtype;
  v_now timestamptz;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_decision is null or p_decision not in ('accepted', 'declined') then
    raise exception 'Decision must be accepted or declined' using errcode = '22023';
  end if;

  -- Read the immutable trip reference first, then use a consistent trip-first
  -- lock order shared with cancellation and the request-insert trigger.
  select r.trip_id into v_trip_id
  from public.ride_requests as r
  where r.id = p_request_id;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;

  select t.* into v_trip
  from public.trips as t
  where t.id = v_trip_id
  for update;
  if not found then
    raise exception 'Trip not found' using errcode = 'P0002';
  end if;
  if v_trip.user_id <> v_actor then
    raise exception 'Only the trip host can decide this request' using errcode = '42501';
  end if;

  select r.* into v_request
  from public.ride_requests as r
  where r.id = p_request_id and r.trip_id = v_trip.id
  for update;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'Only pending requests can be decided' using errcode = '23514';
  end if;

  if p_decision = 'accepted' then
    v_now := clock_timestamp();
    if v_trip.status <> 'open'
       or v_trip.departure_at <= '-infinity'::timestamptz
       or v_trip.departure_at >= 'infinity'::timestamptz
       or v_trip.departure_at <= v_now then
      raise exception 'Only open trips with a future departure can accept requests' using errcode = '23514';
    end if;
    if v_trip.seats_available < 1 then
      raise exception 'No seats remain on this trip' using errcode = '23514';
    end if;
    update public.trips
    set seats_available = v_trip.seats_available - 1,
        status = case when v_trip.seats_available = 1 then 'full' else 'open' end
    where id = v_trip.id;
  end if;

  update public.ride_requests set status = p_decision where id = p_request_id;
  return p_decision;
end;
$$;
revoke all on function public.respond_to_ride_request(uuid, text) from public, anon, authenticated;
grant execute on function public.respond_to_ride_request(uuid, text) to authenticated;

-- Explicit API privileges ------------------------------------------------------
-- Auth schema grants and service_role grants are left intact. API roles cannot
-- create public objects. RLS further narrows all authenticated row access.
revoke create on schema public from public, anon, authenticated;
grant usage on schema public to authenticated;

revoke all privileges on table public.profiles, public.trips, public.ride_requests
  from public, anon, authenticated;

-- Profile rows/fields: owner-only SELECT; users may edit only display_name/campus.
grant select on table public.profiles to authenticated;
grant update (display_name, campus) on table public.profiles to authenticated;

-- Trips: omit user_id, seats_available, and status from client writes. Ownership
-- defaults from auth.uid(); seat/status transitions use guarded RPCs. There is
-- no client DELETE grant or DELETE policy: hosts cancel trips through cancel_trip.
grant select (
  id, pickup_label, destination_label, departure_at, seats_available,
  estimated_fare_per_person, note, status, created_at
) on table public.trips to authenticated;
grant insert (
  pickup_label, destination_label, departure_at, seats_available,
  estimated_fare_per_person, note
) on table public.trips to authenticated;
grant update (
  pickup_label, destination_label, departure_at,
  estimated_fare_per_person, note
) on table public.trips to authenticated;

-- Requester IDs/status cannot be supplied on insert or edited directly;
-- request transitions are RPC-only. No direct DELETE privilege is granted.
grant select (id, trip_id, message, status, created_at)
  on table public.ride_requests to authenticated;
grant insert (trip_id, message)
  on table public.ride_requests to authenticated;
