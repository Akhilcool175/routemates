-- Additive live-location cleanup. Review and apply manually after the existing
-- 20261019000100 location-sharing migration; this file has not been executed.
-- Coordinates remain outside RouteMates tables. Expired leases lose their
-- opaque key and broadcast timestamp when a participant next reads share state.

create or replace function public.get_trip_location_share_states(p_trip_id uuid)
returns table (public_display_name text, is_self boolean, is_sharing boolean, share_key uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_expired record;
  v_display_name text;
begin
  if v_actor is null or not public.is_trip_participant(p_trip_id) then
    raise exception 'Only accepted trip participants can view sharing status' using errcode = '42501';
  end if;

  -- Clear expired opt-in metadata lazily when a participant opens or refreshes
  -- the accepted trip. This update never waits on a trip lock, so it cannot form
  -- a reverse lock order with opt-in, broadcast, cancellation, or completion.
  for v_expired in
    update public.trip_location_shares
    set enabled = false, share_key = null, last_broadcast_at = null,
      expires_at = null, changed_at = clock_timestamp()
    where trip_id = p_trip_id and enabled and expires_at <= clock_timestamp()
    returning user_id, share_key
  loop
    select p.display_name into v_display_name
    from public.profiles as p where p.id = v_expired.user_id;
    perform realtime.send(
      jsonb_build_object('kind', 'sharing_status', 'display_name', v_display_name,
        'enabled', false, 'share_key', v_expired.share_key, 'sent_at', clock_timestamp()),
      'location_event', 'trip:' || p_trip_id::text || ':location', true
    );
  end loop;

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

create or replace function public.set_trip_location_sharing(p_trip_id uuid, p_enabled boolean)
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
      set share_key = gen_random_uuid(), enabled = true, last_broadcast_at = null,
        expires_at = clock_timestamp() + interval '30 seconds', changed_at = clock_timestamp()
    returning trip_location_shares.share_key into v_share_key;
  else
    select s.share_key into v_share_key from public.trip_location_shares as s
    where s.trip_id = p_trip_id and s.user_id = v_actor for update;
    update public.trip_location_shares
    set enabled = false, last_broadcast_at = null, changed_at = clock_timestamp(),
      expires_at = null, share_key = null
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

create or replace function public.stop_trip_location_sharing_on_terminal()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('cancelled', 'completed') and old.status is distinct from new.status then
    update public.trip_location_shares
    set enabled = false, share_key = null, last_broadcast_at = null,
      expires_at = null, changed_at = clock_timestamp()
    where trip_id = new.id and enabled;
    perform realtime.send(jsonb_build_object('kind', 'trip_ended', 'sent_at', clock_timestamp()),
      'location_event', 'trip:' || new.id::text || ':location', true);
  end if;
  return new;
end;
$$;
revoke all on function public.stop_trip_location_sharing_on_terminal() from public, anon, authenticated;

-- State RPCs remain callable only by authenticated users; the trigger function
-- is not directly executable by API roles. No table grants, policies, channels,
-- or coordinate columns are added here.
