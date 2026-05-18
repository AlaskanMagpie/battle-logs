import { execSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

/** Keep in sync with `DEFAULT_CARD_OVERLAY_WRITE_KEY` in `src/ui/cardArtOverlay.ts`. */
const CARD_OVERLAY_WRITE_KEY_FALLBACK = "9889";
const CARD_OVERLAY_FIELD_CENTER_PAD_X = 50;
const CARD_OVERLAY_FIELD_CENTER_PAD_Y = 75;

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const CARD_OVERLAY_LAYOUT_FILE = fileURLToPath(new URL("./src/ui/cardArtOverlayLayouts.json", import.meta.url));
const CARD_ART_DIR = join(REPO_ROOT, "public", "assets", "cards");
const UNIT_MANIFEST_FILE = join(REPO_ROOT, "public", "assets", "units", "manifest.json");

/** When true, registers `clipRetargetManifestPlugin` (pair with Asset Lab retarget UI if reintroduced). */
const REGISTER_CLIP_RETARGET_DEV_PLUGIN = false;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const rawOverlayKey = env.CARD_OVERLAY_WRITE_KEY;
  /** Empty string in `.env` disables checks; unset uses `CARD_OVERLAY_WRITE_KEY_FALLBACK` below. */
  const cardOverlayWriteKey =
    rawOverlayKey === undefined || rawOverlayKey === null
      ? CARD_OVERLAY_WRITE_KEY_FALLBACK
      : rawOverlayKey.trim();

  return {
    plugins: [
      cardOverlayLayoutPlugin(cardOverlayWriteKey),
      cardArtDevUploadPlugin(cardOverlayWriteKey),
      ...(REGISTER_CLIP_RETARGET_DEV_PLUGIN ? [clipRetargetManifestPlugin(cardOverlayWriteKey)] : []),
      react(),
    ],
    build: {
      rollupOptions: {
        input: {
          main: "index.html",
          embed: "embed.html",
          mapEditor: "map-editor.html",
          assetLab: "asset-lab.html",
        },
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/three/examples")) return "three-extras";
          if (id.includes("node_modules/three")) return "three-core";
          if (id.includes("node_modules/react") || id.includes("node_modules/react-dom")) return "react";
        },
      },
    },
  },
  server: {
    /**
     * IPv4 loopback avoids Windows resolving `localhost` to IPv6 (::1) while Node listens on IPv4-only,
     * which looks like “nothing loads” in the browser.
     */
    host: "127.0.0.1",
    port: 2223,
    /** Always 2223 — `strictPort` (no silent bump). Use `npm run localhost` to free 2222–2224 if needed. */
    strictPort: true,
    fs: { strict: false },
    /**
     * `cardOverlayLayoutPlugin` writes this JSON on “Save card default”. Watching it invalidates
     * `cardArtOverlay.ts` (static JSON import) and full-reloads Asset Lab / any open page — losing
     * GLB picks, class preview, zoom, etc. Runtime layout is already updated via `replaceRuntimeCardFields`;
     * ignore disk writes so dev stays stable. Reload the tab if you edit the JSON by hand in the IDE.
     */
    watch: {
      ignored: [CARD_OVERLAY_LAYOUT_FILE],
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 2223,
    strictPort: true,
  },
  assetsInclude: ["**/*.glb"],
  };
});

type CardOverlayLayoutPayload = {
  catalogId?: unknown;
  fields?: unknown;
};

const CARD_ART_UPLOAD_MAX_BYTES = 28 * 1024 * 1024;

function cardArtDevUploadPlugin(writeKey: string): Plugin {
  return {
    name: "battle-logs-card-art-dev-upload",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__card-art-upload", async (req, res, next) => {
        if (req.method !== "PUT") {
          next();
          return;
        }
        try {
          if (writeKey) {
            const headerVal = String(req.headers["x-card-overlay-write-key"] ?? "").trim();
            if (headerVal !== writeKey) {
              res.statusCode = 401;
              res.setHeader("Content-Type", "text/plain");
              res.end("Card overlay write key missing or invalid.");
              return;
            }
          }
          const catalogId = String(req.headers["x-catalog-id"] ?? "").trim();
          if (!/^[a-z0-9_-]+$/.test(catalogId)) {
            throw new Error("Invalid or missing X-Catalog-Id");
          }
          const extRaw = String(req.headers["x-card-art-ext"] ?? "png").trim().toLowerCase().replace(/^\./, "");
          const allowed = new Set(["png", "webp", "jpg", "jpeg", "svg"]);
          if (!allowed.has(extRaw)) {
            throw new Error("Invalid X-Card-Art-Ext (use png, webp, jpg, jpeg, or svg)");
          }
          const ext = extRaw === "jpeg" ? "jpg" : extRaw;
          const buf = await readRawBodyBuffer(req, CARD_ART_UPLOAD_MAX_BYTES);
          if (buf.length < 16) throw new Error("Image body too small");
          const outPath = join(CARD_ART_DIR, `${catalogId}.${ext}`);
          await writeFile(outPath, buf);
          try {
            // Windows: `npm.cmd` is not a PE executable — `execFileSync("npm.cmd")` can throw EINVAL.
            // Shell invocation matches how developers run `npm run` in a terminal.
            // Skip bumping `src/ui/cardArtManifest.ts` here so Vite does not full-reload Asset Lab on every save;
            // the lab refreshes the image with its own cache-bust query (see `assetLab.ts`).
            execSync("npm run cards:pipeline", {
              cwd: REPO_ROOT,
              stdio: "inherit",
              env: { ...process.env, CARDS_PIPELINE_NO_BUMP: "1" },
              shell: true,
            });
          } catch (pipeErr) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "text/plain");
            res.end(
              `Card saved to disk but cards:pipeline failed: ${pipeErr instanceof Error ? pipeErr.message : String(pipeErr)}`,
            );
            return;
          }
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, catalogId, path: `/assets/cards/${catalogId}.${ext}` }));
        } catch (err) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain");
          res.end(err instanceof Error ? err.message : String(err));
        }
      });
    },
  };
}

function readRawBodyBuffer(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Image too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function cardOverlayLayoutPlugin(writeKey: string): Plugin {
  return {
    name: "battle-logs-card-overlay-layout-writer",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__card-overlay-layout", async (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }

        try {
          if (writeKey) {
            const headerVal = String(req.headers["x-card-overlay-write-key"] ?? "").trim();
            if (headerVal !== writeKey) {
              res.statusCode = 401;
              res.setHeader("Content-Type", "text/plain");
              res.end("Card overlay write key missing or invalid.");
              return;
            }
          }
          const payload = await readJsonBody<CardOverlayLayoutPayload>(req);
          const catalogId = typeof payload.catalogId === "string" ? payload.catalogId.trim() : "";
          if (!/^[a-z0-9_-]+$/.test(catalogId)) {
            throw new Error("Invalid catalogId");
          }
          const fields = sanitizeOverlayFields(payload.fields);
          const current = JSON.parse(await readFile(CARD_OVERLAY_LAYOUT_FILE, "utf8")) as {
            profiles?: Record<string, unknown>;
            cards?: Record<string, unknown>;
          };
          const cards = isRecord(current.cards) ? current.cards : {};
          const priorCard = isRecord(cards[catalogId]) ? cards[catalogId] : {};
          const next = {
            ...current,
            cards: {
              ...cards,
              [catalogId]: {
                ...priorCard,
                fields,
              },
            },
          };
          await writeFile(CARD_OVERLAY_LAYOUT_FILE, `${JSON.stringify(next, null, 2)}\n`);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, catalogId, fields }));
        } catch (err) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain");
          res.end(err instanceof Error ? err.message : String(err));
        }
      });
    },
  };
}

type ClipRetargetOverridePayload = {
  producedUnitId?: unknown;
  donorFile?: unknown;
  role?: unknown;
  mode?: unknown;
};

const CLIP_RETARGET_ROLES = new Set(["run", "idle", "attack", "death"]);

/** Dev-only POST `/__clip-retarget-override` — not registered in `plugins` until we expose retarget in UI again. */
function clipRetargetManifestPlugin(writeKey: string): Plugin {
  return {
    name: "battle-logs-clip-retarget-manifest",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__clip-retarget-override", async (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        try {
          if (writeKey) {
            const headerVal = String(req.headers["x-card-overlay-write-key"] ?? "").trim();
            if (headerVal !== writeKey) {
              res.statusCode = 401;
              res.setHeader("Content-Type", "text/plain");
              res.end("Card overlay write key missing or invalid.");
              return;
            }
          }
          const payload = await readJsonBody<ClipRetargetOverridePayload>(req);
          const producedUnitId = typeof payload.producedUnitId === "string" ? payload.producedUnitId.trim() : "";
          const donorFile = typeof payload.donorFile === "string" ? payload.donorFile.trim() : "";
          const role = typeof payload.role === "string" ? payload.role.trim() : "";
          const mode = "stripNonRootPosition";
          if (!/^[a-z0-9_-]+$/i.test(producedUnitId)) throw new Error("Invalid producedUnitId");
          if (!donorFile.endsWith(".glb")) throw new Error("Invalid donorFile (expected *.glb)");
          if (!CLIP_RETARGET_ROLES.has(role)) throw new Error("Invalid role (use run, idle, attack, death)");

          const raw = await readFile(UNIT_MANIFEST_FILE, "utf8");
          const manifest = JSON.parse(raw) as {
            schemaVersion?: number;
            files?: string[];
            clipRetargetOverrides?: Array<{ producedUnitId: string; donorFile: string; roles: string[]; mode: string }>;
          };
          const files = Array.isArray(manifest.files) ? manifest.files : [];
          if (!files.includes(donorFile)) throw new Error(`donorFile not in manifest files: ${donorFile}`);

          const list = Array.isArray(manifest.clipRetargetOverrides) ? [...manifest.clipRetargetOverrides] : [];
          const idx = list.findIndex((e) => e.producedUnitId === producedUnitId && e.donorFile === donorFile);
          if (idx >= 0) {
            const cur = list[idx]!;
            const roles = [...new Set([...(Array.isArray(cur.roles) ? cur.roles : []), role])].sort() as string[];
            list[idx] = { producedUnitId, donorFile, roles, mode };
          } else {
            list.push({ producedUnitId, donorFile, roles: [role], mode });
          }
          const next = { ...manifest, clipRetargetOverrides: list };
          await writeFile(UNIT_MANIFEST_FILE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, clipRetargetOverrides: list }));
        } catch (err) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain");
          res.end(err instanceof Error ? err.message : String(err));
        }
      });
    },
  };
}

function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 64_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}") as T);
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeOverlayFields(value: unknown): Record<string, { x: number; y: number; width?: number; height?: number }> {
  if (!isRecord(value)) throw new Error("Invalid fields");
  const next: Record<string, { x: number; y: number; width?: number; height?: number }> = {};
  for (const [fieldId, fieldValue] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(fieldId) || !isRecord(fieldValue)) continue;
    const x = Number(fieldValue.x);
    const y = Number(fieldValue.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const out: { x: number; y: number; width?: number; height?: number } = {
      x: Math.max(-CARD_OVERLAY_FIELD_CENTER_PAD_X, Math.min(100 + CARD_OVERLAY_FIELD_CENTER_PAD_X, Math.round(x * 10) / 10)),
      y: Math.max(-CARD_OVERLAY_FIELD_CENTER_PAD_Y, Math.min(150 + CARD_OVERLAY_FIELD_CENTER_PAD_Y, Math.round(y * 10) / 10)),
    };
    const w = Number(fieldValue.width);
    const h = Number(fieldValue.height);
    if (Number.isFinite(w)) out.width = Math.max(4, Math.min(100, Math.round(w * 10) / 10));
    if (Number.isFinite(h)) out.height = Math.max(4, Math.min(48, Math.round(h * 10) / 10));
    next[fieldId] = out;
  }
  if (!Object.keys(next).length) throw new Error("No valid fields");
  return next;
}
