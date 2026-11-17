export class PickWaveValidationError extends Error {}

export interface PickWaveRouteInput {
  routeNumber: string;
  stagingLocation: string | null;
}

export function normalizeStagingLocation(value: unknown) {
  if (typeof value !== "string") throw new PickWaveValidationError("A location name is required.");
  const name = value.trim().replace(/\s+/g, " ").toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9 _-]{0,31}$/.test(name)) {
    throw new PickWaveValidationError("Use 1–32 letters, numbers, spaces, hyphens or underscores for a location.");
  }
  return name;
}

export function normalizeRouteMappings(inputs: PickWaveRouteInput[], locations: string[], existing: PickWaveRouteInput[] = []) {
  const available = new Set(locations);
  const saved = new Map(existing.map((mapping) => [mapping.routeNumber.toLowerCase(), mapping.stagingLocation]));
  const unique = new Map<string, PickWaveRouteInput>();
  const usedLocations = new Set<string>();
  for (const input of inputs) {
    const routeNumber = input.routeNumber.trim();
    const stagingLocation = input.stagingLocation?.trim() || null;
    if (!routeNumber) throw new PickWaveValidationError("Each route mapping needs a route number.");
    const routeKey = routeNumber.toLowerCase();
    // A removed location may be retained only on the route that already used it.
    if (stagingLocation && !available.has(stagingLocation) && saved.get(routeKey) !== stagingLocation) {
      throw new PickWaveValidationError(`“${stagingLocation}” is no longer an available staging location. Refresh the location list and choose another location.`);
    }
    if (unique.has(routeKey)) throw new PickWaveValidationError(`Route “${routeNumber}” was assigned more than once.`);
    const locationKey = stagingLocation?.toLowerCase();
    if (locationKey && usedLocations.has(locationKey)) throw new PickWaveValidationError(`Staging location “${stagingLocation}” was assigned more than once.`);
    unique.set(routeKey, { routeNumber, stagingLocation });
    if (locationKey) usedLocations.add(locationKey);
  }
  return [...unique.values()];
}
