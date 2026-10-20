import { useEffect, useRef, useState } from 'react';
import { MapPin } from 'lucide-react';
import {
  createGoogleLiveMap, isGoogleMapsConfigured, type GoogleMapController, type LiveLocationPoint,
} from '../lib/places';

export function LiveLocationMap({ points }: { points: LiveLocationPoint[] }) {
  const element = useRef<HTMLDivElement>(null);
  const controller = useRef<GoogleMapController | null>(null);
  const pointsRef = useRef(points);
  const [error, setError] = useState('');
  pointsRef.current = points;
  const hasPoints = points.length > 0;

  useEffect(() => {
    if (!isGoogleMapsConfigured || !element.current || !hasPoints) return;
    let active = true;
    void createGoogleLiveMap(element.current, pointsRef.current).then((map) => {
      if (!active) { map.dispose(); return; }
      controller.current = map;
    }).catch((caught: unknown) => {
      if (active) setError(caught instanceof Error ? caught.message : 'The live map could not load.');
    });
    return () => { active = false; controller.current?.dispose(); controller.current = null; };
  }, [hasPoints]);

  useEffect(() => { controller.current?.update(points); }, [points]);

  if (!points.length) return <div className="live-map-placeholder"><MapPin size={17}/><span>No live points are available. A participant must opt in before a location appears.</span></div>;
  if (!isGoogleMapsConfigured) return <div className="live-map-placeholder"><MapPin size={17}/><span>Live coordinates are private to accepted trip participants. Add a restricted Google Maps key to display them on a map.</span></div>;
  return <div className="live-map-wrap"><div className="live-google-map" ref={element}/>{error && <div className="live-map-error" role="status">{error}</div>}<small>Live points expire from this view after 60 seconds without an update.</small></div>;
}
