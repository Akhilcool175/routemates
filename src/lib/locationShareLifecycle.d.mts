export function createLocationShareGeneration(): {
  begin(): number;
  invalidate(): number;
  isCurrent(candidate: number): boolean;
};
