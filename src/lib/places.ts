export type Coordinates = { lat: number; lng: number };
export type PlaceValue = {
  label: string;
  /** The person's own input persisted in the trip label column. */
  userText: string;
  provider: 'google' | null;
  placeId: string | null;
  coordinates: Coordinates | null;
};
export type PlaceSuggestion = { key: string; label: string; prediction: PlacePrediction };

type LatLngValue = { lat(): number; lng(): number };
type PlaceRecord = {
  id?: string;
  displayName?: string;
  formattedAddress?: string;
  location?: LatLngValue | Coordinates | null;
  fetchFields(options: { fields: string[] }): Promise<void>;
};
type PlacePrediction = { placeId?: string; text: { toString(): string }; toPlace(): PlaceRecord };
type PlacesLibrary = {
  AutocompleteSessionToken: new () => unknown;
  AutocompleteSuggestion: {
    fetchAutocompleteSuggestions(request: Record<string, unknown>): Promise<{ suggestions: { placePrediction?: PlacePrediction }[] }>;
  };
  Place: new (options: { id: string }) => PlaceRecord;
};
type MapsLibrary = {
  Map: new (element: HTMLElement, options: Record<string, unknown>) => GoogleMapInstance;
  Polyline: new (options: Record<string, unknown>) => GooglePolylineInstance;
  LatLngBounds: new () => { extend(point: Coordinates): void };
};
type MarkerLibrary = { Marker: new (options: Record<string, unknown>) => GoogleMarkerInstance };
type GoogleMapInstance = {
  setCenter(center: Coordinates): void;
  fitBounds(bounds: { extend(point: Coordinates): void }, padding?: number): void;
};
type GoogleMarkerInstance = { setMap(map: GoogleMapInstance | null): void; setPosition(position: Coordinates): void; setVisible(visible: boolean): void };
type GooglePolylineInstance = { setMap(map: GoogleMapInstance | null): void; setPath(path: Coordinates[]): void };
type GoogleMapsWindow = { maps: {
  importLibrary?: (name: string) => Promise<unknown>;
  places?: PlacesLibrary;
  Map?: MapsLibrary['Map'];
  Marker?: MarkerLibrary['Marker'];
  Polyline?: MapsLibrary['Polyline'];
  LatLngBounds?: MapsLibrary['LatLngBounds'];
} };

function isPlacesLibrary(value: unknown): value is PlacesLibrary {
  if (!value || typeof value !== 'object') return false;
  const places = value as Partial<PlacesLibrary>;
  return typeof places.AutocompleteSessionToken === 'function'
    && typeof places.Place === 'function'
    && typeof places.AutocompleteSuggestion?.fetchAutocompleteSuggestions === 'function';
}

function isMapsLibrary(value: unknown): value is MapsLibrary {
  if (!value || typeof value !== 'object') return false;
  const maps = value as Partial<MapsLibrary>;
  return typeof maps.Map === 'function' && typeof maps.Polyline === 'function'
    && typeof maps.LatLngBounds === 'function';
}

function isMarkerLibrary(value: unknown): value is MarkerLibrary {
  if (!value || typeof value !== 'object') return false;
  return typeof (value as Partial<MarkerLibrary>).Marker === 'function';
}

declare global {
  interface Window {
    google?: GoogleMapsWindow;
    __routematesGoogleMapsReady?: () => void;
    gm_authFailure?: () => void;
  }
}

const mapsKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY?.trim() ?? '';
export const isGoogleMapsConfigured = Boolean(mapsKey);
let scriptLoader: Promise<GoogleMapsWindow['maps']> | null = null;
let placesLoader: Promise<PlacesLibrary> | null = null;
let mapsLoader: Promise<MapsLibrary> | null = null;
let markerLoader: Promise<MarkerLibrary> | null = null;
let mapsAuthenticationFailed = false;
let authFailureHandlerInstalled = false;
const placeDetailsForSession = new Map<string, Promise<{ label: string; coordinates: Coordinates | null }>>();

function installAuthFailureHandler() {
  if (authFailureHandlerInstalled) return;
  authFailureHandlerInstalled = true;
  const previousHandler = window.gm_authFailure;
  window.gm_authFailure = () => {
    mapsAuthenticationFailed = true;
    previousHandler?.();
  };
}

function mapsErrorMessage(feature: string, error?: unknown): string {
  const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const normalized = detail.toLowerCase();
  if (/referer|referrer|origin|not authorized|unauthorized|denied|blocked/.test(normalized)) {
    return `Google rejected ${feature}. Check this site's HTTP referrer restriction and confirm the Maps JavaScript API and Places API (New) are allowed for the browser key.`;
  }
  if (/billing|billingnotenabled/.test(normalized)) {
    return `Google could not use ${feature} because billing may not be enabled for the key's Cloud project. Check Google Cloud billing.`;
  }
  if (/api.?not.?activated|not enabled|not been enabled|not been used/.test(normalized)) {
    return `Google could not use ${feature} because a required API may be disabled. Enable Maps JavaScript API and Places API (New) for the key's project.`;
  }
  if (/quota|rate.?limit|over.?query/.test(normalized)) {
    return `Google could not complete ${feature} because the API quota may have been reached. Check Google Cloud quotas.`;
  }
  if (/network|failed to fetch|load failed|timeout/.test(normalized)) {
    return `Google ${feature} could not be reached. Check the network connection and try again.`;
  }
  if (mapsAuthenticationFailed) {
    return `Google rejected the browser key for ${feature}. Check this site's HTTP referrer restriction, enabled Maps JavaScript API and Places API (New), and active billing for the key's Cloud project.`;
  }
  return `Google ${feature} failed. Check the browser console for Google's specific error, and verify the browser key's referrer restriction, enabled APIs, and billing.`;
}

function ensureGoogleMapsScript(): Promise<GoogleMapsWindow['maps']> {
  if (!mapsKey) return Promise.reject(new Error('Place search is not configured. Type a location manually.'));
  if (scriptLoader) return scriptLoader;
  installAuthFailureHandler();

  scriptLoader = new Promise<GoogleMapsWindow['maps']>((resolve, reject) => {
    const resolveRuntime = () => {
      const runtime = window.google?.maps;
      if (!runtime) {
        reject(new Error(mapsErrorMessage('Maps JavaScript API initialization')));
        return;
      }
      resolve(runtime);
    };
    const runtime = window.google?.maps;
    if (runtime?.importLibrary || runtime?.places?.AutocompleteSuggestion) {
      resolve(runtime);
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>('script[data-routemates-google-maps],script[src*="maps.googleapis.com/maps/api/js"]');
    if (existing) {
      if (runtime) {
        resolve(runtime);
        return;
      }
      existing.addEventListener('load', resolveRuntime, { once: true });
      existing.addEventListener('error', () => reject(new Error(mapsErrorMessage('Maps JavaScript API loading'))), { once: true });
      return;
    }

    let initialized = false;
    const ready = () => {
      if (initialized) return;
      initialized = true;
      delete window.__routematesGoogleMapsReady;
      resolveRuntime();
    };
    window.__routematesGoogleMapsReady = ready;
    const script = document.createElement('script');
    script.dataset.routematesGoogleMaps = 'true';
    script.async = true;
    script.defer = true;
    const params = new URLSearchParams({
      key: mapsKey,
      v: 'weekly',
      loading: 'async',
      callback: '__routematesGoogleMapsReady',
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.onerror = () => {
      delete window.__routematesGoogleMapsReady;
      script.remove();
      reject(new Error(mapsErrorMessage('Maps JavaScript API loading')));
    };
    document.head.append(script);
  }).catch((error: unknown) => {
    scriptLoader = null;
    throw error;
  });
  return scriptLoader;
}

function loadPlacesLibrary(): Promise<PlacesLibrary> {
  if (placesLoader) return placesLoader;
  placesLoader = (async () => {
    const googleMaps = await ensureGoogleMapsScript();
    let value: unknown;
    try {
      value = typeof googleMaps.importLibrary === 'function'
        ? await googleMaps.importLibrary('places')
        : googleMaps.places;
    } catch (error) {
      throw new Error(mapsErrorMessage('Places autocomplete', error));
    }
    if (mapsAuthenticationFailed) throw new Error(mapsErrorMessage('Places autocomplete'));
    if (!isPlacesLibrary(value)) {
      throw new Error('Google Places autocomplete did not initialize. Confirm Maps JavaScript API and Places API (New) are enabled for this browser key.');
    }
    return value;
  })().catch((error: unknown) => {
    placesLoader = null;
    throw error;
  });
  return placesLoader;
}

function loadMapsLibrary(): Promise<MapsLibrary> {
  if (mapsLoader) return mapsLoader;
  mapsLoader = (async () => {
    const googleMaps = await ensureGoogleMapsScript();
    let value: unknown;
    try {
      value = typeof googleMaps.importLibrary === 'function'
        ? await googleMaps.importLibrary('maps')
        : googleMaps;
    } catch (error) {
      throw new Error(mapsErrorMessage('live trip map', error));
    }
    if (mapsAuthenticationFailed) throw new Error(mapsErrorMessage('live trip map'));
    if (!isMapsLibrary(value)) {
      throw new Error('The Google Maps library did not initialize. Confirm Maps JavaScript API is enabled for this browser key.');
    }
    return value;
  })().catch((error: unknown) => {
    mapsLoader = null;
    throw error;
  });
  return mapsLoader;
}

function loadMarkerLibrary(): Promise<MarkerLibrary> {
  if (markerLoader) return markerLoader;
  markerLoader = (async () => {
    const googleMaps = await ensureGoogleMapsScript();
    let value: unknown;
    try {
      value = typeof googleMaps.importLibrary === 'function'
        ? await googleMaps.importLibrary('marker')
        : googleMaps;
    } catch (error) {
      throw new Error(mapsErrorMessage('live trip map markers', error));
    }
    if (mapsAuthenticationFailed) throw new Error(mapsErrorMessage('live trip map markers'));
    if (!isMarkerLibrary(value)) {
      throw new Error('Google Maps markers did not initialize. Confirm Maps JavaScript API is enabled for this browser key.');
    }
    return value;
  })().catch((error: unknown) => {
    markerLoader = null;
    throw error;
  });
  return markerLoader;
}

export async function createPlaceSessionToken(): Promise<unknown> {
  const places = await loadPlacesLibrary();
  return new places.AutocompleteSessionToken();
}

export async function searchPlaceSuggestions(input: string, sessionToken: unknown): Promise<PlaceSuggestion[]> {
  const places = await loadPlacesLibrary();
  let suggestions: { placePrediction?: PlacePrediction }[];
  try {
    ({ suggestions } = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
      input: input.trim(),
      sessionToken,
      language: 'en-IN',
      region: 'in',
      includedRegionCodes: ['in'],
      locationBias: { center: { lat: 12.9716, lng: 77.5946 }, radius: 50000 },
    }));
  } catch (error) {
    throw new Error(mapsErrorMessage('Places autocomplete', error));
  }
  return suggestions.flatMap((suggestion) => {
    const prediction = suggestion.placePrediction;
    if (!prediction?.placeId) return [];
    return [{ key: prediction.placeId, label: prediction.text.toString(), prediction }];
  });
}

function readCoordinates(location: PlaceRecord['location']): Coordinates | null {
  if (!location) return null;
  let point: Coordinates;
  if (typeof location.lat === 'function' && typeof location.lng === 'function') {
    point = { lat: location.lat(), lng: location.lng() };
  } else {
    point = { lat: location.lat as number, lng: location.lng as number };
  }
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
  if (point.lat < -90 || point.lat > 90 || point.lng < -180 || point.lng > 180) return null;
  return { lat: point.lat, lng: point.lng };
}

export async function selectPlace(suggestion: PlaceSuggestion, userQuery: string): Promise<PlaceValue> {
  await loadPlacesLibrary();
  const place = suggestion.prediction.toPlace();
  try {
    await place.fetchFields({ fields: ['displayName', 'formattedAddress', 'location'] });
  } catch (error) {
    throw new Error(mapsErrorMessage('Place details', error));
  }
  const canonical = place.displayName || place.formattedAddress || suggestion.label;
  return {
    label: canonical,
    userText: userQuery.trim(),
    provider: 'google',
    placeId: suggestion.prediction.placeId ?? null,
    coordinates: readCoordinates(place.location),
  };
}

/** Google results are only held in this page's in-memory session. */
export async function resolvePlaceId(placeId: string): Promise<{ label: string; coordinates: Coordinates | null }> {
  const cached = placeDetailsForSession.get(placeId);
  if (cached) return cached;
  const pending = (async () => {
    const places = await loadPlacesLibrary();
    const place = new places.Place({ id: placeId });
    try {
      await place.fetchFields({ fields: ['displayName', 'formattedAddress', 'location'] });
    } catch (error) {
      throw new Error(mapsErrorMessage('Place details', error));
    }
    return {
      label: place.displayName || place.formattedAddress || 'Selected place',
      coordinates: readCoordinates(place.location),
    };
  })();
  placeDetailsForSession.set(placeId, pending);
  try { return await pending; } catch (error) { placeDetailsForSession.delete(placeId); throw error; }
}

export type LiveLocationPoint = { key: string; label: string; coordinates: Coordinates };
export type GoogleMapController = { update(points: LiveLocationPoint[]): void; dispose(): void };

export async function createGoogleLiveMap(element: HTMLElement, initial: LiveLocationPoint[]): Promise<GoogleMapController> {
  const [maps, markersLibrary] = await Promise.all([loadMapsLibrary(), loadMarkerLibrary()]);
  const center = initial[0]?.coordinates ?? { lat: 12.9716, lng: 77.5946 };
  const map = new maps.Map(element, {
    center,
    zoom: 13,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    clickableIcons: false,
    styles: [
      { elementType: 'geometry', stylers: [{ color: '#1b1b1b' }] },
      { elementType: 'labels.text.fill', stylers: [{ color: '#b0b0b0' }] },
      { elementType: 'labels.text.stroke', stylers: [{ color: '#1b1b1b' }] },
      { featureType: 'poi', elementType: 'labels.text', stylers: [{ visibility: 'off' }] },
      { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#383838' }] },
      { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#111111' }] },
    ],
  });
  const markers = new Map<string, GoogleMarkerInstance>();
  const controller: GoogleMapController = {
    update(points) {
      const livePoints = Array.isArray(points) ? points : [];
      const active = new Set(livePoints.map((point) => point.key));
      for (const [key, marker] of markers) {
        if (!active.has(key)) { marker.setMap(null); markers.delete(key); }
      }
      for (const point of livePoints) {
        const marker = markers.get(point.key);
        if (marker) marker.setPosition(point.coordinates);
        else markers.set(point.key, new markersLibrary.Marker({
          map, title: point.label, label: point.label.trim().slice(0, 1).toLocaleUpperCase(), position: point.coordinates,
        }));
      }
      if (livePoints.length === 1) map.setCenter(livePoints[0].coordinates);
      if (livePoints.length > 1) {
        const bounds = new maps.LatLngBounds();
        livePoints.forEach((point) => bounds.extend(point.coordinates));
        map.fitBounds(bounds, 48);
      }
    },
    dispose() { markers.forEach((marker) => marker.setMap(null)); markers.clear(); },
  };
  controller.update(initial);
  return controller;
}
