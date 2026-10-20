/** A small generation gate for invalidating pending device permission callbacks. */
export function createLocationShareGeneration() {
  let generation = 0;

  return {
    begin() {
      generation += 1;
      return generation;
    },
    invalidate() {
      generation += 1;
      return generation;
    },
    isCurrent(candidate) {
      return candidate === generation;
    },
  };
}
