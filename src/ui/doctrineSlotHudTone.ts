import type { CatalogEntry } from "../game/types";
import { isCommandEntry } from "../game/types";

/** In-match / binder doctrine slot top accent — drives `data-slot-tone` on `.slot`. */
export function doctrineSlotHudTone(
  e: CatalogEntry,
): "vanguard" | "bastion" | "reclaim" | "neutral" | "command" {
  if (isCommandEntry(e)) return "command";
  if (e.signalTypes.length > 0) {
    const t = e.signalTypes[0];
    if (t === "Vanguard") return "vanguard";
    if (t === "Bastion") return "bastion";
    if (t === "Reclaim") return "reclaim";
  }
  return "neutral";
}
