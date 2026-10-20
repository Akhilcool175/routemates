import { createClient } from '@supabase/supabase-js';

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type TripStatus = 'open' | 'full' | 'cancelled' | 'completed';
export type RideRequestStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: { id: string; display_name: string; campus: string | null; created_at: string };
        Insert: { id: string; display_name: string; campus?: string | null; created_at?: string };
        Update: { id?: string; display_name?: string; campus?: string | null; created_at?: string };
        Relationships: [];
      };
      trips: {
        Row: {
          id: string;
          user_id: string;
          pickup_label: string;
          destination_label: string;
          departure_at: string;
          seats_available: number;
          estimated_fare_per_person: number | null;
          pickup_provider: string | null;
          pickup_place_id: string | null;
          destination_provider: string | null;
          destination_place_id: string | null;
          note: string | null;
          status: TripStatus;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string;
          pickup_label: string;
          destination_label: string;
          departure_at: string;
          seats_available: number;
          estimated_fare_per_person?: number | null;
          pickup_provider?: string | null;
          pickup_place_id?: string | null;
          destination_provider?: string | null;
          destination_place_id?: string | null;
          note?: string | null;
          status?: TripStatus;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          pickup_label?: string;
          destination_label?: string;
          departure_at?: string;
          seats_available?: number;
          estimated_fare_per_person?: number | null;
          pickup_provider?: string | null;
          pickup_place_id?: string | null;
          destination_provider?: string | null;
          destination_place_id?: string | null;
          note?: string | null;
          status?: TripStatus;
          created_at?: string;
        };
        Relationships: [{
          foreignKeyName: 'trips_user_id_fkey';
          columns: ['user_id'];
          isOneToOne: false;
          referencedRelation: 'profiles';
          referencedColumns: ['id'];
        }];
      };
      ride_requests: {
        Row: {
          id: string;
          trip_id: string;
          requester_id: string;
          message: string | null;
          status: RideRequestStatus;
          created_at: string;
        };
        Insert: {
          id?: string;
          trip_id: string;
          requester_id?: string;
          message?: string | null;
          status?: RideRequestStatus;
          created_at?: string;
        };
        Update: {
          id?: string;
          trip_id?: string;
          requester_id?: string;
          message?: string | null;
          status?: RideRequestStatus;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'ride_requests_trip_id_fkey';
            columns: ['trip_id'];
            isOneToOne: false;
            referencedRelation: 'trips';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'ride_requests_requester_id_fkey';
            columns: ['requester_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      ride_messages: {
        Row: {
          id: string;
          trip_id: string;
          sender_id: string | null;
          sender_display_name: string;
          client_nonce: string;
          body: string;
          created_at: string;
        };
        Insert: { id?: string; trip_id: string; client_nonce?: string; body: string; created_at?: string };
        Update: never;
        Relationships: [];
      };
      trip_location_shares: {
        Row: { trip_id: string; user_id: string; share_key: string | null; enabled: boolean; last_broadcast_at: string | null; expires_at: string | null; changed_at: string };
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      is_trip_owner: { Args: { p_trip_id: string }; Returns: boolean };
      get_open_trip_host_names: {
        Args: { p_trip_ids: string[] | null };
        Returns: { trip_id: string; public_display_name: string }[];
      };
      get_ride_requester_names: {
        Args: { p_request_ids: string[] | null };
        Returns: { request_id: string; public_display_name: string }[];
      };
      cancel_trip: { Args: { p_trip_id: string }; Returns: string };
      complete_trip: { Args: { p_trip_id: string }; Returns: string };
      cancel_ride_request: { Args: { p_request_id: string }; Returns: string };
      respond_to_ride_request: {
        Args: { p_request_id: string; p_decision: 'accepted' | 'declined' };
        Returns: string;
      };
      is_trip_participant: { Args: { p_trip_id: string }; Returns: boolean };
      can_send_trip_message: { Args: { p_trip_id: string }; Returns: boolean };
      get_trip_messages: {
        Args: { p_trip_id: string };
        Returns: { id: string; trip_id: string; sender_display_name: string; client_nonce: string; body: string; created_at: string; is_self: boolean }[];
      };
      get_trip_location_share_states: {
        Args: { p_trip_id: string };
        Returns: { public_display_name: string; is_self: boolean; is_sharing: boolean; share_key: string | null }[];
      };
      set_trip_location_sharing: { Args: { p_trip_id: string; p_enabled: boolean }; Returns: string | null };
      broadcast_trip_location: { Args: { p_trip_id: string; p_share_key: string; p_latitude: number; p_longitude: number }; Returns: undefined };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

export type SupabaseMode = 'demo' | 'configured' | 'incomplete' | 'invalid';
const credentialsPresent = Boolean(supabaseUrl && supabaseAnonKey);
const validUrl = (() => {
  if (!supabaseUrl) return false;
  try {
    const parsed = new URL(supabaseUrl);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
})();
export const supabaseMode: SupabaseMode = !supabaseUrl && !supabaseAnonKey
  ? 'demo'
  : !credentialsPresent
    ? 'incomplete'
    : validUrl
      ? 'configured'
      : 'invalid';
export const supabaseConfigError = supabaseMode === 'invalid'
  ? 'VITE_SUPABASE_URL must be a valid http or https URL.'
  : supabaseMode === 'incomplete'
    ? 'Set both VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'
    : '';

/** Never put a service-role key in this browser client. */
export const supabase = supabaseMode === 'configured'
  ? createClient<Database>(supabaseUrl!, supabaseAnonKey!, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

export const isSupabaseConfigured = supabaseMode === 'configured';
