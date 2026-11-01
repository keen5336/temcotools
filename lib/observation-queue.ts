// Persistent queue payloads are observations/local task work only. Never put
// printing, MARS submissions or other external mutations in this queue.
export interface QueuedObservation {
  eventId: string;
  capturedByUserId: string;
  rawIdentifier: string;
  capturedAt: string;
  identifierType: "auto";
  type: "presence" | "check_in" | "placement" | "departure";
  location?: string;
  captureMethod: "scanner" | "manual" | "ocr";
  pickWaveId?: string;
  finalsSessionId?: string;
  lane?: string;
  confirmPlacement?: boolean;
  state: "pending" | "rejected";
  error?: string;
}
const DATABASE = "temcotools-observations-v2", STORE = "events";
export const MAX_QUEUED_OBSERVATIONS = 500;

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: "eventId" });
      store.createIndex("capturedByUserId", "capturedByUserId");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Device storage is unavailable. The scan was not captured."));
    request.onblocked = () => reject(new Error("Close older Temco tabs to unlock device storage."));
  });
}
async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode), request = run(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(request.result); };
    tx.onerror = tx.onabort = () => { db.close(); reject(new Error("Device storage could not save the scan. Check pending work before scanning again.")); };
  });
}
export async function queuedObservations(userId: string): Promise<QueuedObservation[]> {
  const rows = await transact("readonly", store => store.index("capturedByUserId").getAll(userId));
  return (rows as QueuedObservation[]).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.eventId.localeCompare(b.eventId));
}
export async function queueObservation(input: Omit<QueuedObservation, "state">) {
  const rows = await queuedObservations(input.capturedByUserId);
  if (rows.length >= MAX_QUEUED_OBSERVATIONS) throw new Error("Device queue is full. Save or review pending observations before capturing more.");
  const event: QueuedObservation = { ...input, state: "pending" };
  await transact("readwrite", store => store.add(event));
  return event;
}
export async function rejectQueuedObservation(event: QueuedObservation, error: string) {
  await transact("readwrite", store => store.put({ ...event, state: "rejected", error }));
}
export async function acknowledgeQueuedObservation(eventId: string) {
  await transact("readwrite", store => store.delete(eventId));
}
