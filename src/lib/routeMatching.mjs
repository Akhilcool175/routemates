const aliases = new Map([
  ['blr', 'bengaluru'],
  ['bangalore', 'bengaluru'],
  ['bengaluru', 'bengaluru'],
  ['st', 'street'],
  ['rd', 'road'],
  ['intl', 'international'],
  ['apt', 'airport'],
]);

export function normalizePlaceText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-IN')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => aliases.get(word) ?? word)
    .join(' ');
}

function similarity(left, right) {
  const a = normalizePlaceText(left);
  const b = normalizePlaceText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;

  const listA = a.split(' ');
  const listB = b.split(' ');
  const containsTokenPhrase = (shorter, longer) => {
    if (shorter.length > longer.length) return false;
    return longer.some((_, start) => shorter.every((word, offset) => longer[start + offset] === word));
  };
  if (containsTokenPhrase(listA, listB) || containsTokenPhrase(listB, listA)) return 0.82;

  const wordsA = new Set(listA);
  const wordsB = new Set(listB);
  const shared = [...wordsA].filter((word) => wordsB.has(word)).length;
  const tokenScore = shared / new Set([...wordsA, ...wordsB]).size;
  const paddedA = `  ${a} `;
  const paddedB = `  ${b} `;
  const gramsA = new Set(Array.from({ length: Math.max(0, paddedA.length - 2) }, (_, i) => paddedA.slice(i, i + 3)));
  const gramsB = new Set(Array.from({ length: Math.max(0, paddedB.length - 2) }, (_, i) => paddedB.slice(i, i + 3)));
  const sharedGrams = [...gramsA].filter((gram) => gramsB.has(gram)).length;
  const trigramScore = (2 * sharedGrams) / (gramsA.size + gramsB.size);
  return Math.max(tokenScore, trigramScore);
}

export function distanceKm(a, b) {
  if (!a || !b) return null;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(b.lat - a.lat);
  const longitudeDelta = toRadians(b.lng - a.lng);
  const part = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(part), Math.sqrt(1 - part));
}

function hasCoordinates(location) {
  const point = location?.coordinates;
  return point && Number.isFinite(point.lat) && Number.isFinite(point.lng)
    && point.lat >= -90 && point.lat <= 90 && point.lng >= -180 && point.lng <= 180;
}

function sameDirection(aFrom, aTo, bFrom, bTo) {
  const aLat = aTo.lat - aFrom.lat;
  const aLng = (aTo.lng - aFrom.lng) * Math.cos(((aFrom.lat + aTo.lat) / 2) * Math.PI / 180);
  const bLat = bTo.lat - bFrom.lat;
  const bLng = (bTo.lng - bFrom.lng) * Math.cos(((bFrom.lat + bTo.lat) / 2) * Math.PI / 180);
  const denominator = Math.hypot(aLat, aLng) * Math.hypot(bLat, bLng);
  if (!denominator) return true;
  return ((aLat * bLat) + (aLng * bLng)) / denominator > 0;
}

/**
 * Coordinates are authoritative per endpoint: when both sides resolve, the
 * distance limit must pass regardless of similar labels. Exact Place IDs are
 * next, and normalized/fuzzy text is only used when that endpoint lacks a
 * coordinate pair and an exact Place ID pair.
 *
 * Defaults: pickup within 3 km, destination within 5 km. Direction is checked
 * when coordinates exist for both endpoints on both routes. These are straight
 * line proximity thresholds, not road-route or cab-route overlap.
 */
export function matchRoute(search, candidate, options = {}) {
  const pickupLimitKm = options.pickupLimitKm ?? 3;
  const destinationLimitKm = options.destinationLimitKm ?? 5;
  const textThreshold = options.textThreshold ?? 0.62;
  const compareEndpoint = (left, right, limitKm) => {
    if (hasCoordinates(left) && hasCoordinates(right)) {
      const distance = distanceKm(left.coordinates, right.coordinates);
      return { matches: distance <= limitKm, method: 'coordinate', distance };
    }
    if (left?.placeId && left.placeId === right?.placeId) {
      return { matches: true, method: 'place-id', distance: null };
    }
    return {
      matches: similarity(left?.label, right?.label) >= textThreshold,
      method: 'text',
      distance: null,
    };
  };

  const pickup = compareEndpoint(search.pickup, candidate.pickup, pickupLimitKm);
  const destination = compareEndpoint(search.destination, candidate.destination, destinationLimitKm);
  if (!pickup.matches || !destination.matches) return null;

  const allCoordinates = [search.pickup, search.destination, candidate.pickup, candidate.destination]
    .every(hasCoordinates);
  if (allCoordinates && !sameDirection(
    search.pickup.coordinates,
    search.destination.coordinates,
    candidate.pickup.coordinates,
    candidate.destination.coordinates,
  )) return null;

  const methods = [pickup.method, destination.method];
  const confidence = methods.every((method) => method === 'coordinate') ? 'coordinate'
    : methods.every((method) => method === 'place-id') ? 'place-id'
      : methods.every((method) => method === 'text') ? 'text' : 'mixed';
  const reason = confidence === 'coordinate' ? 'Nearby pickup and destination areas.'
    : confidence === 'place-id' ? 'Same selected pickup and destination places.'
      : confidence === 'text' ? 'Similar route text; proximity is not verified.'
        : `${pickup.method === 'coordinate' ? 'Nearby pickup' : pickup.method === 'place-id' ? 'Same pickup place' : 'Similar pickup text'}; ${destination.method === 'coordinate' ? 'nearby destination' : destination.method === 'place-id' ? 'same destination place' : 'similar destination text'}.`;
  return {
    confidence,
    reason,
    pickupDistanceKm: pickup.distance,
    destinationDistanceKm: destination.distance,
  };
}
