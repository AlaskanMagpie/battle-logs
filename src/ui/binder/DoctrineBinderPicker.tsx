import * as THREE from "three";
import type { ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CATALOG, DEFAULT_DOCTRINE_SLOTS } from "../../game/catalog";
import { DOCTRINE_SLOT_COUNT } from "../../game/constants";
import { DEFAULT_MAP_URL, MAP_REGISTRY } from "../../game/loadMap";
import { sortCatalogIds, type CatalogSortKey } from "../../game/catalogSort";
import { isCommandEntry } from "../../game/types";
import { preloadCardPreviewDataUrls } from "../cardGlbPreview";
import { showDoctrineCardDetail } from "../cardDetailPop";
import { loadDoctrineSlots, saveDoctrineSlots } from "../doctrineStorage";
import { getBinderTextureForCatalogId } from "./binderCardTexture";
import { CardBinderEngine } from "./CardBinderEngine";
import "./binderPicker.css";

const CATALOG_IDS = CATALOG.map((c) => c.id);
/** Doctrine binder pages: structures only (commands stay in catalog elsewhere). */
const STRUCTURE_CATALOG_IDS = CATALOG.filter((c) => !isCommandEntry(c)).map((c) => c.id);
/**
 * 3D binder textures and raycast pick indices always follow **catalog order**.
 * The Sort control does not remap the codex (avoids “shuffled” cards when sort changes).
 */
const BINDER_GRID_CATALOG_IDS: readonly string[] = sortCatalogIds(STRUCTURE_CATALOG_IDS, "catalog");
const validIds = new Set(CATALOG_IDS);
const MIN_FILLED = Math.ceil(DOCTRINE_SLOT_COUNT * 0.75);

export function DoctrineBinderPicker({
  onStart,
}: {
  onStart: (slots: (string | null)[], mapUrl: string) => void;
}): ReactElement {
  const [sortKey, setSortKey] = useState<CatalogSortKey>("catalog");
  const orderedRef = useRef<string[]>([...BINDER_GRID_CATALOG_IDS]);
  const [slots, setSlots] = useState<(string | null)[]>(() =>
    loadDoctrineSlots().map((id) => (id && validIds.has(id) ? id : null)),
  );
  /** Highlights the doctrine slot last filled from the binder (primary outline in 3D). */
  const [activeDoctrineSlot, setActiveDoctrineSlot] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState({ c: 0, t: 1 });
  const [mapUrl, setMapUrl] = useState<string>(() => {
    try {
      return localStorage.getItem("signalWarsMapUrl") || DEFAULT_MAP_URL;
    } catch {
      return DEFAULT_MAP_URL;
    }
  });

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<CardBinderEngine | null>(null);

  const slotsRef = useRef(slots);
  slotsRef.current = slots;

  const filledCount = slots.filter(Boolean).length;
  const canStart = filledCount >= MIN_FILLED;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setActiveDoctrineSlot(null);
        return;
      }
      const t = (e.target as HTMLElement | null)?.tagName?.toLowerCase() ?? "";
      if (t === "select" || t === "input" || t === "textarea" || t === "button") return;

      const pageKeys =
        e.key === "ArrowLeft" ||
        e.key === "ArrowRight" ||
        e.key === "PageUp" ||
        e.key === "PageDown" ||
        e.key === "," ||
        e.key === ".";

      if (!engineRef.current?.isBinderOpen()) {
        if (e.key === "Home" || e.key === "End" || pageKeys) e.preventDefault();
        return;
      }

      if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        if (e.key === "Home") engineRef.current?.jumpToFirstSpread();
        else engineRef.current?.jumpToLastSpread();
        return;
      }

      if (!pageKeys) return;
      e.preventDefault();
      const next =
        e.key === "ArrowRight" || e.key === "PageDown" || (e.key === "." && !e.shiftKey);
      if (next) engineRef.current?.flipNext();
      else engineRef.current?.flipPrev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    let cancelled = false;
    let eng: CardBinderEngine | null = null;
    let ro: ResizeObserver | null = null;

    setLoading(true);

    void (async () => {
      try {
        const structs = CATALOG.filter((c) => !isCommandEntry(c)).map((c) => c.id);
        await preloadCardPreviewDataUrls(structs);
      } catch {
        /* best-effort */
      }
      if (cancelled) return;

      const ids = BINDER_GRID_CATALOG_IDS;
      const texList: THREE.Texture[] = [];
      for (let i = 0; i < ids.length; i++) {
        if (cancelled) return;
        texList.push(await getBinderTextureForCatalogId(ids[i]!));
      }
      if (cancelled) return;

      const next = new CardBinderEngine(canvas, texList);
      next.snapBinderFullyOpen();
      next.onPageChange = (c, t) => setPage({ c, t });
      next.onPickCatalogIndex = (idx) => {
        if (idx === null || idx < 0) return;
        const id = orderedRef.current[idx];
        if (!id || !validIds.has(id)) return;
        setSlots((prev) => {
          const empty = prev.findIndex((s) => !s);
          if (empty < 0) {
            showDoctrineCardDetail(id);
            return prev;
          }
          setActiveDoctrineSlot(empty);
          const copy = [...prev];
          copy[empty] = id;
          return copy;
        });
      };
      const rc = wrap.getBoundingClientRect();
      next.resize(rc.width, rc.height);
      if (next.onPageChange) next.onPageChange(next.pageIndex, next.pageCount);

      if (cancelled) {
        next.dispose();
        return;
      }

      eng = next;
      engineRef.current = next;
      next.syncDoctrineHighlights([...BINDER_GRID_CATALOG_IDS], slotsRef.current, null);
      ro = new ResizeObserver((es) => {
        for (const e of es) engineRef.current?.resize(e.contentRect.width, e.contentRect.height);
      });
      ro.observe(wrap);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
      ro?.disconnect();
      eng?.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (loading) return;
    engineRef.current?.syncDoctrineHighlights([...BINDER_GRID_CATALOG_IDS], slots, activeDoctrineSlot);
  }, [loading, slots, activeDoctrineSlot]);

  useEffect(() => {
    if (loading) return;
    const end = () => engineRef.current?.releaseInterruptedGesture();
    const onVis = () => {
      if (document.visibilityState === "hidden") end();
    };
    window.addEventListener("blur", end);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("blur", end);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loading]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* setPointerCapture can fail in edge pointer states */
    }
    const rect = e.currentTarget.getBoundingClientRect();
    engineRef.current?.pD(e.nativeEvent, rect);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    engineRef.current?.pM(e.nativeEvent, rect);
  }, []);

  const onPointerReleased = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      /* ignore */
    }
    const rect = e.currentTarget.getBoundingClientRect();
    engineRef.current?.pU(e.nativeEvent, rect);
  }, []);

  const onWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    engineRef.current?.wheel(e.deltaY);
  }, []);

  const onCanvasDoubleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    engineRef.current?.cancelPendingCatalogPick();
    const rect = e.currentTarget.getBoundingClientRect();
    const idx = engineRef.current?.pickAt(e.clientX, e.clientY, rect);
    if (idx == null || idx < 0) return;
    const id = orderedRef.current[idx];
    if (id && validIds.has(id)) showDoctrineCardDetail(id);
  }, []);

  const resetDefaults = useCallback(() => {
    setActiveDoctrineSlot(null);
    setSlots(DEFAULT_DOCTRINE_SLOTS.map((id) => (id && validIds.has(id) ? id : null)));
  }, []);

  const saveDoctrine = useCallback(() => {
    saveDoctrineSlots(slots);
  }, [slots]);

  const startMatch = useCallback(() => {
    if (slots.filter(Boolean).length < MIN_FILLED) return;
    saveDoctrineSlots(slots);
    try {
      localStorage.setItem("signalWarsMapUrl", mapUrl);
    } catch {
      /* ignore */
    }
    onStart(slots, mapUrl);
  }, [slots, onStart, mapUrl]);

  return (
    <div className="binder-picker-root">
      <div className="binder-picker-binder-wrap" ref={wrapRef}>
        {loading ? (
          <div className="binder-picker-loading" role="status" aria-live="polite" aria-busy="true">
            Loading…
          </div>
        ) : null}
        {!loading ? (
          <div className="binder-picker-tome-hint" role="status">
            Tap a card to assign it to the next free doctrine slot. Double-click for full rules. Drag page edges or
            use Prev/Next.
          </div>
        ) : null}
        <canvas
          ref={canvasRef}
          className="binder-picker-canvas"
          tabIndex={0}
          role="application"
          aria-label="Doctrine codex — three-ring binder. Tap a card to add to doctrine; double-click for details."
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerReleased}
          onPointerCancel={onPointerReleased}
          onPointerLeave={() => engineRef.current?.clearCardHover()}
          onWheel={onWheel}
          onDoubleClick={onCanvasDoubleClick}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>

      <footer className="binder-picker-toolbar">
        <div className="binder-picker-toolbar-inner">
          {!loading ? (
            <div className="binder-picker-nav">
              <button
                type="button"
                className="binder-picker-btn"
                title={page.t > 1 ? "Previous spread (wraps from first)" : "Previous spread"}
                disabled={page.t <= 1}
                onClick={() => engineRef.current?.flipPrev()}
              >
                Prev
              </button>
              <span className="binder-picker-nav-page">
                {page.c + 1} / {page.t}
              </span>
              <button
                type="button"
                className="binder-picker-btn"
                title={page.t > 1 ? "Next spread (wraps from last)" : "Next spread"}
                disabled={page.t <= 1}
                onClick={() => engineRef.current?.flipNext()}
              >
                Next
              </button>
              <button type="button" className="binder-picker-btn" title="Reset camera" onClick={() => engineRef.current?.resetCam()}>
                View
              </button>
            </div>
          ) : null}
          <div className="binder-picker-toolbar-map">
            <label htmlFor="binder-map">Battlefield</label>
            <select
              id="binder-map"
              disabled={loading}
              value={mapUrl}
              onChange={(ev) => setMapUrl(ev.target.value)}
            >
              {MAP_REGISTRY.map((m) => (
                <option key={m.id} value={m.url}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div className="binder-picker-toolbar-main">
            <div className="binder-picker-toolbar-left">
              <label htmlFor="binder-sort" title="Does not reorder the 3D codex; binder grid is fixed catalog order.">
                Sort
              </label>
              <select
                id="binder-sort"
                disabled={loading}
                value={sortKey}
                title="Reserved for future list UI; the 3D binder stays catalog order."
                onChange={(ev) => setSortKey(ev.target.value as CatalogSortKey)}
              >
                <option value="catalog">Catalog</option>
                <option value="name">Name</option>
                <option value="cost">Cost</option>
                <option value="cooldown">Cooldown</option>
                <option value="kind">Kind</option>
                <option value="class">Class</option>
              </select>
            </div>
            <div className="binder-picker-toolbar-actions">
              <button type="button" className="binder-picker-btn" disabled={loading} onClick={resetDefaults}>
                Reset
              </button>
              <button type="button" className="binder-picker-btn" disabled={loading} onClick={saveDoctrine}>
                Save
              </button>
              <button
                type="button"
                className="binder-picker-btn binder-picker-btn--primary"
                disabled={loading || !canStart}
                onClick={startMatch}
              >
                Start
              </button>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
