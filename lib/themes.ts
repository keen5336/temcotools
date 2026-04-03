export const THEMES = ["light", "dark", "cupcake", "nord", "dim"] as const;
export type Theme = (typeof THEMES)[number];
