export type Coordinates = { lat: number; lng: number };
export type MatchLocation = { label: string; placeId?: string | null; coordinates?: Coordinates | null };
export type RouteMatchInput = { pickup: MatchLocation; destination: MatchLocation };
export type RouteMatch = {
  confidence: 'coordinate' | 'place-id' | 'mixed' | 'text';
  reason: string;
  pickupDistanceKm: number | null;
  destinationDistanceKm: number | null;
};

export function normalizePlaceText(value: string): string;
export function distanceKm(a: Coordinates | null | undefined, b: Coordinates | null | undefined): number | null;
export function matchRoute(search: RouteMatchInput, candidate: RouteMatchInput, options?: {
  pickupLimitKm?: number;
  destinationLimitKm?: number;
  textThreshold?: number;
}): RouteMatch | null;
