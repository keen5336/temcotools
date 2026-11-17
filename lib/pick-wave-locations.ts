import { prisma } from "@/lib/db";
import { normalizeStagingLocation } from "@/lib/pick-wave-validation";

export async function listPickWaveLocations() {
  const locations = await prisma.pickWaveStagingLocation.findMany({ select: { name: true } });
  return locations.map((location) => location.name).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

export async function addPickWaveLocation(value: unknown) {
  const name = normalizeStagingLocation(value);
  await prisma.pickWaveStagingLocation.upsert({ where: { name }, create: { name }, update: {} });
  return listPickWaveLocations();
}

export async function removePickWaveLocation(value: unknown) {
  const name = normalizeStagingLocation(value);
  await prisma.pickWaveStagingLocation.deleteMany({ where: { name } });
  return listPickWaveLocations();
}
