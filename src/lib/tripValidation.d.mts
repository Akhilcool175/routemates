export type TripForm = {
  pickup: string;
  destination: string;
  date: string;
  time: string;
  seats: string;
  note: string;
};

export type NewTripFormValue = {
  pickup_label: string;
  destination_label: string;
  departure_at: string;
  seats_available: number;
  note: string | null;
};

export function validateTripForm(form: TripForm, now?: number): {
  errors: Partial<Record<keyof TripForm, string>>;
  value: NewTripFormValue | null;
};
