import { syncNow } from "../../extension/sync.js";

let syncing = null;
export function requestSync() {
  // Deduplica: si ya hay una sync en curso, todos comparten la misma en vez de solaparse.
  if (!syncing) syncing = syncNow().finally(() => { syncing = null; });
  return syncing;
}
