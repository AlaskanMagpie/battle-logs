import * as THREE from "three";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CATALOG, DEFAULT_DOCTRINE_SLOTS } from "../../game/catalog";
import { DOCTRINE_SLOT_COUNT } from "../../game/constants";
import { sortCatalogIds, type CatalogSortKey } from "../../game/catalogSort";
import { isCommandEntry } from "../../game/types";
import { preloadCardPreviewDataUrls } from "../cardGlbPreview";
import { showDoctrineCardDetail } from "../cardDetailPop";
import { loadDoctrineSlots, saveDoctrineSlots } from "../doctrineStorage";
import { getBinderTextureForCatalogId } from "./binderCardTexture";
import { CardBinderEngine } from "./CardBinderEngine";
import "./binderPicker.css";

const CATALOG_IDS = CATALOG.map((c) => c.id);
const validIds = new Set(CATALOG_IDS);
const MIN_FILLED = Math.ceil(DOCTRINE_SLOT_COUNT * 0.75);

export function DoctrineBinderPicker({
  onStart,
}: {
  onStart: (slots: (string | null)[]) => void;
}): ReactElement {
  const [sortKey, setSortKey] = useState<CatalogSortKey>("catalog");
  const orderedRef = useRef<string[]>([]);
  const binderPanelIds = useMemo(() => sortCatalogIds(CATALOG_IDS, sortKey), [sortKey]);
  orderedRef.current = binderPanelIds;
  const [slots, setSlots] = useState<(string | null)[]>(() =>
    loadDoctrineSlots().map((id) => (id && validIds.has(id) ? id : null)),
  );
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState({ c: 0, t: 1 });

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<CardBinderEngine | null>(null);

  const slotsRef = useRef(slots);
  slotsRef.current = slots;

  const filledCount = slots.filter(Boolean).length;
  const canStart = filledCount >= MIN_FILLED;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = (e.target as HTMLElement | null)?.tagName?.toLowerCase() ?? "";
      if (t === "select" || t === "input" || t === "textarea" || t === "button") return;

      if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        if (e.key === "Home") engineRef.current?.jumpToFirstSpread();
        else engineRef.current?.jumpToLastSpread();
        return;
      }

      const pageKeys =
        e.key === "ArrowLeft" ||
        e.key === "ArrowRight" ||
        e.key === "PageUp" ||
        e.key === "PageDown" ||
        e.key === "," ||
        e.key === ".";
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

      const ids = binderPanelIds;
      const texList: THREE.Texture[] = [];
      for (let i = 0; i < ids.length; i++) {
        if (cancelled) return;
        texList.push(await getBinderTextureForCatalogId(ids[i]!));
      }
      if (cancelled) return;

      const next = new CardBinderEngine(canvas, texList);
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
      next.syncDoctrineHighlights(orderedRef.current, slotsRef.current, null);
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
  }, [sortKey, binderPanelIds]);

  useEffect(() => {
    if (loading) return;
    engineRef.current?.syncDoctrineHighlights(binderPanelIds, slots, null);
  }, [loading, binderPanelIds, slots]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    engineRef.current?.pD(e.nativeEvent, rect);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    engineRef.current?.pM(e.nativeEvent, rect);
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    engineRef.current?.pU(e.nativeEvent, rect);
  }, []);

  const onWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    engineRef.current?.wheel(e.deltaY);
  }, []);

  const onCanvasDoubleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const idx = engineRef.current?.pickAt(e.clientX, e.clientY, rect);
    if (idx == null || idx < 0) return;
    const id = orderedRef.current[idx];
    if (id && validIds.has(id)) showDoctrineCardDetail(id);
  }, []);

  const resetDefaults = useCallback(() => {
    setSlots(DEFAULT_DOCTRINE_SLOTS.map((id) => (id && validIds.has(id) ? id : null)));
  }, []);

  const saveDoctrine = useCallback(() => {
    saveDoctrineSlots(slots);
  }, [slots]);

  const startMatch = useCallback(() => {
    if (slots.filter(Boolean).length < MIN_FILLED) return;
    saveDoctrineSlots(slots);
    onStart(slots);
  }, [slots, onStart]);

  return (
    <div className="binder-picker-root">
      <div className="binder-picker-binder-wrap" ref={wrapRef}>
        {loading ? (
          <div className="binder-picker-loading" role="status" aria-live="polite" aria-busy="true">
            Loading…
          </div>
        ) : null}
        <canvas
          ref={canvasRef}
          className="binder-picker-canvas"
          tabIndex={0}
          role="application"
          aria-label="Doctrine binder — tap a card to add it to your doctrine; double-click for details."
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          onDoubleClick={onCanvasDoubleClick}
          onContextMenu={(e) => e.preventDefault()}
        />
        {!loading ? (
          <div className="binder-picker-nav">
            <button
              type="button"
              className="binder-picker-btn"
              title="Previous spread"
              disabled={page.c <= 0}
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
              title="Next spread"
              disabled={page.c >= page.t - 1}
              onClick={() => engineRef.current?.flipNext()}
            >
              Next
            </button>
            <button
              type="button"
              className="binder-picker-btn"
              title="Reset camera"
              onClick={() => engineRef.current?.resetCam()}
            >
              View
            </button>
          </div>
        ) : null}
      </div>

      <footer className="binder-picker-toolbar">
        <div className="binder-picker-toolbar-inner">
          <div className="binder-picker-toolbar-left">
            <label htmlFor="binder-sort">Sort</label>
            <select
              id="binder-sort"
              disabled={loading}
              value={sortKey}
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
      </footer>
    </div>
  );
}
