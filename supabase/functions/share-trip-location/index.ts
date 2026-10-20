import { createSupabaseContext } from 'npm:@supabase/server@1';
import { relayTripLocation, RelayError } from './relay.mjs';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'POST is required.' }, 405);

  const { data: context, error: authError } = await createSupabaseContext(request, { auth: 'user' });
  if (authError || !context) return jsonResponse({ error: 'A valid signed-in session is required.' }, 401);
  const claims = context.userClaims as Record<string, unknown> | undefined;
  const actorId = typeof claims?.sub === 'string' ? claims.sub : '';
  if (!actorId) return jsonResponse({ error: 'A valid signed-in session is required.' }, 401);

  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > 4096) return jsonResponse({ error: 'The location update is too large.' }, 413);
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > 4096) return jsonResponse({ error: 'The location update is too large.' }, 413);
    body = JSON.parse(text);
  } catch {
    return jsonResponse({ error: 'The location update must be valid JSON.' }, 400);
  }

  try {
    await relayTripLocation({
      actorId,
      body,
      authorize: async ({ actorId: verifiedActorId, tripId, shareKey }) => {
        const { data, error } = await context.supabaseAdmin.rpc('authorize_trip_location_relay', {
          p_actor_id: verifiedActorId,
          p_trip_id: tripId,
          p_share_key: shareKey,
        });
        if (error) {
          const failure = new Error('Location authorization failed.') as Error & { code?: string };
          failure.code = error.code;
          throw failure;
        }
        return data as { display_name: string; sent_at: string } | null;
      },
      send: async ({ topic, event, payload }) => {
        const channel = context.supabaseAdmin.channel(topic, { config: { private: true } });
        try {
          const result = await channel.httpSend(event, payload);
          if (!result.success) throw new Error('Broadcast delivery failed.');
        } finally {
          await context.supabaseAdmin.removeChannel(channel);
        }
      },
    });
    return jsonResponse({ ok: true }, 200);
  } catch (caught) {
    if (caught instanceof RelayError) return jsonResponse({ error: caught.message }, caught.status);
    const code = (caught as { code?: string } | null)?.code;
    if (code === '42501') return jsonResponse({ error: 'Location sharing is no longer active for this account.' }, 403);
    if (code === 'P0001') return jsonResponse({ error: 'Location updates are arriving too quickly. Wait a moment and try again.' }, 429);
    return jsonResponse({ error: 'The location update could not be authorized. Sharing will expire if no fresh update arrives.' }, 503);
  }
});
