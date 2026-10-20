import { useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { CircleHelp, LoaderCircle, MapPin } from 'lucide-react';
import {
  createPlaceSessionToken, isGoogleMapsConfigured, searchPlaceSuggestions, selectPlace,
  type PlaceSuggestion, type PlaceValue,
} from '../lib/places';

type Props = { label: string; value: PlaceValue; onChange: (value: PlaceValue) => void; placeholder: string; invalid?: boolean };
const emptyPlace = (label = ''): PlaceValue => ({ label, userText: label, provider: null, placeId: null, coordinates: null });

export function LocationInput({ label, value, onChange, placeholder, invalid = false }: Props) {
  const inputId = useId();
  const listId = useId();
  const [text, setText] = useState(value.label);
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const token = useRef<unknown>(null);
  const tokenRequest = useRef<Promise<unknown> | null>(null);
  const requestNumber = useRef(0);

  useEffect(() => { setText(value.label); }, [value.label]);

  useEffect(() => {
    const request = ++requestNumber.current;
    setSuggestions([]);
    setActiveIndex(-1);
    setError('');
    setSearched(false);
    if (!open || text.trim().length < 2 || !isGoogleMapsConfigured) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const timeout = window.setTimeout(() => {
      void (async () => {
        try {
          const pendingToken = tokenRequest.current ??= createPlaceSessionToken();
          const sessionToken = token.current ?? await pendingToken;
          token.current = sessionToken;
          if (tokenRequest.current === pendingToken) tokenRequest.current = null;
          if (request !== requestNumber.current) return;
          const results = await searchPlaceSuggestions(text, sessionToken);
          if (request !== requestNumber.current) return;
          setSuggestions(results);
          setSearched(true);
        } catch (caught) {
          tokenRequest.current = null;
          if (request === requestNumber.current) setError(caught instanceof Error ? caught.message : 'Place search failed. You can still type a location manually.');
        } finally {
          if (request === requestNumber.current) setLoading(false);
        }
      })();
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [open, text]);

  const changeText = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    setText(next);
    setError('');
    setOpen(true);
    if (value.provider || value.placeId) token.current = null;
    onChange(emptyPlace(next));
  };

  const choose = async (suggestion: PlaceSuggestion) => {
    setSelecting(true);
    setError('');
    try {
      const place = await selectPlace(suggestion, text);
      setText(place.label);
      onChange(place);
      token.current = null;
      setOpen(false);
      setSuggestions([]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That place could not be selected. Type its name manually.');
    } finally {
      setSelecting(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && suggestions.length) {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % suggestions.length);
    } else if (event.key === 'ArrowUp' && suggestions.length) {
      event.preventDefault();
      setActiveIndex((current) => current <= 0 ? suggestions.length - 1 : current - 1);
    } else if (event.key === 'Enter' && open && activeIndex >= 0) {
      event.preventDefault();
      void choose(suggestions[activeIndex]);
    } else if (event.key === 'Escape') {
      setOpen(false);
      setSuggestions([]);
    }
  };

  const manualNotice = !isGoogleMapsConfigured && text.trim().length >= 2;
  const showList = Boolean(open && isGoogleMapsConfigured && text.trim().length >= 2
    && (loading || selecting || error || searched || suggestions.length > 0));

  return <div className="place-field">
    <label htmlFor={inputId}>{label}</label>
    <div className={`place-input-wrap ${invalid ? 'invalid' : ''}`}>
      <MapPin size={16} aria-hidden="true"/>
      <input id={inputId} value={text} onChange={changeText} onKeyDown={onKeyDown}
        onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 130)}
        autoComplete="off" maxLength={200} placeholder={placeholder} aria-label={label}
        aria-invalid={invalid} aria-autocomplete="list" aria-expanded={showList}
        aria-controls={showList ? listId : undefined} aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}/>
      {value.placeId && <span className="place-selected">Place selected</span>}
    </div>
    {showList && <ul className="place-suggestions" id={listId} role="listbox" aria-label={`${label} suggestions`}>
      {loading || selecting ? <li className="place-suggestion-state"><LoaderCircle size={15} className="spin-icon"/>{selecting ? 'Loading place details…' : 'Searching places…'}</li>
        : error ? <li className="place-suggestion-state place-error"><CircleHelp size={15}/>{error}</li>
          : suggestions.length ? suggestions.map((suggestion, index) => <li key={suggestion.key}>
            <button id={`${listId}-${index}`} type="button" role="option" aria-selected={index === activeIndex}
              onMouseDown={(event) => event.preventDefault()} onClick={() => void choose(suggestion)}>
              <MapPin size={15}/><span>{suggestion.label}</span>
            </button>
          </li>)
            : <li className="place-suggestion-state">No places found. Try a broader search.</li>}
      {suggestions.length > 0 && <li className="google-attribution">Google Maps</li>}
    </ul>}
    {manualNotice && <small className="place-help">Google suggestions are off. Manual location text is supported; proximity is unverified.</small>}
    {value.provider && <small className="place-help">Place ID selected. Place details and coordinates are used in this browser session and are not saved.</small>}
  </div>;
}
