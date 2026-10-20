-- Replace coordinate-bearing Database Broadcast with an authenticated Edge
-- Function -> private Realtime HTTP Broadcast relay. This is additive: earlier
-- applied migrations remain unchanged. Review and apply manually.

-- Supabase owns realtime.messages and already enables RLS there. Preserve the
-- existing participant-scoped SELECT policy; add a restrictive deny rule so
-- even another permissive INSERT policy cannot let browser clients publish.
-- Do not alter table grants or ownership on this Supabase-managed relation.
drop policy if exists "RouteMates clients cannot publish broadcasts" on realtime.messages;
create policy "RouteMates clients cannot publish broadcasts"
  on realtime.messages as restrictive for insert to anon, authenticated
  with check (false);

-- The previous RPC inserts coordinate payloads into realtime.messages.
-- Leave its definition for migration history, but make it unavailable to API
-- roles, including the Edge Function's service role.
revoke all on function public.broadcast_trip_location(uuid, uuid, double precision, double precision)
  from public, anon, authenticated, service_role;

-- Coordinates never enter this RPC. The actor ID comes only from verified JWT
-- claims inside the Edge Function; this function is callable only by service_role.
create or replace function public.authorize_trip_location_relay(
  p_actor_id uuid,
  p_trip_id uuid,
  p_share_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trip_status text;
  v_host_id uuid;
  v_share public.trip_location_shares%rowtype;
  v_display_name text;
  v_now timestamptz;
begin
  if p_actor_id is null or p_trip_id is null or p_share_key is null then
    raise exception 'Location sharing is not authorized' using errcode = '42501';
  end if;

  -- Match the lock order used by sharing-state and trip lifecycle functions.
  select t.status, t.user_id into v_trip_status, v_host_id
  from public.trips as t where t.id = p_trip_id for update;
  if not found or v_trip_status is distinct from 'open' and v_trip_status is distinct from 'full' then
    raise exception 'Location sharing is unavailable for this trip' using errcode = '42501';
  end if;

  if p_actor_id is distinct from v_host_id and not exists (
    select 1 from public.ride_requests as r
    where r.trip_id = p_trip_id and r.requester_id = p_actor_id and r.status = 'accepted'
  ) then
    raise exception 'Location sharing is not authorized' using errcode = '42501';
  end if;

  select s.* into v_share
  from public.trip_location_shares as s
  where s.trip_id = p_trip_id and s.user_id = p_actor_id
  for update;
  v_now := clock_timestamp();
  if not found or not v_share.enabled
     or v_share.share_key is distinct from p_share_key
     or v_share.expires_at is null
     or v_share.expires_at <= '-infinity'::timestamptz
     or v_share.expires_at >= 'infinity'::timestamptz
     or v_share.expires_at <= v_now then
    raise exception 'Location sharing is no longer active for this account' using errcode = '42501';
  end if;

  if v_share.last_broadcast_at is not null
     and (v_share.last_broadcast_at >= 'infinity'::timestamptz
       or (v_share.last_broadcast_at > '-infinity'::timestamptz
         and v_share.last_broadcast_at > v_now - interval '3 seconds')) then
    raise exception 'Location updates are temporarily rate limited' using errcode = 'P0001';
  end if;

  select p.display_name into v_display_name
  from public.profiles as p where p.id = p_actor_id;
  if not found or v_display_name is null or char_length(trim(v_display_name)) = 0 then
    raise exception 'A RouteMates profile is required to share location' using errcode = '42501';
  end if;

  -- Short lease: a crashed or offline browser cannot leave a valid share key
  -- indefinitely. The coordinates themselves are never passed to PostgreSQL.
  update public.trip_location_shares
  set last_broadcast_at = v_now,
    expires_at = v_now + interval '30 seconds'
  where trip_id = p_trip_id and user_id = p_actor_id;

  return jsonb_build_object('display_name', v_display_name, 'sent_at', v_now);
end;
$$;
revoke all on function public.authorize_trip_location_relay(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.authorize_trip_location_relay(uuid, uuid, uuid) to service_role;

-- State reads disclose only accepted members' display names and opt-in status.
-- A key is useful only together with the matching authenticated actor's own
-- database row, which the server-only authorization function checks.
create or replace function public.get_trip_location_share_states(p_trip_id uuid)
returns table (public_display_name text, is_self boolean, is_sharing boolean, share_key uuid)
language plpgsql
security definer
set search_path = ''
as $$
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
      coalesce(s.enabled and s.expires_at > statement_timestamp()
        and s.expires_at > '-infinity'::timestamptz
        and s.expires_at < 'infinity'::timestamptz, false),
      case when s.enabled and s.expires_at > statement_timestamp()
        and s.expires_at > '-infinity'::timestamptz
        and s.expires_at < 'infinity'::timestamptz then s.share_key else null end
    from participants as member
    join public.profiles as p on p.id = member.member_id
    left join public.trip_location_shares as s on s.trip_id = p_trip_id and s.user_id = p.id
    order by (p.id = v_actor) desc, p.display_name;
end;
$$;
revoke all on function public.get_trip_location_share_states(uuid) from public, anon, authenticated;
grant execute on function public.get_trip_location_share_states(uuid) to authenticated;

-- Explicit opt-in/out remains an authenticated operation. Stop and replacement
-- emit the old key before deleting/replacing it, so listeners remove the right
-- marker. These events contain no coordinates.
create or replace function public.set_trip_location_sharing(p_trip_id uuid, p_enabled boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_trip public.trips%rowtype;
  v_display_name text;
  v_old_key uuid;
  v_share_key uuid;
begin
  if v_actor is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if p_trip_id is null or p_enabled is null then
    raise exception 'Trip and sharing choice are required' using errcode = '22023';
  end if;
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
  if not found then raise exception 'A RouteMates profile is required' using errcode = '23514'; end if;

  select s.share_key into v_old_key from public.trip_location_shares as s
  where s.trip_id = p_trip_id and s.user_id = v_actor for update;

  if p_enabled then
    insert into public.trip_location_shares
      (trip_id, user_id, share_key, enabled, last_broadcast_at, expires_at, changed_at)
    values
      (p_trip_id, v_actor, gen_random_uuid(), true, null,
        clock_timestamp() + interval '30 seconds', clock_timestamp())
    on conflict (trip_id, user_id) do update
      set share_key = gen_random_uuid(), enabled = true, last_broadcast_at = null,
        expires_at = clock_timestamp() + interval '30 seconds', changed_at = clock_timestamp()
    returning trip_location_shares.share_key into v_share_key;

    if v_old_key is not null and v_old_key is distinct from v_share_key then
      begin
        perform realtime.send(
          jsonb_build_object('kind', 'sharing_status', 'display_name', v_display_name,
            'enabled', false, 'share_key', v_old_key, 'sent_at', clock_timestamp()),
          'location_event', 'trip:' || p_trip_id::text || ':location', true
        );
      exception when others then
        null; -- Key rotation is committed even if Realtime cannot deliver the optional notice.
      end;
    end if;
  else
    delete from public.trip_location_shares
    where trip_id = p_trip_id and user_id = v_actor;
  end if;

  if v_old_key is not null then
    begin
      perform realtime.send(
        jsonb_build_object('kind', 'sharing_status', 'display_name', v_display_name,
          'enabled', p_enabled, 'share_key', case when p_enabled then v_share_key else v_old_key end,
          'sent_at', clock_timestamp()),
        'location_event', 'trip:' || p_trip_id::text || ':location', true
      );
    exception when others then
      null; -- Database state is authoritative; clients also refresh sharing status.
    end;
  elsif p_enabled then
    begin
      perform realtime.send(
        jsonb_build_object('kind', 'sharing_status', 'display_name', v_display_name,
          'enabled', true, 'share_key', v_share_key, 'sent_at', clock_timestamp()),
        'location_event', 'trip:' || p_trip_id::text || ':location', true
      );
    exception when others then
      null; -- Database state is authoritative; clients also refresh sharing status.
    end;
  end if;

  if p_enabled then return v_share_key; end if;
  return null;
end;
$$;
revoke all on function public.set_trip_location_sharing(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_trip_location_sharing(uuid, boolean) to authenticated;

-- Trip termination follows the same trip-then-share lock order. Revoke events
-- are emitted with the prior key, then all ephemeral state for that trip is
-- removed. trip_ended contains no participant identity or coordinates.
create or replace function public.stop_trip_location_sharing_on_terminal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_share record;
begin
  if new.status in ('cancelled', 'completed') and old.status is distinct from new.status then
    for v_share in
      select s.user_id, s.share_key, p.display_name
      from public.trip_location_shares as s
      left join public.profiles as p on p.id = s.user_id
      where s.trip_id = new.id and s.enabled
      order by s.user_id
      for update of s
    loop
      if v_share.share_key is not null then
        begin
          perform realtime.send(
            jsonb_build_object('kind', 'sharing_status', 'display_name', v_share.display_name,
              'enabled', false, 'share_key', v_share.share_key, 'sent_at', clock_timestamp()),
            'location_event', 'trip:' || new.id::text || ':location', true
          );
        exception when others then
          null; -- Cancellation/completion must still commit if Realtime is unavailable.
        end;
      end if;
    end loop;

    delete from public.trip_location_shares where trip_id = new.id;
    begin
      perform realtime.send(
        jsonb_build_object('kind', 'trip_ended', 'sent_at', clock_timestamp()),
        'location_event', 'trip:' || new.id::text || ':location', true
      );
    exception when others then
      null; -- Trip state and share deletion are authoritative; markers age out locally.
    end;
  end if;
  return new;
end;
$$;
revoke all on function public.stop_trip_location_sharing_on_terminal() from public, anon, authenticated, service_role;

-- Reliable cleanup primitive for an every-minute pg_cron job. It removes
-- expired/invalid enabled shares and all disabled rows, including legacy rows
-- with stale last_broadcast_at metadata. Clients poll status and expire markers
-- locally, so cleanup does not depend on a Realtime message partition existing.
-- It never takes a trip lock, avoiding reverse lock order against cancellation
-- and location authorization.
create or replace function public.cleanup_trip_location_shares()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_share record;
  v_now timestamptz := clock_timestamp();
  v_deleted integer := 0;
begin
  for v_share in
    select s.trip_id, s.user_id
    from public.trip_location_shares as s
    where not s.enabled or s.expires_at is null
      or s.expires_at <= v_now
      or s.expires_at <= '-infinity'::timestamptz
      or s.expires_at >= 'infinity'::timestamptz
    order by s.trip_id, s.user_id
    for update of s skip locked
  loop
    delete from public.trip_location_shares
    where trip_id = v_share.trip_id and user_id = v_share.user_id;
    v_deleted := v_deleted + 1;
  end loop;
  return v_deleted;
end;
$$;
revoke all on function public.cleanup_trip_location_shares() from public, anon, authenticated, service_role;
grant execute on function public.cleanup_trip_location_shares() to service_role;

-- The upgrade invalidates all prior share keys. Keep each old key available for
-- a best-effort matching revocation event before deleting its row. These events
-- contain no coordinates; if Realtime has no message partition, clients still
-- remove stale points through the 60-second local expiry and status refresh.
do $$
declare
  v_share record;
begin
  for v_share in
    select s.trip_id, s.share_key, p.display_name
    from public.trip_location_shares as s
    left join public.profiles as p on p.id = s.user_id
    where s.enabled and s.share_key is not null
  loop
    begin
      perform realtime.send(
        jsonb_build_object('kind', 'sharing_status', 'display_name', v_share.display_name,
          'enabled', false, 'share_key', v_share.share_key, 'sent_at', clock_timestamp()),
        'location_event', 'trip:' || v_share.trip_id::text || ':location', true
      );
    exception when others then
      null; -- Migration state is authoritative; existing clients also expire markers locally.
    end;
  end loop;
end;
$$;

-- Clear old keys and disabled legacy metadata, including stale timestamps.
-- Existing realtime.messages history is governed by Supabase retention and is
-- not rewritten by this migration.
delete from public.trip_location_shares;

-- No client INSERT policy or table grant is added for realtime.messages.
-- Supabase Realtime settings must keep "Allow public access" disabled.
