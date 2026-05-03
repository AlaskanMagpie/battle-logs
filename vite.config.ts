import { readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

/** Keep in sync with `DEFAULT_CARD_OVERLAY_WRITE_KEY` in `src/ui/cardArtOverlay.ts`. */
const CARD_OVERLAY_WRITE_KEY_FALLBACK = "9889";
const CARD_OVERLAY_FIELD_CENTER_PAD_X = 50;
const CARD_OVERLAY_FIELD_CENTER_PAD_Y = 75;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const rawOverlayKey = env.CARD_OVERLAY_WRITE_KEY;
  /** Empty string in `.env` disables checks; unset uses `CARD_OVERLAY_WRITE_KEY_FALLBACK` below. */
  const cardOverlayWriteKey =
    rawOverlayKey === undefined || rawOverlayKey === null
      ? CARD_OVERLAY_WRITE_KEY_FALLBACK
      : rawOverlayKey.trim();

  return {
    plugins: [cardOverlayLayoutPlugin(cardOverlayWriteKey), react()],
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
    /** Local-only dev (see `npm run dev:lan` for 0.0.0.0 / phone on Wi‑Fi). */
    host: "localhost",
    port: 2222,
    /** Always 2222 — no silent bump to 2223/2224 (README + Playwright assume this URL). */
    strictPort: true,
    fs: { strict: false },
  },
  preview: {
    host: "localhost",
    port: 2222,
    strictPort: true,
  },
    assetsInclude: ["**/*.glb"],
  };
});

type CardOverlayLayoutPayload = {
  catalogId?: unknown;
  fields?: unknown;
};

const CARD_OVERLAY_LAYOUT_FILE = fileURLToPath(new URL("./src/ui/cardArtOverlayLayouts.json", import.meta.url));

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
