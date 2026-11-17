export type RelayConnection = { id: string; relayId: string; relayRevision: number; origin: string; pathname: string; ready: boolean; dmpUser: string | null; pending: number; connectedAt: string };
export type RelaySummary = { id: string; name: string; origins: string[]; pathPrefix: string; operations: { id: string; label: string }[] };
export type RelayStatus = { userId: string; definitions: RelaySummary[]; connections: RelayConnection[]; serviceError: string | null };
