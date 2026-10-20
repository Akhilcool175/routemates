import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../migrations/20261018000100_create_routemates_tables.sql', import.meta.url);
const migration = await readFile(migrationUrl, 'utf8');
const clientSource = await readFile(new URL('../../src/lib/supabase.ts', import.meta.url), 'utf8');
const ignoreRules = await readFile(new URL('../../.gitignore', import.meta.url), 'utf8');

function functionSource(name) {
  const start = migration.search(new RegExp(`create function public\\.${name}\\s*\\(`, 'i'));
  assert.notEqual(start, -1, `migration defines public.${name}`);
  const end = migration.indexOf('$$;', start);
  assert.notEqual(end, -1, `public.${name} has a dollar-quoted function body`);
  return migration.slice(start, end + 3);
}

test('ride requests have a database-enforced duplicate guard', () => {
  assert.match(migration, /constraint ride_requests_one_per_rider unique\s*\(trip_id,\s*requester_id\)/i);
});

test('new requests are tied to auth.uid() and lock/revalidate the trip', () => {
  const insertGuard = functionSource('validate_ride_request_insert');
  assert.match(insertGuard, /new\.requester_id\s*<>\s*v_actor/i);
  assert.match(insertGuard, /where t\.id = new\.trip_id[\s\S]*?for update/i);
  assert.match(insertGuard, /v_trip\.status\s*<>\s*'open'/i);
  assert.match(insertGuard, /v_trip\.seats_available\s*<\s*1/i);
  assert.match(insertGuard, /departure_at\s*<=\s*v_now/i);
  assert.match(migration, /before insert on public\.ride_requests[\s\S]*?execute function public\.validate_ride_request_insert/i);
});

test('host decisions lock trip before request and accept only pending requests', () => {
  const decision = functionSource('respond_to_ride_request');
  const tripLock = decision.search(/from public\.trips as t\s+where t\.id = v_trip_id\s+for update;/i);
  const requestLock = decision.search(/from public\.ride_requests as r\s+where r\.id = p_request_id and r\.trip_id = v_trip\.id\s+for update;/i);
  assert.notEqual(tripLock, -1, 'trip row is locked');
  assert.notEqual(requestLock, -1, 'request row is locked');
  assert.ok(tripLock < requestLock, 'trip lock precedes request lock');
  assert.match(decision, /v_trip\.user_id\s*<>\s*v_actor/i);
  assert.match(decision, /v_request\.status\s*<>\s*'pending'/i);
  assert.match(decision, /p_decision\s+not in\s*\('accepted',\s*'declined'\)/i);
  const timeRecheck = decision.indexOf('v_now := clock_timestamp()');
  assert.ok(requestLock < timeRecheck, 'acceptance rechecks the clock after both locks');
});

test('requesters can cancel only their own pending request', () => {
  const cancel = functionSource('cancel_ride_request');
  assert.match(cancel, /v_request\.requester_id\s*<>\s*v_actor/i);
  assert.match(cancel, /v_request\.status\s*<>\s*'pending'/i);
  assert.match(cancel, /update public\.ride_requests set status = 'cancelled'/i);
});

test('acceptance checks remaining seats and decrements one seat in the decision transaction', () => {
  const decision = functionSource('respond_to_ride_request');
  const acceptBranch = decision.indexOf("if p_decision = 'accepted' then");
  const decrement = decision.indexOf('set seats_available = v_trip.seats_available - 1');
  const requestUpdate = decision.indexOf('update public.ride_requests set status = p_decision');
  assert.notEqual(acceptBranch, -1, 'acceptance has a separate guarded branch');
  assert.notEqual(decrement, -1, 'acceptance decrements one remaining seat');
  assert.notEqual(requestUpdate, -1, 'request status changes in the same function');
  assert.ok(acceptBranch < decrement && decrement < requestUpdate, 'seat decrement precedes request acceptance');
  assert.match(decision, /if v_trip\.seats_available\s*<\s*1 then/i);
  assert.match(decision, /status\s*=\s*case when v_trip\.seats_available = 1 then 'full' else 'open' end/i);
});

test('cancellation uses the same trip row lock as acceptance', () => {
  const cancel = functionSource('cancel_trip');
  assert.match(cancel, /from public\.trips as t[\s\S]*?for update/i);
  assert.match(cancel, /v_trip\.status not in\s*\('open',\s*'full'\)/i);
  assert.match(cancel, /update public\.trips set status = 'cancelled'/i);
});

test('clients cannot directly edit trip capacity/status or request status', () => {
  assert.match(migration, /grant update\s*\([\s\S]*?estimated_fare_per_person, note\s*\) on table public\.trips to authenticated/i);
  assert.doesNotMatch(migration, /grant update\s*\([^)]*\b(seats_available|status|user_id)\b[^)]*\)\s*on table public\.trips/i);
  assert.doesNotMatch(migration, /grant update\s*\([^)]*\b(status|requester_id)\b[^)]*\)\s*on table public\.ride_requests/i);
  assert.match(migration, /grant execute on function public\.respond_to_ride_request\(uuid, text\) to authenticated/i);
  assert.match(migration, /revoke all on function public\.respond_to_ride_request\(uuid, text\) from public, anon, authenticated/i);
});

test('accepted request history is guarded during account-driven cascades', () => {
  const requestDeleteGuard = functionSource('prevent_accepted_request_delete');
  const tripDeleteGuard = functionSource('prevent_trip_delete_with_accepted_requests');
  assert.match(requestDeleteGuard, /old\.status\s*=\s*'accepted'/i);
  assert.match(tripDeleteGuard, /v_request_status\s*=\s*'accepted'/i);
  assert.match(migration, /before delete on public\.ride_requests[\s\S]*?execute function public\.prevent_accepted_request_delete/i);
  assert.match(migration, /before delete on public\.trips[\s\S]*?execute function public\.prevent_trip_delete_with_accepted_requests/i);
});

test('every SECURITY DEFINER function pins an empty search_path', () => {
  const definitions = [...migration.matchAll(/create function public\.[\s\S]*?\$\$;/gi)].map(([source]) => source);
  const definers = definitions.filter((source) => /security definer/i.test(source));
  assert.ok(definers.length > 0, 'migration contains security-definer functions');
  for (const source of definers) {
    assert.match(source, /security definer\s+set search_path\s*=\s*''/i);
  }
});

test('the browser client uses only public Supabase settings and persists sessions', () => {
  const envNames = [...clientSource.matchAll(/import\.meta\.env\.([A-Z0-9_]+)/g)].map(([, name]) => name).sort();
  assert.deepEqual(envNames, ['VITE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_URL']);
  assert.match(clientSource, /persistSession:\s*true/);
  assert.match(clientSource, /autoRefreshToken:\s*true/);
  assert.match(clientSource, /detectSessionInUrl:\s*true/);
});

test('local env files are ignored while the placeholder example remains shareable', () => {
  assert.match(ignoreRules, /^\.env$/m);
  assert.match(ignoreRules, /^\.env\.\*$/m);
  assert.match(ignoreRules, /^!\.env\.example$/m);
});
