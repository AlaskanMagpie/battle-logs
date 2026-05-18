/**
 * Same-origin media loaded through `fetch` + `blob:` so `<audio>` never points at `/assets/...`
 * (download-manager extensions often hook plain media URLs and pop download dialogs).
 */

const blobUrlByPath = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();

export async function getBlobUrlForMediaPath(path: string): Promise<string> {
  const cached = blobUrlByPath.get(path);
  if (cached) return cached;

  let pending = inFlight.get(path);
  if (!pending) {
    pending = (async () => {
      const res = await fetch(path, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`Media fetch failed: ${path} (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      blobUrlByPath.set(path, url);
      return url;
    })().finally(() => {
      inFlight.delete(path);
    });
    inFlight.set(path, pending);
  }
  return pending;
}
