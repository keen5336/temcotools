export const PICK_WAVE_STAGING_LOCATIONS = Array.from({ length: 6 }, (_, index) => index + 9).flatMap((number) =>
  ["A", "B", "C", "D"].map((letter) => `${number}-${letter}`)
);
