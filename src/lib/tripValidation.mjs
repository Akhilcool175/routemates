export function validateTripForm(form, now = Date.now()) {
  const errors = {};
  const pickup = String(form.pickup ?? '').trim();
  const destination = String(form.destination ?? '').trim();

  if (!pickup) errors.pickup = 'Enter a pickup location.';
  if (!destination) errors.destination = 'Enter a destination.';
  if (pickup && destination && pickup.toLocaleLowerCase() === destination.toLocaleLowerCase()) {
    errors.destination = 'Pickup and destination must be different places.';
  }
  if (!form.date) errors.date = 'Choose a departure date.';
  if (!form.time) errors.time = 'Choose a departure time.';

  const departure = form.date && form.time ? new Date(`${form.date}T${form.time}:00`) : null;
  if (departure && Number.isNaN(departure.getTime())) {
    errors.time = 'Enter a valid local date and time.';
  } else if (departure && departure.getTime() <= now) {
    errors.time = 'Departure must be in the future.';
  }

  const seats = Number(form.seats);
  if (!form.seats || !Number.isInteger(seats) || seats < 1 || seats > 4) {
    errors.seats = 'Choose between one and four available seats.';
  }
  if (String(form.note ?? '').length > 500) errors.note = 'Keep the note under 500 characters.';

  if (Object.keys(errors).length) return { errors, value: null };
  return {
    errors,
    value: {
      pickup_label: pickup,
      destination_label: destination,
      departure_at: departure.toISOString(),
      seats_available: seats,
      note: String(form.note ?? '').trim() || null,
    },
  };
}
