import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowRight, Bell, CarFront, Check, ChevronDown, CircleHelp, Clock3,
  Compass, LoaderCircle, LogOut, MapPin, Menu, MessageCircle, Plus, Send,
  ShieldCheck, Users, X,
} from 'lucide-react';
import {
  relayTripLocation, cancelRideRequest, cancelTrip, completeTrip, createRideRequest, createTrip,
  loadTripLocationShareStates, loadTripMessages,
  loadAppData, loadOwnProfile, respondToRideRequest, signIn, signOut, signUp,
  sendTripMessage, setTripLocationSharing, updateOwnProfile, type AppData,
  type LocationShareState, type NewTrip, type RequestView, type TripMessage, type TripView,
} from './lib/routematesData';
import { isSupabaseConfigured, supabase, supabaseConfigError, supabaseMode } from './lib/supabase';
import { LocationInput } from './components/LocationInput';
import { LiveLocationMap } from './components/LiveLocationMap';
import { distanceKm, matchRoute, type RouteMatch } from './lib/routeMatching.mjs';
import { validateTripForm } from './lib/tripValidation.mjs';
import { isGoogleMapsConfigured, resolvePlaceId, type Coordinates, type PlaceValue } from './lib/places';
import { createLocationShareGeneration } from './lib/locationShareLifecycle.mjs';

type Page = 'Discover' | 'Create Trip' | 'My Trips' | 'Requests' | 'Profile';
type Profile = { id: string; display_name: string; campus: string | null; created_at: string };
type Query = { from: PlaceValue; to: PlaceValue };
type MatchDetail = { match: RouteMatch; pickup?: string; destination?: string };
type DataState = 'idle' | 'loading' | 'ready' | 'error';

const pages: { name: Page; icon: typeof Compass }[] = [
  { name: 'Discover', icon: Compass },
  { name: 'Create Trip', icon: Plus },
  { name: 'My Trips', icon: CarFront },
  { name: 'Requests', icon: Bell },
  { name: 'Profile', icon: Users },
];
const MAX_ROUTE_CANDIDATES = 12;

function hoursFromNow(hours: number) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function makeDemoTrips(): TripView[] {
  return [
    { id: 'demo-1', hostName: 'Aarav Mehta', pickup: 'Majestic Bus Station', destination: 'Kempegowda International Airport', pickupProvider: null, pickupPlaceId: null, destinationProvider: null, destinationPlaceId: null, departureAt: hoursFromNow(3), seatsAvailable: 2, note: 'Leaving after last lecture', status: 'open', owned: false, requestStatus: null, chatAvailable: false },
    { id: 'demo-2', hostName: 'Isha Kapoor', pickup: 'Koramangala', destination: 'Kempegowda International Airport', pickupProvider: null, pickupPlaceId: null, destinationProvider: null, destinationPlaceId: null, departureAt: hoursFromNow(4), seatsAvailable: 3, note: 'Room for luggage', status: 'open', owned: false, requestStatus: null, chatAvailable: false },
    { id: 'demo-3', hostName: 'Kabir Singh', pickup: 'Yelahanka', destination: 'Bengaluru City Railway Station', pickupProvider: null, pickupPlaceId: null, destinationProvider: null, destinationPlaceId: null, departureAt: hoursFromNow(20), seatsAvailable: 1, note: 'Early train? Let’s go', status: 'open', owned: false, requestStatus: null, chatAvailable: false },
    { id: 'demo-4', hostName: 'Diya Nair', pickup: 'Malleshwaram', destination: 'Kempegowda International Airport', pickupProvider: null, pickupPlaceId: null, destinationProvider: null, destinationPlaceId: null, departureAt: hoursFromNow(5), seatsAvailable: 2, note: 'Coming from an evening class', status: 'open', owned: false, requestStatus: null, chatAvailable: false },
  ];
}

const demoProfile: Profile = {
  id: 'demo-user', display_name: 'Sam Student', campus: 'North Campus', created_at: new Date().toISOString(),
};

function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}

function localDateKey(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function blankPlace(): PlaceValue {
  return { label: '', userText: '', provider: null, placeId: null, coordinates: null };
}

function dateLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  if (localDateKey(date) === localDateKey(today)) return 'Today';
  if (localDateKey(date) === localDateKey(tomorrow)) return 'Tomorrow';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function timeLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Time unavailable' : date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function statusLabel(status: string) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function App() {
  const [demoTrips, setDemoTrips] = useState<TripView[]>(makeDemoTrips);
  const [demoRequests, setDemoRequests] = useState<RequestView[]>([]);
  const [demoUser, setDemoUser] = useState<Profile>(demoProfile);

  const [session, setSession] = useState<{ user: { id: string; email?: string } } | null>(null);
  const [authLoading, setAuthLoading] = useState(isSupabaseConfigured);
  const [authError, setAuthError] = useState('');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [trips, setTrips] = useState<TripView[]>([]);
  const [requests, setRequests] = useState<RequestView[]>([]);
  const [dataState, setDataState] = useState<DataState>('idle');
  const [dataError, setDataError] = useState('');
  const currentUserId = useRef<string | null>(null);
  currentUserId.current = session?.user.id ?? null;

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return;
      const nextUserId = nextSession?.user.id ?? null;
      if (currentUserId.current !== nextUserId) {
        currentUserId.current = nextUserId;
        setProfile(null);
        setProfileError('');
        setTrips([]);
        setRequests([]);
        setDataState('idle');
        setDataError('');
      }
      setSession(nextSession ? { user: { id: nextSession.user.id, email: nextSession.user.email } } : null);
      setAuthError('');
      if (!nextSession) {
        setProfile(null);
        setTrips([]);
        setRequests([]);
        setDataState('idle');
        setDataError('');
      }
    });
    void supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) setAuthError(error.message);
      setSession(data.session ? { user: { id: data.session.user.id, email: data.session.user.email } } : null);
      setAuthLoading(false);
    }).catch((error: unknown) => {
      if (!active) return;
      setAuthError(errorText(error));
      setAuthLoading(false);
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured || authLoading) return;
    if (!session?.user.id) {
      setProfile(null);
      setProfileLoading(false);
      return;
    }
    let active = true;
    setProfileLoading(true);
    setProfileError('');
    void loadOwnProfile(session.user.id).then((value) => {
      if (!active) return;
      setProfile(value);
      setProfileLoading(false);
    }).catch((error: unknown) => {
      if (!active) return;
      setProfileError(errorText(error));
      setProfileLoading(false);
    });
    return () => { active = false; };
  }, [authLoading, session?.user.id]);

  const refreshData = useCallback(async () => {
    if (!profile) return null;
    setDataState('loading');
    setDataError('');
    try {
      const value: AppData = await loadAppData(profile.display_name);
      if (currentUserId.current !== profile.id) return null;
      setTrips(value.trips);
      setRequests(value.requests);
      setDataState('ready');
      return value;
    } catch (error) {
      if (currentUserId.current !== profile.id) return null;
      setDataError(errorText(error));
      setDataState('error');
      return null;
    }
  }, [profile]);

  useEffect(() => {
    if (profile && isSupabaseConfigured) void refreshData();
  }, [profile, refreshData]);

  const notifyDataError = (error: unknown) => {
    setDataError(errorText(error));
    setDataState('error');
  };

  const saveProfile = async (displayName: string, campus: string) => {
    if (supabaseMode === 'demo') {
      setDemoUser((old) => ({ ...old, display_name: displayName.trim(), campus: campus.trim() || null }));
      return;
    }
    if (!profile) throw new Error('Your profile is not available. Check the Supabase profile creation trigger.');
    const updated = await updateOwnProfile(profile.id, displayName, campus);
    setProfile(updated);
  };

  const perform = async (task: () => Promise<void>, success: string) => {
    try {
      await task();
      if (isSupabaseConfigured) {
        await refreshData();
      }
      return success;
    } catch (error) {
      notifyDataError(error);
      throw error;
    }
  };

  const addDemoTrip = (value: NewTrip) => {
    const trip: TripView = {
      id: `demo-${Date.now()}`,
      hostName: demoUser.display_name,
      pickup: value.pickup_label,
      destination: value.destination_label,
      pickupProvider: value.pickup_provider,
      pickupPlaceId: value.pickup_place_id,
      destinationProvider: value.destination_provider,
      destinationPlaceId: value.destination_place_id,
      departureAt: value.departure_at,
      seatsAvailable: value.seats_available,
      note: value.note ?? '',
      status: 'open',
      owned: true,
      requestStatus: null,
      chatAvailable: false,
    };
    setDemoTrips((old) => [trip, ...old]);
  };

  const onCreateTrip = async (value: NewTrip) => {
    if (supabaseMode === 'demo') {
      addDemoTrip(value);
      return 'Your fictional demo trip is posted in this browser.';
    }
    await perform(() => createTrip(value), 'Your trip is posted for eligible signed-in members.');
    return 'Your trip is posted for eligible signed-in members.';
  };

  const onJoinTrip = async (tripId: string) => {
    if (supabaseMode === 'demo') {
      const trip = demoTrips.find((item) => item.id === tripId);
      if (!trip) throw new Error('That sample trip is no longer available.');
      const request: RequestView = {
        id: `demo-request-${Date.now()}`,
        tripId,
        direction: 'sent',
        status: 'pending',
        message: null,
        createdAt: new Date().toISOString(),
        otherPerson: trip.hostName,
        trip: { ...trip, requestStatus: 'pending' },
      };
      setDemoRequests((old) => [request, ...old]);
      setDemoTrips((old) => old.map((item) => item.id === tripId ? { ...item, requestStatus: 'pending' } : item));
      return 'Demo request saved locally. It was not sent to another person.';
    }
    await perform(() => createRideRequest(tripId), 'Your request was sent to the trip host.');
    return 'Your request was sent to the trip host.';
  };

  const onRequestDecision = async (requestId: string, decision: 'accepted' | 'declined') => {
    if (supabaseMode === 'demo') return 'Demo requests do not reach another account.';
    await perform(() => respondToRideRequest(requestId, decision), decision === 'accepted' ? 'Request accepted; remaining seats were updated.' : 'Request declined.');
    return decision === 'accepted' ? 'Request accepted; remaining seats were updated.' : 'Request declined.';
  };

  const onRequestCancel = async (requestId: string) => {
    if (supabaseMode === 'demo') {
      setDemoRequests((old) => old.map((request) => request.id === requestId ? { ...request, status: 'cancelled' } : request));
      const request = demoRequests.find((item) => item.id === requestId);
      if (request) setDemoTrips((old) => old.map((trip) => trip.id === request.tripId ? { ...trip, requestStatus: 'cancelled' } : trip));
      return 'Demo request cancelled locally.';
    }
    await perform(() => cancelRideRequest(requestId), 'Your pending request was cancelled.');
    return 'Your pending request was cancelled.';
  };

  const onTripCancel = async (tripId: string) => {
    if (supabaseMode === 'demo') {
      setDemoTrips((old) => old.map((trip) => trip.id === tripId ? { ...trip, status: 'cancelled' } : trip));
      return 'Demo trip cancelled locally.';
    }
    await perform(() => cancelTrip(tripId), 'Trip cancelled. Accepted requests remain in its history.');
    return 'Trip cancelled. Accepted requests remain in its history.';
  };

  const onTripComplete = async (tripId: string) => {
    if (supabaseMode === 'demo') {
      setDemoTrips((old) => old.map((trip) => trip.id === tripId ? { ...trip, status: 'completed' } : trip));
      return 'Demo trip marked complete locally.';
    }
    await perform(() => completeTrip(tripId), 'Trip marked complete.');
    return 'Trip marked complete.';
  };

  const signOutUser = async () => {
    const { error } = await signOut();
    if (error) throw error;
  };

  if (supabaseMode === 'incomplete' || supabaseMode === 'invalid') return <ConfigurationNotice/>;
  if (supabaseMode === 'configured' && authLoading) return <FullScreenStatus text="Checking your RouteMates session…"/>;
  if (supabaseMode === 'configured' && !session) {
    return <AuthScreen initialError={authError}/>;
  }
  if (supabaseMode === 'configured' && profileLoading) return <FullScreenStatus text="Loading your profile…"/>;
  if (supabaseMode === 'configured' && profileError) {
    return <ProfileLoadError message={profileError} onRetry={() => {
      if (!session?.user.id) return;
      setProfileLoading(true);
      void loadOwnProfile(session.user.id).then((value) => { setProfile(value); setProfileError(''); }).catch((error: unknown) => setProfileError(errorText(error))).finally(() => setProfileLoading(false));
    }} onSignOut={signOutUser}/>;
  }
  if (supabaseMode === 'configured' && !profile) {
    return <ProfileLoadError message="No profile row was found for this Auth account. The signup trigger should create it; review and apply the RouteMates migration before continuing." onRetry={() => {
      if (!session?.user.id) return;
      setProfileLoading(true);
      void loadOwnProfile(session.user.id).then((value) => setProfile(value)).catch((error: unknown) => setProfileError(errorText(error))).finally(() => setProfileLoading(false));
    }} onSignOut={signOutUser}/>;
  }

  const activeProfile = supabaseMode === 'demo' ? demoUser : profile!;
  if (supabaseMode === 'configured' && activeProfile.display_name === 'RouteMates member') {
    return <ProfileSetup onSave={async (name, campus) => { await saveProfile(name, campus); }} onSignOut={signOutUser}/>;
  }

  return <Workspace
    mode={supabaseMode === 'demo' ? 'demo' : 'connected'}
    profile={activeProfile}
    email={session?.user.email ?? ''}
    trips={supabaseMode === 'demo' ? demoTrips : trips}
    requests={supabaseMode === 'demo' ? demoRequests : requests}
    dataState={supabaseMode === 'demo' ? 'ready' : dataState}
    dataError={dataError}
    onRetry={refreshData}
    onCreateTrip={onCreateTrip}
    onJoinTrip={onJoinTrip}
    onRequestDecision={onRequestDecision}
    onRequestCancel={onRequestCancel}
    onTripCancel={onTripCancel}
    onTripComplete={onTripComplete}
    onSaveProfile={saveProfile}
    onSignOut={supabaseMode === 'demo' ? undefined : signOutUser}
  />;
}

function ConfigurationNotice() {
  return <div className="auth-page"><section className="auth-card"><Brand/><span className="overline">CONFIGURATION NEEDED</span><h1>Finish Supabase setup</h1><p>{supabaseMode === 'invalid' ? 'The Supabase URL is not valid. Correct it in .env.local and restart Vite.' : 'Only one Supabase browser setting is present. Add both values to .env.local to connect, or remove both values to use the clearly labelled local demo.'}</p><div className="auth-message error"><CircleHelp size={16}/>{supabaseConfigError} Never put a service-role key here.</div><p className="auth-footnote">See <code>.env.example</code> and the README for setup details.</p></section></div>;
}

function FullScreenStatus({ text }: { text: string }) {
  return <div className="auth-page"><section className="auth-card"><Brand/><div className="result-status"><span className="spinner dark"/>{text}</div></section></div>;
}

function ProfileLoadError({ message, onRetry, onSignOut }: { message: string; onRetry: () => void; onSignOut: () => Promise<void> }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const runSignOut = async () => {
    setBusy(true);
    try { await onSignOut(); } catch (caught) { setError(errorText(caught)); } finally { setBusy(false); }
  };
  return <div className="auth-page"><section className="auth-card"><Brand/><span className="overline">PROFILE CHECK</span><h1>We couldn’t load your profile</h1><p className="auth-message error">{message}</p>{error&&<p className="form-error">{error}</p>}<div className="auth-actions"><button className="black-button" onClick={onRetry}>Try again</button><button className="secondary-button" disabled={busy} onClick={runSignOut}>{busy?'Signing out…':'Sign out'}</button></div></section></div>;
}

function AuthScreen({ initialError }: { initialError: string }) {
  const [view, setView] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [campus, setCampus] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const [message, setMessage] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');
    if (view === 'sign-up' && displayName.trim().length < 2) {
      setError('Enter a display name with at least two characters.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    setBusy(true);
    try {
      if (view === 'sign-up') {
        const { data, error: authIssue } = await signUp(email, password, displayName, campus);
        if (authIssue) throw authIssue;
        if (!data.session) setMessage('Account created. Check your email if confirmation is enabled, then sign in here.');
        else setMessage('Account created. Loading your profile…');
      } else {
        const { error: authIssue } = await signIn(email, password);
        if (authIssue) throw authIssue;
      }
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  return <div className="auth-page"><section className="auth-card"><Brand/><span className="overline">SAME WAY. ONE RIDE.</span><h1>{view === 'sign-in' ? 'Welcome back' : 'Create your account'}</h1><p>{view === 'sign-in' ? 'Sign in to discover and coordinate shared rides.' : 'Create a profile to publish trips and request seats.'}</p>
    <div className="mode-notice connected-notice"><i/> Supabase connected · sign in to continue</div>
    <form className="auth-form" onSubmit={submit}>
      {view === 'sign-up' && <><label>Display name<input autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} required placeholder="Name shown to other members"/></label><label>Campus or community <span className="optional">Optional · private</span><input value={campus} onChange={(event) => setCampus(event.target.value)} maxLength={120} placeholder="e.g. North Campus"/></label></>}
      <label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required placeholder="you@example.com"/></label>
      <label>Password<input type="password" autoComplete={view === 'sign-in' ? 'current-password' : 'new-password'} minLength={6} value={password} onChange={(event) => setPassword(event.target.value)} required placeholder="At least 6 characters"/></label>
      {error && <div className="auth-message error"><CircleHelp size={15}/>{error}</div>}
      {message && <div className="auth-message success"><Check size={15}/>{message}</div>}
      <button className="black-button auth-submit" type="submit" disabled={busy}>{busy ? <><span className="spinner"/>Please wait…</> : <>{view === 'sign-in' ? 'Sign in' : 'Create account'} <ArrowRight size={16}/></>}</button>
    </form>
    <p className="auth-switch">{view === 'sign-in' ? 'New to RouteMates?' : 'Already have an account?'} <button onClick={() => { setView(view === 'sign-in' ? 'sign-up' : 'sign-in'); setError(''); setMessage(''); }}>{view === 'sign-in' ? 'Create an account' : 'Sign in'}</button></p>
    <p className="auth-footnote">Display names are self-reported and unverified. RouteMates does not verify identity or student status.</p>
  </section></div>;
}

function ProfileSetup({ onSave, onSignOut }: { onSave: (name: string, campus: string) => Promise<void>; onSignOut: () => Promise<void> }) {
  const [displayName, setDisplayName] = useState('');
  const [campus, setCampus] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try { await onSave(displayName, campus); } catch (caught) { setError(errorText(caught)); } finally { setBusy(false); }
  };
  return <div className="auth-page"><section className="auth-card"><Brand/><span className="overline">PROFILE SETUP</span><h1>How should people know you?</h1><p>Your public name is self-reported. Campus is private and is not shown during discovery.</p><form className="auth-form" onSubmit={submit}><label>Display name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} minLength={2} required/></label><label>Campus or community <span className="optional">Optional · private</span><input value={campus} onChange={(event) => setCampus(event.target.value)} maxLength={120}/></label>{error&&<div className="auth-message error">{error}</div>}<button className="black-button auth-submit" disabled={busy}>{busy?'Saving profile…':'Save and continue'} <ArrowRight size={16}/></button><button className="secondary-button auth-submit" type="button" onClick={() => void onSignOut().catch((caught: unknown) => setError(errorText(caught)))}>Sign out</button></form><p className="auth-footnote">No identity or campus membership verification is performed.</p></section></div>;
}

type WorkspaceProps = {
  mode: 'demo' | 'connected';
  profile: Profile;
  email: string;
  trips: TripView[];
  requests: RequestView[];
  dataState: DataState;
  dataError: string;
  onRetry: () => Promise<AppData | null>;
  onCreateTrip: (value: NewTrip) => Promise<string>;
  onJoinTrip: (tripId: string) => Promise<string>;
  onRequestDecision: (requestId: string, decision: 'accepted' | 'declined') => Promise<string>;
  onRequestCancel: (requestId: string) => Promise<string>;
  onTripCancel: (tripId: string) => Promise<string>;
  onTripComplete: (tripId: string) => Promise<string>;
  onSaveProfile: (name: string, campus: string) => Promise<void>;
  onSignOut?: () => Promise<void>;
};

function Workspace(props: WorkspaceProps) {
  const { mode, profile, email, trips, requests, dataState, dataError, onSignOut } = props;
  const [page, setPage] = useState<Page>('Discover');
  const [mobileMenu, setMobileMenu] = useState(false);
  const [toast, setToast] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [query, setQuery] = useState<Query>({ from: blankPlace(), to: blankPlace() });
  const [searchError, setSearchError] = useState('');
  const [matchWarning, setMatchWarning] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ trip: TripView; detail: MatchDetail }> | null>(null);
  const [searching, setSearching] = useState(false);
  const [chatTrip, setChatTrip] = useState<TripView | null>(null);
  const chatStopRef = useRef<(() => Promise<void>) | null>(null);
  const timeout = useRef<number | undefined>(undefined);

  const registerChatStop = useCallback((stop: (() => Promise<void>) | null) => {
    chatStopRef.current = stop;
  }, []);
  const signOutWithLocationStop = useCallback(async () => {
    await chatStopRef.current?.();
    await onSignOut?.();
  }, [onSignOut]);

  useEffect(() => () => { if (timeout.current) window.clearTimeout(timeout.current); }, []);

  const notify = (message: string) => {
    setToast(message);
    if (timeout.current) window.clearTimeout(timeout.current);
    timeout.current = window.setTimeout(() => setToast(''), 3600);
  };

  const runAction = async (key: string, task: () => Promise<string>) => {
    setBusyKey(key);
    setActionError('');
    try { notify(await task()); } catch (error) { setActionError(errorText(error)); } finally { setBusyKey(''); }
  };

  const eligibleTrips = useMemo(() => {
    return trips.filter((trip) => {
      if (trip.owned || trip.status !== 'open' || trip.seatsAvailable < 1) return false;
      const departure = new Date(trip.departureAt);
      return Number.isFinite(departure.getTime()) && departure.getTime() > Date.now();
    });
  }, [trips]);

  const matches = useMemo(() => {
    if (!searchResults) return [];
    return searchResults.filter(({ trip }) => eligibleTrips.some((candidate) => candidate.id === trip.id))
      .sort((a, b) => new Date(a.trip.departureAt).getTime() - new Date(b.trip.departureAt).getTime());
  }, [searchResults, eligibleTrips]);

  const changeQuery = (next: Query) => {
    setQuery(next);
    setSearchResults(null);
    setSearchError('');
    setMatchWarning('');
  };

  const runSearch = async () => {
    if (!(query.from.userText || query.from.label).trim() || !(query.to.userText || query.to.label).trim()) {
      setSearchError('Enter both a pickup and destination to find a shared ride.');
      return;
    }
    setSearchError('');
    setMatchWarning('');
    setSearchResults(null);
    setSearching(true);
    try {
      let source = trips;
      if (mode === 'connected') {
        const fresh = await props.onRetry();
        if (!fresh) throw new Error('Trips could not be refreshed. Check the database error above and try again.');
        source = fresh.trips;
      } else {
        await new Promise((resolve) => window.setTimeout(resolve, 220));
      }

      const eligibleCandidates = source.filter((trip) => {
        if (trip.owned || trip.status !== 'open' || trip.seatsAvailable < 1) return false;
        const departure = new Date(trip.departureAt);
        return Number.isFinite(departure.getTime()) && departure.getTime() > Date.now();
      }).sort((a, b) => new Date(a.departureAt).getTime() - new Date(b.departureAt).getTime());
      const candidates = eligibleCandidates.slice(0, MAX_ROUTE_CANDIDATES);

      const resolvedSearch = await Promise.all([query.from.placeId && isGoogleMapsConfigured && !query.from.coordinates
        ? resolvePlaceId(query.from.placeId).catch(() => null) : Promise.resolve(null),
      query.to.placeId && isGoogleMapsConfigured && !query.to.coordinates
        ? resolvePlaceId(query.to.placeId).catch(() => null) : Promise.resolve(null)]);
      const searchPickup: Coordinates | null = query.from.coordinates ?? resolvedSearch[0]?.coordinates ?? null;
      const searchDestination: Coordinates | null = query.to.coordinates ?? resolvedSearch[1]?.coordinates ?? null;
      let resolutionErrors = Number(Boolean(query.from.placeId && isGoogleMapsConfigured && !query.from.coordinates && !resolvedSearch[0]))
        + Number(Boolean(query.to.placeId && isGoogleMapsConfigured && !query.to.coordinates && !resolvedSearch[1]));
      const resolvedTrips = await Promise.all(candidates.map(async (trip) => {
        let pickupLabel = trip.pickup;
        let destinationLabel = trip.destination;
        let pickupCoordinates: Coordinates | null = null;
        let destinationCoordinates: Coordinates | null = null;
        if (trip.pickupPlaceId && isGoogleMapsConfigured) {
          try { const place = await resolvePlaceId(trip.pickupPlaceId); pickupLabel = place.label; pickupCoordinates = place.coordinates; }
          catch { resolutionErrors += 1; }
        }
        if (trip.destinationPlaceId && isGoogleMapsConfigured) {
          try { const place = await resolvePlaceId(trip.destinationPlaceId); destinationLabel = place.label; destinationCoordinates = place.coordinates; }
          catch { resolutionErrors += 1; }
        }
        const match = matchRoute(
          { pickup: { label: query.from.label, placeId: query.from.placeId, coordinates: searchPickup }, destination: { label: query.to.label, placeId: query.to.placeId, coordinates: searchDestination } },
          { pickup: { label: pickupLabel, placeId: trip.pickupPlaceId, coordinates: pickupCoordinates }, destination: { label: destinationLabel, placeId: trip.destinationPlaceId, coordinates: destinationCoordinates } },
        );
        return match ? { trip, detail: { match, pickup: pickupLabel, destination: destinationLabel } } : null;
      }));
      setSearchResults(resolvedTrips.flatMap((item) => item ? [item] : []));
      if (resolutionErrors) setMatchWarning('Some saved places could not be resolved; their match uses text and may not verify proximity.');
      if (eligibleCandidates.length > candidates.length) setMatchWarning(`Checked the ${MAX_ROUTE_CANDIDATES} soonest available trips.`);
    } catch (error) {
      setSearchError(errorText(error));
    } finally {
      setSearching(false);
    }
  };

  const pendingCount = requests.filter((request) => request.status === 'pending').length;
  const changePage = (nextPage: Page) => { setPage(nextPage); setMobileMenu(false); setActionError(''); };
  const currentProfileLetter = profile.display_name.trim().charAt(0).toLocaleUpperCase() || 'R';

  return <div className="app-shell">
    <aside className={`side-nav ${mobileMenu ? 'shown' : ''}`}>
      <Brand/>
      <div className="nav-caption">YOUR SPACE</div>
      <nav>{pages.map(({ name, icon: Icon }) => <button key={name} className={`nav-item ${page === name ? 'selected' : ''}`} onClick={() => changePage(name)}><Icon size={17}/>{name}{name === 'Requests' && <span className="nav-number">{pendingCount || '—'}</span>}{name === 'Create Trip' && <span className="nav-add"><Plus size={14}/></span>}</button>)}</nav>
      <div className="side-bottom"><div className="safety-note"><ShieldCheck size={17}/><div><strong>Ride thoughtfully</strong><p>Meet in public and keep someone in the loop.</p></div></div><div className="profile-small"><span className="user-avatar">{currentProfileLetter}</span><span><b>{profile.display_name}</b><small>{mode === 'demo' ? 'Fictional demo profile' : 'Self-reported profile'}</small></span><ChevronDown size={16}/></div></div>
      <button className="side-signout" disabled={!onSignOut} onClick={() => onSignOut && void runAction('signout', async () => { await signOutWithLocationStop(); return 'Signed out.'; })}>{mode === 'connected' ? <><LogOut size={15}/> Sign out</> : <><ShieldCheck size={15}/> Local demo</>}</button>
    </aside>
    {mobileMenu && <button className="scrim" onClick={() => setMobileMenu(false)} aria-label="Close menu"/>}
    <main className="main-area">
      <header className="top-bar"><button className="icon-button mobile-menu-button" onClick={() => setMobileMenu(true)} aria-label="Open menu"><Menu size={20}/></button><div className="crumb">RouteMates <span>/</span> <b>{page}</b></div><div className="top-right"><span className={`demo-status ${mode === 'connected' ? 'connected' : ''}`}><i/>{mode === 'demo' ? 'Demo · fictional data' : 'Supabase · connected'}</span><button className="icon-button bell" aria-label="Open requests" onClick={() => changePage('Requests')}><Bell size={18}/></button><span className="user-avatar top-user">{currentProfileLetter}</span></div></header>
      {dataError && <div className="data-error-banner" role="alert"><CircleHelp size={17}/><span><b>Database request failed.</b> {dataError}</span>{mode === 'connected' && <button onClick={() => void props.onRetry()}>Retry</button>}</div>}
      {actionError && <div className="data-error-banner" role="alert"><CircleHelp size={17}/><span><b>Action not completed.</b> {actionError}</span><button onClick={() => setActionError('')} aria-label="Dismiss error"><X size={15}/></button></div>}
      {page === 'Discover' && <DiscoverPage results={matches} hasSearched={searchResults !== null} query={query} setQuery={changeQuery} searching={searching} searchError={searchError} matchWarning={matchWarning} onSearch={runSearch} onJoin={(tripId) => void runAction(`join-${tripId}`, () => props.onJoinTrip(tripId))} onOpenChat={setChatTrip} busyKey={busyKey}/>}
      {page === 'Create Trip' && <CreateTripPage mode={mode} busy={busyKey === 'create'} onCancel={() => changePage('Discover')} onCreate={async (value) => {
        setBusyKey('create');
        setActionError('');
        try {
          notify(await props.onCreateTrip(value));
          changePage('My Trips');
        } catch (error) {
          setActionError(errorText(error));
          throw error;
        } finally {
          setBusyKey('');
        }
      }}/>}
      {page === 'My Trips' && <MyTripsPage mode={mode} trips={trips.filter((trip) => trip.owned)} dataState={dataState} busyKey={busyKey} onCreate={() => changePage('Create Trip')} onCancel={(id) => void runAction(`cancel-trip-${id}`, () => props.onTripCancel(id))} onComplete={(id) => void runAction(`complete-trip-${id}`, () => props.onTripComplete(id))} onOpenChat={setChatTrip}/>}
      {page === 'Requests' && <RequestsPage requests={requests} dataState={dataState} busyKey={busyKey} mode={mode} onExplore={() => changePage('Discover')} onDecision={(id, decision) => void runAction(`decision-${id}`, () => props.onRequestDecision(id, decision))} onCancel={(id) => void runAction(`cancel-request-${id}`, () => props.onRequestCancel(id))} onOpenChat={setChatTrip}/>}
      {page === 'Profile' && <ProfilePage mode={mode} profile={profile} email={email} onSave={props.onSaveProfile} onSignOut={onSignOut ? signOutWithLocationStop : undefined} notify={notify}/>}
    </main>
    <nav className="mobile-tabs" aria-label="Main navigation">{pages.map(({ name, icon: Icon }) => <button key={name} className={page === name ? 'active' : ''} onClick={() => changePage(name)}><Icon size={18}/><span>{name === 'Create Trip' ? 'Create' : name === 'Discover' ? 'Explore' : name}</span></button>)}</nav>
    {chatTrip && mode === 'connected' && <ChatPanel trip={chatTrip} onClose={() => setChatTrip(null)} onRegisterStop={registerChatStop}/>}
    {toast && <div className="toast" role="status"><span><Check size={15}/></span>{toast}<button onClick={() => setToast('')} aria-label="Dismiss"><X size={15}/></button></div>}
  </div>;
}

function Brand() {
  return <div className="brand"><span className="brand-symbol"><ArrowRight size={17}/></span><span>route<span>mates</span></span></div>;
}

function DiscoverPage({ results, hasSearched, query, setQuery, searching, searchError, matchWarning, onSearch, onJoin, onOpenChat, busyKey }: {
  results: Array<{ trip: TripView; detail: MatchDetail }>;
  hasSearched: boolean;
  query: Query;
  setQuery: (query: Query) => void;
  searching: boolean;
  searchError: string;
  matchWarning: string;
  onSearch: () => void;
  onJoin: (id: string) => void;
  onOpenChat: (trip: TripView) => void;
  busyKey: string;
}) {
  return <section className="discover-page">
    <header className="discover-heading"><span className="eyebrow">ROUTEMATES</span><h1>Where are you headed?</h1><p>Find people travelling a similar way.</p></header>
    <form className="discover-form" onSubmit={(event) => { event.preventDefault(); onSearch(); }}>
      <div className="location-stack">
        <LocationInput label="From" value={query.from} onChange={(from) => setQuery({ ...query, from })} placeholder="Pickup location"/>
        <LocationInput label="To" value={query.to} onChange={(to) => setQuery({ ...query, to })} placeholder="Destination"/>
      </div>
      {searchError && <div className="inline-error" role="alert"><CircleHelp size={15}/>{searchError}</div>}
      <button className="primary-action" type="submit" disabled={searching}>{searching ? <><LoaderCircle size={17} className="spin-icon"/>Finding rides…</> : <>Find shared rides <ArrowRight size={17}/></>}</button>
    </form>
    {matchWarning && <p className="discover-note" role="status">{matchWarning}</p>}
    {(searching || hasSearched) && <section className="discover-results" aria-live="polite" aria-busy={searching}>
      {results.length > 0 && <h2>{results.length === 1 ? '1 ride found' : `${results.length} rides found`}</h2>}
      {searching ? <div className="discover-status"><span className="spinner dark"/>Finding nearby rides…</div>
        : results.length ? <div className="match-list">{results.map(({ trip, detail }) => <TripCard key={trip.id} trip={{ ...trip, pickup: detail.pickup ?? trip.pickup, destination: detail.destination ?? trip.destination }} compact matchReason={detail.match.reason} busy={busyKey === `join-${trip.id}`} onJoin={() => onJoin(trip.id)} onChat={trip.chatAvailable ? () => onOpenChat(trip) : undefined}/>)}</div>
            : hasSearched && !searchError ? <p className="discover-empty">No matching rides yet.</p> : null}
    </section>}
  </section>;
}

function TripCard({ trip, mode, busy, onJoin, onCancel, onComplete, onChat, matchReason, compact = false }: {
  trip: TripView;
  mode?: 'demo' | 'connected';
  busy: boolean;
  onJoin?: () => void;
  onCancel?: () => void;
  onComplete?: () => void;
  onChat?: () => void;
  matchReason?: string;
  compact?: boolean;
}) {
  if (compact) return <article className="match-card">
    <h3>{trip.hostName}</h3>
    <div className="match-route"><span>{trip.pickup}</span><ArrowRight size={15} aria-hidden="true"/><span>{trip.destination}</span></div>
    <div className="match-meta"><span><Clock3 size={15}/>{dateLabel(trip.departureAt)} · {timeLabel(trip.departureAt)}</span><span><Users size={15}/>{trip.seatsAvailable} {trip.seatsAvailable === 1 ? 'seat' : 'seats'} available</span></div>
    {matchReason && <p className="match-reason">{matchReason}</p>}
    <div className="match-action">
      {trip.requestStatus === 'accepted' ? onChat
        ? <button className="request-button" onClick={onChat}><MessageCircle size={15}/>Open trip chat</button>
        : <span className="request-status status-accepted">Accepted</span>
        : trip.requestStatus ? <span className={`request-status status-${trip.requestStatus}`}>{statusLabel(trip.requestStatus)}</span>
          : onJoin && <button className="request-button" disabled={busy || trip.seatsAvailable < 1} aria-label={`Request to join ${trip.hostName}'s trip`} onClick={onJoin}>{busy ? <><span className="spinner"/>Sending…</> : <>Request to join <ArrowRight size={15}/></>}</button>}
    </div>
  </article>;
  const initials = trip.hostName.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toLocaleUpperCase();
  const canComplete = trip.owned && ['open', 'full'].includes(trip.status) && new Date(trip.departureAt).getTime() <= Date.now();
  return <article className="ride-card">
    <div className="ride-card-top"><span className="person-avatar">{initials}</span><div className="person-label"><b>{trip.hostName}</b><small>{trip.owned ? 'Your trip' : mode === 'demo' ? 'Fictional sample profile' : 'Self-reported · unverified'}</small></div><span className="compatibility"><i/>{trip.owned ? statusLabel(trip.status) : trip.requestStatus ? statusLabel(trip.requestStatus) : 'Open trip'}</span></div>
    <div className="ride-route"><div className="route-rail"><i/><span/><i/></div><div className="route-names"><div><b>{trip.pickup}</b><small>Pickup</small></div><div><b>{trip.destination}</b><small>Destination</small></div></div></div>
    <div className="ride-meta"><span><Clock3 size={15}/>{dateLabel(trip.departureAt)} · {timeLabel(trip.departureAt)}</span><span><Users size={15}/>{trip.seatsAvailable} {trip.seatsAvailable === 1 ? 'seat' : 'seats'} remaining</span></div>
    {matchReason && <p className="match-reason"><MapPin size={14}/>{matchReason}</p>}
    <div className="ride-card-bottom">
      {trip.owned ? <div className="trip-owner-actions">{onChat && <button className="secondary-button" onClick={onChat}><MessageCircle size={15}/>Trip chat</button>}{onCancel && ['open', 'full'].includes(trip.status) && <button className="secondary-button" disabled={busy} onClick={onCancel}>{busy ? 'Working…' : 'Cancel trip'}</button>}{onComplete && canComplete && <button className="black-button" disabled={busy} onClick={onComplete}>Complete</button>}</div>
        : trip.requestStatus === 'accepted' ? <div className="trip-owner-actions"><span className="request-status status-accepted">Accepted</span>{onChat && <button className="black-button" onClick={onChat}><MessageCircle size={15}/>Open trip chat</button>}</div>
          : trip.requestStatus ? <span className={`request-status status-${trip.requestStatus}`}>{statusLabel(trip.requestStatus)}</span>
            : onJoin && <button className="request-button" disabled={busy || trip.seatsAvailable < 1} onClick={onJoin}>{busy ? <><span className="spinner"/>Sending…</> : <>Request to join <ArrowRight size={15}/></>}</button>}
    </div>
    {trip.note && <div className="ride-note">“{trip.note}” <span>{mode === 'demo' ? '· Fictional demo trip' : '· Trip note'}</span></div>}
  </article>;
}

function CreateTripPage({ mode, busy, onCancel, onCreate }: { mode: 'demo' | 'connected'; busy: boolean; onCancel: () => void; onCreate: (value: NewTrip) => Promise<void> }) {
  const [pickup, setPickup] = useState<PlaceValue>(blankPlace());
  const [destination, setDestination] = useState<PlaceValue>(blankPlace());
  const [form, setForm] = useState({ date: '', time: '', seats: '', note: '' });
  const [errors, setErrors] = useState<Partial<Record<'pickup' | 'destination' | 'date' | 'time' | 'seats' | 'note', string>>>({});
  const [submitError, setSubmitError] = useState('');
  const update = (key: keyof typeof form, value: string) => {
    setForm((old) => ({ ...old, [key]: value }));
    setErrors((old) => ({ ...old, [key]: undefined }));
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitError('');
    const validated = validateTripForm({
      pickup: pickup.userText || pickup.label,
      destination: destination.userText || destination.label,
      date: form.date,
      time: form.time,
      seats: form.seats,
      note: form.note,
    });
    const nextErrors = { ...validated.errors };
    if (pickup.placeId && pickup.placeId === destination.placeId) nextErrors.destination = 'Pickup and destination must be different places.';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length || !validated.value) return;
    try {
      await onCreate({
        ...validated.value,
        pickup_provider: pickup.provider,
        pickup_place_id: pickup.placeId,
        destination_provider: destination.provider,
        destination_place_id: destination.placeId,
      });
    } catch (caught) {
      setSubmitError(errorText(caught));
    }
  };
  const minDate = localDateKey(new Date());
  return <section className="other-page">
    <button className="back-button" onClick={onCancel}>← Back to discover</button>
    <header className="page-heading"><span className="eyebrow">MAKE ROOM FOR A MATE</span><h1>Create a trip</h1><p>Share a route and departure time. Other eligible members can request a seat.</p></header>
    <form className="trip-form" noValidate onSubmit={(event) => void submit(event)}>
      <FormSection n="01" title="Your route" detail="Choose a place or type a clear location label others will recognize.">
        <div className="form-grid">
          <div><LocationInput label="Pickup location" value={pickup} onChange={(value) => { setPickup(value); setErrors((old) => ({ ...old, pickup: undefined })); }} placeholder="e.g. Majestic Bus Station" invalid={Boolean(errors.pickup)}/>{errors.pickup && <small className="field-error">{errors.pickup}</small>}</div>
          <div><LocationInput label="Destination" value={destination} onChange={(value) => { setDestination(value); setErrors((old) => ({ ...old, destination: undefined })); }} placeholder="e.g. Kempegowda International Airport" invalid={Boolean(errors.destination)}/>{errors.destination && <small className="field-error">{errors.destination}</small>}</div>
        </div>
        <p className="form-helper">Google place names and coordinates are shown transiently. The location label shared with other users is your own typed text; only the place ID is saved.</p>
      </FormSection>
      <FormSection n="02" title="Time & seats" detail="Set the local departure date and choose how many seats are available.">
        <div className="form-grid three">
          <label>Departure date<input type="date" value={form.date} min={minDate} aria-invalid={Boolean(errors.date)} onChange={(event) => update('date', event.target.value)}/>{errors.date && <small className="field-error">{errors.date}</small>}</label>
          <label>Departure time<input type="time" value={form.time} aria-invalid={Boolean(errors.time)} onChange={(event) => update('time', event.target.value)}/>{errors.time && <small className="field-error">{errors.time}</small>}</label>
          <label>Available seats<select value={form.seats} aria-invalid={Boolean(errors.seats)} onChange={(event) => update('seats', event.target.value)}><option value="">Choose seats</option><option value="1">1 seat</option><option value="2">2 seats</option><option value="3">3 seats</option><option value="4">4 seats</option></select>{errors.seats && <small className="field-error">{errors.seats}</small>}</label>
        </div>
        <label className="note-field">Trip note <span className="optional">Optional</span><textarea value={form.note} maxLength={500} rows={3} onChange={(event) => update('note', event.target.value)} placeholder="Anything your travel mates should know?"/>{errors.note && <small className="field-error">{errors.note}</small>}</label>
      </FormSection>
      {submitError && <div className="form-error" role="alert"><CircleHelp size={16}/>{submitError}</div>}
      <div className="form-footer"><span><ShieldCheck size={15}/>{mode === 'demo' ? 'Demo trip stays in this browser.' : 'Only authenticated members can discover this trip.'}</span><div><button type="button" className="secondary-button" onClick={onCancel}>Cancel</button><button className="black-button" type="submit" disabled={busy}>{busy ? 'Posting…' : 'Post trip'} <ArrowRight size={15}/></button></div></div>
    </form>
  </section>;
}

function FormSection({ n, title, detail, children }: { n: string; title: string; detail: string; children: ReactNode }) {
  return <div className="form-section"><div className="form-section-heading"><span>{n}</span><div><b>{title}</b><small>{detail}</small></div></div>{children}</div>;
}

function MyTripsPage({ mode, trips, dataState, busyKey, onCreate, onCancel, onComplete, onOpenChat }: {
  mode: 'demo' | 'connected'; trips: TripView[]; dataState: DataState; busyKey: string;
  onCreate: () => void; onCancel: (id: string) => void; onComplete: (id: string) => void;
  onOpenChat: (trip: TripView) => void;
}) {
  return <section className="other-page"><header className="page-heading"><span className="eyebrow">YOUR PLANS</span><h1>My Trips</h1><p>{mode === 'demo' ? 'Trips created in this browser demo.' : 'Trips you’ve created from this account.'}</p></header>
    {dataState === 'loading' && !trips.length ? <div className="result-status"><span className="spinner dark"/>Loading your trips…</div>
      : dataState === 'error' && !trips.length ? <div className="result-status">Trips could not be loaded. Retry the database request above.</div>
        : trips.length ? <div className="other-rides">{trips.map((trip) => <TripCard key={trip.id} trip={trip} mode={mode} busy={busyKey.includes(trip.id)} onCancel={() => onCancel(trip.id)} onComplete={() => onComplete(trip.id)} onChat={trip.chatAvailable ? () => onOpenChat(trip) : undefined}/>)}</div>
          : <EmptyState icon={<CarFront size={19}/>} title="No trips created yet" detail="Add a route and let eligible signed-in members find their way with you." action="Create a trip" onAction={onCreate}/>}</section>;
}

function RequestsPage({ requests, dataState, busyKey, mode, onExplore, onDecision, onCancel, onOpenChat }: {
  requests: RequestView[]; dataState: DataState; busyKey: string; mode: 'demo' | 'connected'; onExplore: () => void;
  onDecision: (id: string, decision: 'accepted' | 'declined') => void; onCancel: (id: string) => void;
  onOpenChat: (trip: TripView) => void;
}) {
  const incoming = requests.filter((request) => request.direction === 'received');
  const outgoing = requests.filter((request) => request.direction === 'sent');
  return <section className="other-page"><header className="page-heading"><span className="eyebrow">STAY IN THE LOOP</span><h1>Requests</h1><p>{mode === 'demo' ? 'Demo requests stay on this device and are not sent to another account.' : 'Review requests for your trips and track the seats you requested.'}</p></header>
    {dataState === 'loading' && !requests.length ? <div className="result-status"><span className="spinner dark"/>Loading requests…</div>
      : dataState === 'error' && !requests.length ? <div className="result-status">Requests could not be loaded. Retry the database request above.</div>
        : <>
          <section className="request-section"><div className="section-title"><h2>For your trips</h2><span>{incoming.filter((request) => request.status === 'pending').length} pending</span></div>{incoming.length ? <div className="request-list">{incoming.map((request) => <RequestRow key={request.id} request={request} busyKey={busyKey} onDecision={onDecision} onOpenChat={onOpenChat}/>)}</div> : <p className="section-empty">No requests for your trips.</p>}</section>
          <section className="request-section"><div className="section-title"><h2>Your requests</h2><span>{outgoing.length}</span></div>{outgoing.length ? <div className="request-list">{outgoing.map((request) => <SentRequestRow key={request.id} request={request} busy={busyKey === `cancel-request-${request.id}`} onCancel={() => onCancel(request.id)} onOpenChat={onOpenChat}/>)}</div> : <EmptyState icon={<Bell size={19}/>} title="No requests yet" detail="When you request a seat, its status will appear here." action="Find a ride" onAction={onExplore}/>}</section>
        </>}
    <p className="local-note"><ShieldCheck size={14}/>{mode === 'demo' ? 'This browser demo has no cross-user sharing.' : 'Names are self-reported and unverified. Requests do not book a cab.'}</p>
  </section>;
}

function RequestRow({ request, busyKey, onDecision, onOpenChat }: {
  request: RequestView; busyKey: string; onDecision: (id: string, decision: 'accepted' | 'declined') => void;
  onOpenChat: (trip: TripView) => void;
}) {
  const busy = busyKey === `decision-${request.id}`;
  const canAccept = request.status === 'pending' && request.trip?.status === 'open' && request.trip.seatsAvailable > 0 && new Date(request.trip.departureAt).getTime() > Date.now();
  return <article className="request-row incoming-row"><span className="person-avatar">{request.otherPerson.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toLocaleUpperCase()}</span>
    <div className="request-main"><b>{request.otherPerson} requested to join</b><small>{request.trip ? <>{request.trip.pickup} <ArrowRight size={12}/> {request.trip.destination}</> : 'Trip details are unavailable to this account.'}</small>{request.message && <small>“{request.message}”</small>}</div>
    <span className={`pending status-${request.status}`}>{statusLabel(request.status)}</span>
    {request.status === 'pending' && <div className="request-actions"><button className="secondary-button" disabled={busy} onClick={() => onDecision(request.id, 'declined')}>Decline</button><button className="black-button" disabled={busy || !canAccept} title={!canAccept ? 'Acceptance requires an open trip, a future departure and remaining seats.' : undefined} onClick={() => onDecision(request.id, 'accepted')}>{busy ? 'Saving…' : 'Accept'}</button></div>}
    {request.status === 'pending' && !canAccept && <small className="action-hint">This trip cannot accept a request now.</small>}
    {request.status === 'accepted' && request.trip?.chatAvailable && <button className="black-button chat-open-button" onClick={() => onOpenChat(request.trip!)}><MessageCircle size={15}/>Open trip chat</button>}
  </article>;
}

function SentRequestRow({ request, busy, onCancel, onOpenChat }: { request: RequestView; busy: boolean; onCancel: () => void; onOpenChat: (trip: TripView) => void }) {
  return <article className="request-row"><span className="person-avatar">{request.otherPerson.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toLocaleUpperCase()}</span>
    <div className="request-main"><b>{request.trip ? `Request to join ${request.otherPerson}’s trip` : 'Your trip request'}</b><small>{request.trip ? <>{request.trip.pickup} <ArrowRight size={12}/> {request.trip.destination}</> : 'Trip is no longer available to this account.'}</small><small>{dateLabel(request.createdAt)} · Sent</small></div>
    <span className={`pending status-${request.status}`}>{statusLabel(request.status)}</span>
    {request.status === 'pending' && <button className="secondary-button" disabled={busy} onClick={onCancel}>{busy ? 'Cancelling…' : 'Cancel request'}</button>}
    {request.status === 'accepted' && request.trip?.chatAvailable && <button className="black-button chat-open-button" onClick={() => onOpenChat(request.trip!)}><MessageCircle size={15}/>Open trip chat</button>}
  </article>;
}

type LivePoint = { key: string; label: string; coordinates: Coordinates; sentAt: number };

function ChatPanel({ trip, onClose, onRegisterStop }: {
  trip: TripView; onClose: () => void; onRegisterStop: (stop: (() => Promise<void>) | null) => void;
}) {
  const [messages, setMessages] = useState<TripMessage[]>([]);
  const [shares, setShares] = useState<LocationShareState[]>([]);
  const [livePoints, setLivePoints] = useState<LivePoint[]>([]);
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [realtimeReady, setRealtimeReady] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [error, setError] = useState('');
  const [locationError, setLocationError] = useState('');
  const [success, setSuccess] = useState('');
  const [tripEnded, setTripEnded] = useState(['cancelled', 'completed'].includes(trip.status));
  const scrollRef = useRef<HTMLDivElement>(null);
  const watchId = useRef<number | null>(null);
  const locationRefreshId = useRef<number | null>(null);
  const positionRequestPending = useRef(false);
  const positionRequestKey = useRef<string | null>(null);
  const shareKeyRef = useRef<string | null>(null);
  const activeShareKeysRef = useRef(new Set<string>());
  const shareEventRevisionRef = useRef(0);
  const sharesRef = useRef(shares);
  const refreshingSharesRef = useRef(false);
  const tripEndedRef = useRef(['cancelled', 'completed'].includes(trip.status));
  sharesRef.current = shares;
  const lastSentAt = useRef(0);
  const lastSentPosition = useRef<Coordinates | null>(null);
  const mountedRef = useRef(true);
  const startGenerationRef = useRef(createLocationShareGeneration());
  const startWorkRef = useRef<Promise<void> | null>(null);
  const startWorkGenerationRef = useRef<number | null>(null);
  const pendingRelaysRef = useRef(new Set<Promise<void>>());

  const sendLocation = useCallback((shareKey: string, coordinates: Coordinates) => {
    const tracked = relayTripLocation(trip.id, shareKey, coordinates.lat, coordinates.lng);
    pendingRelaysRef.current.add(tracked);
    void tracked.then(
      () => pendingRelaysRef.current.delete(tracked),
      () => pendingRelaysRef.current.delete(tracked),
    );
    return tracked;
  }, [trip.id]);

  const stopBrowserWatch = useCallback(() => {
    if (watchId.current !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
    if (locationRefreshId.current !== null) window.clearInterval(locationRefreshId.current);
    locationRefreshId.current = null;
    positionRequestPending.current = false;
    positionRequestKey.current = null;
    lastSentAt.current = 0;
    lastSentPosition.current = null;
  }, []);

  const stopSharing = useCallback(async (quiet = false) => {
    startGenerationRef.current.invalidate();
    if (mountedRef.current) setShareBusy(false);
    const oldKey = shareKeyRef.current;
    const stateKey = oldKey ?? sharesRef.current.find((state) => state.isSelf)?.shareKey ?? null;
    shareEventRevisionRef.current += 1;
    shareKeyRef.current = null;
    stopBrowserWatch();
    if (stateKey) activeShareKeysRef.current.delete(stateKey);
    if (stateKey) setLivePoints((old) => old.filter((point) => point.key !== stateKey));
    setShares((old) => old.map((state) => state.isSelf ? { ...state, isSharing: false, shareKey: null } : state));
    const pendingStart = startWorkRef.current;
    if (pendingStart) await pendingStart.catch(() => undefined);
    await Promise.allSettled([...pendingRelaysRef.current]);
    try {
      await setTripLocationSharing(trip.id, false);
      if (!quiet && mountedRef.current) setSuccess('The server confirmed location sharing is off.');
    }
    catch (caught) {
      if (!quiet && mountedRef.current) {
        setLocationError(`Sharing stopped on this device, but the server could not confirm revocation. The server lease expires within 30 seconds of its last accepted update. ${errorText(caught)}`);
      }
    }
  }, [stopBrowserWatch, trip.id]);

  const currentStopRef = useRef(stopSharing);
  currentStopRef.current = stopSharing;
  useEffect(() => {
    onRegisterStop(() => currentStopRef.current(true));
    return () => onRegisterStop(null);
  }, [onRegisterStop]);

  useEffect(() => {
    if (!supabase) {
      setError('Supabase is not configured. Trip chat requires a connected account.');
      setLoading(false);
      return;
    }
    let active = true;
    mountedRef.current = true;
    const client = supabase;
    const startGeneration = startGenerationRef.current;
    const pendingRelays = pendingRelaysRef.current;
    const refreshMessages = async () => {
      try {
        const rows = await loadTripMessages(trip.id);
        if (active) setMessages(rows);
      } catch (caught) {
        if (active) setError(errorText(caught));
      }
    };
    const refreshShares = async () => {
      if (refreshingSharesRef.current) return;
      refreshingSharesRef.current = true;
      const revision = shareEventRevisionRef.current;
      try {
        const values = await loadTripLocationShareStates(trip.id);
        if (!active || revision !== shareEventRevisionRef.current) return;
        const activeKeys = new Set(values.flatMap((state) => state.isSharing && state.shareKey ? [state.shareKey] : []));
        activeShareKeysRef.current = activeKeys;
        setShares(values);
        setLivePoints((old) => old.filter((point) => activeKeys.has(point.key)));
        const own = values.find((state) => state.isSelf);
        if (shareKeyRef.current && !own?.isSharing && Date.now() - lastSentAt.current >= 30_000) {
          setLocationError('No fresh device location arrived before the share expired. Sharing has been stopped.');
          void stopSharing(true);
        }
      } catch (caught) {
        if (active) setLocationError(errorText(caught));
      } finally {
        refreshingSharesRef.current = false;
      }
    };
    void Promise.all([refreshMessages(), refreshShares()]).finally(() => { if (active) setLoading(false); });

    const channel = client.channel(`trip:${trip.id}:chat`, { config: { private: true } });
    channel.on('broadcast', { event: 'message_created' }, () => { void refreshMessages(); });
    const locationChannel = client.channel(`trip:${trip.id}:location`, { config: { private: true } });
    locationChannel.on('broadcast', { event: 'location_event' }, ({ payload }) => {
      const event = payload as Record<string, unknown>;
      const kind = event.kind;
      if (kind === 'trip_ended') {
        startGenerationRef.current.invalidate();
        tripEndedRef.current = true;
        shareEventRevisionRef.current += 1;
        setTripEnded(true);
        setRealtimeReady(false);
        shareKeyRef.current = null;
        stopBrowserWatch();
        activeShareKeysRef.current.clear();
        setShares((old) => old.map((state) => ({ ...state, isSharing: false, shareKey: null })));
        setLivePoints([]);
        setShareBusy(false);
        setSuccess('Location sharing stopped because the trip ended.');
        return;
      }
      if (tripEndedRef.current) return;
      const shareKey = typeof event.share_key === 'string' ? event.share_key : null;
      const displayName = typeof event.display_name === 'string' ? event.display_name : 'RouteMates member';
      if (kind === 'sharing_status') {
        const enabled = event.enabled === true;
        shareEventRevisionRef.current += 1;
        if (shareKey && enabled) activeShareKeysRef.current.add(shareKey);
        if (shareKey && !enabled) activeShareKeysRef.current.delete(shareKey);
        if (shareKey && !enabled && shareKeyRef.current === shareKey) {
          shareKeyRef.current = null;
          stopBrowserWatch();
          setSuccess('Location sharing was stopped for this account.');
        }
        setShares((old) => {
          const known = old.some((state) => state.shareKey === shareKey);
          if (shareKey && known) return old.map((state) => state.shareKey === shareKey ? {
            ...state, displayName, isSelf: state.isSelf || shareKey === shareKeyRef.current,
            isSharing: enabled, shareKey: enabled ? shareKey : null,
          } : state);
          if (!enabled) return old;
          if (!shareKey) return old;
          return [...old, { displayName, isSelf: shareKey === shareKeyRef.current, isSharing: true, shareKey }];
        });
        if (shareKey && !enabled) setLivePoints((old) => old.filter((point) => point.key !== shareKey));
        return;
      }
      if (kind !== 'location' || !shareKey || !activeShareKeysRef.current.has(shareKey)
        || typeof event.latitude !== 'number' || !Number.isFinite(event.latitude) || event.latitude < -90 || event.latitude > 90
        || typeof event.longitude !== 'number' || !Number.isFinite(event.longitude) || event.longitude < -180 || event.longitude > 180
        || typeof event.sent_at !== 'string') return;
      const sentAt = Date.parse(event.sent_at);
      if (!Number.isFinite(sentAt) || Date.now() - sentAt > 60_000 || sentAt - Date.now() > 5000) return;
      setLivePoints((old) => [...old.filter((point) => point.key !== shareKey), {
        key: shareKey, label: displayName,
        coordinates: { lat: event.latitude as number, lng: event.longitude as number }, sentAt,
      }]);
    });
    locationChannel.subscribe((status, channelError) => {
      if (!active) return;
      setRealtimeReady(status === 'SUBSCRIBED');
      if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && channelError) setError(errorText(channelError));
    });
    channel.subscribe((status, channelError) => {
      if (!active) return;
      if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && channelError) setError(errorText(channelError));
    });

    const prune = window.setInterval(() => setLivePoints((old) => old.filter((point) => Date.now() - point.sentAt <= 60_000)), 5000);
    const refreshShareTimer = window.setInterval(() => void refreshShares(), 15_000);
    const onVisibility = () => { if (document.visibilityState === 'hidden' && shareKeyRef.current) void stopSharing(true); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      mountedRef.current = false;
      window.clearInterval(prune);
      window.clearInterval(refreshShareTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      const wasSharing = Boolean(shareKeyRef.current || sharesRef.current.some((state) => state.isSelf && state.isSharing));
      startGeneration.invalidate();
      shareEventRevisionRef.current += 1;
      shareKeyRef.current = null;
      activeShareKeysRef.current.clear();
      stopBrowserWatch();
      const pendingStart = startWorkRef.current;
      const relaysAtCleanup = [...pendingRelays];
      if (wasSharing || pendingStart || relaysAtCleanup.length) {
        void (async () => {
          if (pendingStart) await pendingStart.catch(() => undefined);
          await Promise.allSettled(relaysAtCleanup);
          try { await setTripLocationSharing(trip.id, false); } catch { /* The 30-second server lease expires if cleanup cannot reach Supabase. */ }
        })();
      }
      void client.removeChannel(channel);
      void client.removeChannel(locationChannel);
    };
  }, [trip.id, stopBrowserWatch, stopSharing]);

  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) { setError('Enter a message before sending.'); return; }
    if (trimmed.length > 1000) { setError('Keep messages under 1000 characters.'); return; }
    setSending(true);
    setError('');
    try {
      const message = await sendTripMessage(trip.id, trimmed, crypto.randomUUID());
      setMessages((old) => old.some((item) => item.id === message.id) ? old : [...old, message]);
      setBody('');
    } catch (caught) { setError(errorText(caught)); }
    finally { setSending(false); }
  };

  const startSharing = async () => {
    if (tripEndedRef.current) return;
    const generation = startGenerationRef.current.begin();
    setShareBusy(true);
    setLocationError('');
    setSuccess('');
    if (!window.isSecureContext || !navigator.geolocation) {
      setLocationError('Live location needs device permission and a secure context (HTTPS or localhost). Chat still works without it.');
      setShareBusy(false);
      return;
    }
    if (!realtimeReady) {
      setLocationError('The private trip channel is not connected yet. Retry in a moment.');
      setShareBusy(false);
      return;
    }
    navigator.geolocation.getCurrentPosition((position) => {
      if (!mountedRef.current || tripEndedRef.current || !startGenerationRef.current.isCurrent(generation)) return;
      const work = (async () => {
        let shareKey: string | null = null;
        try {
          shareKey = await setTripLocationSharing(trip.id, true);
          if (!shareKey) throw new Error('The database did not start a location share.');
          if (!mountedRef.current || tripEndedRef.current || !startGenerationRef.current.isCurrent(generation)) {
            await setTripLocationSharing(trip.id, false);
            return;
          }
          shareEventRevisionRef.current += 1;
          shareKeyRef.current = shareKey;
          activeShareKeysRef.current.add(shareKey);
          const coordinates = { lat: position.coords.latitude, lng: position.coords.longitude };
          lastSentAt.current = Date.now();
          lastSentPosition.current = coordinates;
          await sendLocation(shareKey, coordinates);
          if (!mountedRef.current || tripEndedRef.current || !startGenerationRef.current.isCurrent(generation)
            || shareKeyRef.current !== shareKey) {
            await setTripLocationSharing(trip.id, false);
            return;
          }
          setShares((old) => {
            const own = old.find((state) => state.isSelf || state.shareKey === shareKey);
            if (own) return old.map((state) => state === own ? { ...state, isSelf: true, isSharing: true, shareKey } : state);
            return [...old, { displayName: 'You', isSelf: true, isSharing: true, shareKey }];
          });
          watchId.current = navigator.geolocation.watchPosition((next) => {
            const activeKey = shareKeyRef.current;
            if (!activeKey) return;
            const nextCoordinates = { lat: next.coords.latitude, lng: next.coords.longitude };
            const elapsed = Date.now() - lastSentAt.current;
            const moved = lastSentPosition.current ? distanceKm(lastSentPosition.current, nextCoordinates) ?? 0 : Infinity;
            if (elapsed < 5000 || (moved < 0.015 && elapsed < 15000)) return;
            lastSentAt.current = Date.now();
            lastSentPosition.current = nextCoordinates;
            void sendLocation(activeKey, nextCoordinates).catch((caught: unknown) => {
              if (mountedRef.current) {
                setLocationError(errorText(caught));
                void stopSharing(true);
              } else {
                shareKeyRef.current = null;
                stopBrowserWatch();
              }
            });
          }, (geoError) => {
            if (!mountedRef.current) return;
            setLocationError(geoError.message || 'Your device could not read location.');
            void stopSharing(true);
          }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
          locationRefreshId.current = window.setInterval(() => {
            const activeKey = shareKeyRef.current;
            if (!activeKey || positionRequestPending.current || Date.now() - lastSentAt.current < 15_000) return;
            positionRequestPending.current = true;
            positionRequestKey.current = activeKey;
            navigator.geolocation.getCurrentPosition((freshPosition) => {
              if (positionRequestKey.current === activeKey) {
                positionRequestPending.current = false;
                positionRequestKey.current = null;
              }
              if (!mountedRef.current || shareKeyRef.current !== activeKey || tripEndedRef.current) return;
              if (Date.now() - freshPosition.timestamp > 10_000) {
                setLocationError('Your device did not return a fresh position. Sharing has been stopped.');
                void stopSharing(true);
                return;
              }
              const freshCoordinates = { lat: freshPosition.coords.latitude, lng: freshPosition.coords.longitude };
              lastSentAt.current = Date.now();
              lastSentPosition.current = freshCoordinates;
              void sendLocation(activeKey, freshCoordinates).catch((caught: unknown) => {
                if (mountedRef.current) {
                  setLocationError(errorText(caught));
                  void stopSharing(true);
                } else {
                  shareKeyRef.current = null;
                  stopBrowserWatch();
                }
              });
            }, (geoError) => {
              if (positionRequestKey.current === activeKey) {
                positionRequestPending.current = false;
                positionRequestKey.current = null;
              }
              if (!mountedRef.current || shareKeyRef.current !== activeKey) return;
              setLocationError(geoError.message || 'Your device could not provide a fresh location. Sharing has been stopped.');
              void stopSharing(true);
            }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 12_000 });
          }, 5000);
          setSuccess('Live location sharing is on for accepted trip participants.');
        } catch (caught) {
          shareKeyRef.current = null;
          stopBrowserWatch();
          activeShareKeysRef.current.delete(shareKey ?? '');
          if (shareKey) setLivePoints((old) => old.filter((point) => point.key !== shareKey));
          try { await setTripLocationSharing(trip.id, false); } catch { /* The 30-second server lease expires if cleanup cannot reach Supabase. */ }
          if (mountedRef.current && startGenerationRef.current.isCurrent(generation)) setLocationError(errorText(caught));
        } finally {
          if (startWorkGenerationRef.current === generation) {
            startWorkRef.current = null;
            startWorkGenerationRef.current = null;
          }
          if (mountedRef.current && startGenerationRef.current.isCurrent(generation)) setShareBusy(false);
        }
      })();
      startWorkRef.current = work;
      startWorkGenerationRef.current = generation;
      void work;
    }, (geoError) => {
      if (!mountedRef.current || !startGenerationRef.current.isCurrent(generation)) return;
      setLocationError(geoError.message || 'Location permission was denied. Chat still works without sharing.');
      setShareBusy(false);
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
  };

  const ownShare = shares.find((state) => state.isSelf);
  const isSharingHere = Boolean(shareKeyRef.current);
  const liveParticipants = shares.filter((state) => state.isSharing).map((state) => state.displayName);
  const close = async () => { if (shareKeyRef.current || ownShare?.isSharing) await stopSharing(true); onClose(); };
  const canSendMessage = ['open', 'full'].includes(trip.status);

  return <div className="dialog-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) void close(); }}>
    <section className="chat-dialog" role="dialog" aria-modal="true" aria-labelledby="chat-title">
      <header className="chat-header"><div><span className="eyebrow">ACCEPTED TRIP</span><h2 id="chat-title">Trip chat</h2><p>{trip.pickup} <ArrowRight size={13}/> {trip.destination}</p></div><button className="icon-button" onClick={() => void close()} aria-label="Close trip chat"><X size={19}/></button></header>
      <div className="chat-status-bar"><span className={realtimeReady ? 'online-dot' : 'offline-dot'}/>{realtimeReady ? 'Private location channel connected' : 'Connecting to private location channel…'}<small>Only the host and accepted riders can join.</small></div>
      {error && <div className="inline-error" role="alert"><CircleHelp size={15}/>{error}</div>}
      <div className="chat-messages" ref={scrollRef} aria-live="polite">
        {loading ? <div className="result-status"><span className="spinner dark"/>Loading conversation…</div>
          : messages.length ? messages.map((message) => <article key={message.id} className={`chat-message ${message.isSelf ? 'mine' : ''}`}><small>{message.isSelf ? 'You' : message.senderName} · {timeLabel(message.createdAt)}</small><p>{message.body}</p></article>)
            : <div className="chat-empty"><MessageCircle size={20}/><b>No messages yet</b><span>Coordinate a meeting point and travel details here.</span></div>}
      </div>
      <form className="chat-compose" onSubmit={(event) => void send(event)}><label htmlFor="trip-message">Message</label><textarea id="trip-message" value={body} maxLength={1000} rows={2} disabled={!canSendMessage} onChange={(event) => setBody(event.target.value)} placeholder={canSendMessage ? 'Write to accepted trip participants…' : 'Trip ended · conversation is read-only'}/><div className="chat-compose-footer"><small>{body.length}/1000{!canSendMessage && ' · Read-only after trip end'}</small><button className="black-button" disabled={sending || !body.trim() || !canSendMessage}>{sending ? 'Sending…' : 'Send'} <Send size={15}/></button></div></form>
      <section className="location-sharing-panel"><div className="sharing-heading"><div><span className="eyebrow">OPTIONAL · DEVICE PERMISSION</span><h3>Live location</h3></div>{isSharingHere || ownShare?.isSharing ? <button className="stop-sharing" onClick={() => void stopSharing()} aria-label="Stop live location sharing">Stop sharing</button> : shareBusy ? <button className="secondary-button" onClick={() => void stopSharing()} aria-label="Cancel location sharing start">Cancel start</button> : <button className="secondary-button" disabled={!realtimeReady || tripEnded} onClick={() => void startSharing()}>Share live location</button>}</div>
        <p>Sharing is off unless you turn it on. It needs device permission and HTTPS (localhost is suitable for development), and runs only while RouteMates stays open and visible. Chat remains available if permission is denied.</p>
        {(isSharingHere || ownShare?.isSharing) && <div className="sharing-live-note"><span className="online-dot"/>{isSharingHere ? 'You are sharing with accepted participants.' : 'A live-share session for this account is active; stop it here before leaving.'}</div>}
        {locationError && <div className="form-error" role="alert">{locationError}</div>}{success && <div className="form-success" role="status">{success}</div>}
        <div className="sharing-roster">{shares.map((state, index) => <span key={`${state.shareKey ?? state.displayName}-${index}`}><i className={state.isSharing ? 'sharing-dot' : ''}/>{state.isSelf ? 'You' : state.displayName}: {state.isSharing ? 'sharing' : 'not sharing'}</span>)}</div>
        <LiveLocationMap points={livePoints.map(({ key, label, coordinates }) => ({ key, label, coordinates }))}/>
        <small className="location-privacy-note">Only accepted trip participants can access live points. Coordinates are sent through Supabase Realtime's HTTP relay and are not inserted into Database Broadcast history. RouteMates stores only short-lived opt-in state and timestamps; points expire from this view after 60 seconds.</small>
        {liveParticipants.length > 0 && <span className="sr-only">Sharing: {liveParticipants.join(', ')}</span>}
      </section>
    </section>
  </div>;
}

function ProfilePage({ mode, profile, email, onSave, onSignOut, notify }: { mode: 'demo' | 'connected'; profile: Profile; email: string; onSave: (name: string, campus: string) => Promise<void>; onSignOut?: () => Promise<void>; notify: (message: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(profile.display_name);
  const [campus, setCampus] = useState(profile.campus ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (displayName.trim().length < 2) { setError('Display name must have at least two characters.'); return; }
    setBusy(true);
    setError('');
    try { await onSave(displayName, campus); setEditing(false); notify('Profile updated.'); } catch (caught) { setError(errorText(caught)); } finally { setBusy(false); }
  };
  const initial = profile.display_name.trim().charAt(0).toLocaleUpperCase() || 'R';
  return <section className="other-page"><header className="page-heading"><span className="overline">YOUR ROUTEMATES PROFILE</span><h1>Profile</h1><p>{mode === 'demo' ? 'A fictional profile stored only in this browser.' : 'Your account details and self-reported profile.'}</p></header><div className="profile-card"><span className="profile-banner"/><div className="profile-content"><span className="profile-avatar">{initial}</span><div className="profile-person"><h2>{profile.display_name}</h2><span><ShieldCheck size={14}/>{mode === 'demo' ? 'Fictional demo profile' : 'Self-reported · unverified'}</span></div><button className="secondary-button" onClick={() => { setEditing(!editing); setError(''); }}>{editing ? 'Close editor' : 'Edit profile'}</button><div className="profile-facts"><div><small>CAMPUS OR COMMUNITY</small><b>{profile.campus || 'Not provided'}</b></div><div><small>ACCOUNT</small><b>{mode === 'demo' ? 'Local demo only' : email}</b></div><div><small>VISIBILITY</small><b>Campus stays private</b></div></div></div></div>
    {editing && <form className="profile-edit-form" onSubmit={(event) => void save(event)}><label>Display name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} required/></label><label>Campus or community <span className="optional">Private</span><input value={campus} onChange={(event) => setCampus(event.target.value)} maxLength={120}/></label>{error&&<div className="form-error">{error}</div>}<div className="form-footer"><span>Names are not verified by RouteMates.</span><button className="black-button" disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button></div></form>}{error && !editing && <div className="form-error">{error}</div>}
    <div className="privacy-card"><ShieldCheck size={18}/><div><b>{mode === 'demo' ? 'Your information stays local' : 'Your profile privacy'}</b><p>{mode === 'demo' ? 'This prototype uses fictional sample people. Demo trips and requests are local and do not reach other users.' : 'Only you can read or edit your full profile. Discovery exposes only a host’s self-reported display name. Campus remains private.'}</p></div></div>{mode === 'connected' && onSignOut && <button className="secondary-button profile-signout" onClick={() => void onSignOut().then(() => notify('Signed out.')).catch((caught: unknown) => setError(errorText(caught)))}>Sign out</button>}</section>;
}

function EmptyState({ icon, title, detail, action, onAction }: { icon: ReactNode; title: string; detail: string; action: string; onAction: () => void }) {
  return <div className="large-empty"><span>{icon}</span><b>{title}</b><p>{detail}</p><button className="black-button" onClick={onAction}>{action} <ArrowRight size={15}/></button></div>;
}

export default App;
