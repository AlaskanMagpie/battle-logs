import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";
import type { BinderPlacement, CardBinderEngine, VibePortalPlacement } from "./CardBinderEngine";

function fmt(n: number): string {
  return String(Number(n.toFixed(4)));
}

/** Paste over `DEFAULT_BINDER_PLACEMENT` + `DEFAULT_VIBE_PORTAL_PLACEMENT` in CardBinderEngine.ts (keep `LEGACY_SHIPPED_*` as the *previous* shipped defaults if you rely on migration). */
export function formatPlacementDefaultsTs(b: BinderPlacement, v: VibePortalPlacement): string {
  return `const DEFAULT_BINDER_PLACEMENT: BinderPlacement = { x: ${fmt(b.x)}, y: ${fmt(b.y)}, z: ${fmt(b.z)}, scale: ${fmt(b.scale)} };
const DEFAULT_VIBE_PORTAL_PLACEMENT: VibePortalPlacement = {
  x: ${fmt(v.x)},
  y: ${fmt(v.y)},
  z: ${fmt(v.z)},
  rx: ${fmt(v.rx)},
  ry: ${fmt(v.ry)},
  rz: ${fmt(v.rz)},
  scale: ${fmt(v.scale)},
};`;
}

type RowProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
};

function NumRow({ label, value, min, max, step, onChange }: RowProps): ReactElement {
  return (
    <label className="binder-calibrate-row">
      <span className="binder-calibrate-row__label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <input
        type="number"
        className="binder-calibrate-row__num"
        step={step}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export function BinderLayoutCalibratePanel({
  engine,
  visible,
  onClose,
}: {
  engine: CardBinderEngine | null;
  visible: boolean;
  /** When set, shows a close control (dismisses the floating panel). */
  onClose?: () => void;
}): ReactElement | null {
  const [b, setB] = useState<BinderPlacement | null>(null);
  const [v, setV] = useState<VibePortalPlacement | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!visible || !engine) return;
    setB(engine.getBinderPlacement());
    setV(engine.getVibePortalPlacement());
  }, [visible, engine]);

  const pushBinder = useCallback(
    (next: Partial<BinderPlacement>) => {
      if (!engine) return;
      const cur = engine.getBinderPlacement();
      const merged = { ...cur, ...next };
      engine.setBinderPlacement(merged, true);
      setB(engine.getBinderPlacement());
    },
    [engine],
  );

  const pushPortal = useCallback(
    (next: Partial<VibePortalPlacement>) => {
      if (!engine) return;
      const cur = engine.getVibePortalPlacement();
      const merged = { ...cur, ...next };
      engine.setVibePortalPlacement(merged, true);
      setV(engine.getVibePortalPlacement());
    },
    [engine],
  );

  const copyTs = useCallback(async () => {
    if (!b || !v) return;
    const text = formatPlacementDefaultsTs(b, v);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2400);
    } catch {
      // eslint-disable-next-line no-console
      console.info(text);
    }
  }, [b, v]);

  const resetBoth = useCallback(() => {
    if (!engine) return;
    engine.resetBinderPlacement();
    engine.resetVibePortalPlacement();
    setB(engine.getBinderPlacement());
    setV(engine.getVibePortalPlacement());
  }, [engine]);

  if (!visible || !engine || !b || !v) return null;

  return (
    <div className="binder-layout-calibrate" role="region" aria-label="Binder layout calibration">
      <div className="binder-layout-calibrate__head">
        <div className="binder-layout-calibrate__title">Room layout (codex + Vibe portal)</div>
        {onClose ? (
          <button type="button" className="binder-layout-calibrate__close" aria-label="Close layout panel" onClick={onClose}>
            ×
          </button>
        ) : null}
      </div>
      <p className="binder-layout-calibrate__hint">
        This panel is <strong>dev-only</strong>: load the prematch screen with <code>?binderCalibrate=1</code> in the URL.
        Drag sliders; values save to <code>localStorage</code> for this site. To ship for everyone, copy the TS below into{" "}
        <code>CardBinderEngine.ts</code> (replace <code>DEFAULT_*</code> + migration <code>LEGACY_*</code> as needed) and
        commit.
      </p>

      <div className="binder-layout-calibrate__section">
        <strong>Binder (codex / tome group)</strong>
        <NumRow label="x" value={b.x} min={-2.5} max={2.5} step={0.02} onChange={(x) => pushBinder({ x })} />
        <NumRow label="y" value={b.y} min={-1.5} max={1.5} step={0.02} onChange={(y) => pushBinder({ y })} />
        <NumRow label="z" value={b.z} min={-2.5} max={2.5} step={0.02} onChange={(z) => pushBinder({ z })} />
        <NumRow label="scale" value={b.scale} min={0.35} max={0.78} step={0.01} onChange={(scale) => pushBinder({ scale })} />
      </div>

      <div className="binder-layout-calibrate__section">
        <strong>Vibe portal (NEXT GAME)</strong>
        <NumRow label="x" value={v.x} min={-3} max={4} step={0.02} onChange={(x) => pushPortal({ x })} />
        <NumRow label="y" value={v.y} min={-1} max={2.5} step={0.02} onChange={(y) => pushPortal({ y })} />
        <NumRow label="z" value={v.z} min={-5} max={2} step={0.02} onChange={(z) => pushPortal({ z })} />
        <NumRow label="rx" value={v.rx} min={-0.8} max={0.8} step={0.01} onChange={(rx) => pushPortal({ rx })} />
        <NumRow label="ry" value={v.ry} min={-0.8} max={0.8} step={0.01} onChange={(ry) => pushPortal({ ry })} />
        <NumRow label="rz" value={v.rz} min={-0.8} max={0.8} step={0.01} onChange={(rz) => pushPortal({ rz })} />
        <NumRow label="scale" value={v.scale} min={0.45} max={1.9} step={0.02} onChange={(scale) => pushPortal({ scale })} />
      </div>

      <div className="binder-layout-calibrate__actions">
        <button type="button" className="binder-picker-btn" onClick={resetBoth}>
          Reset to code defaults
        </button>
        <button type="button" className="binder-picker-btn binder-picker-btn--primary" onClick={() => void copyTs()}>
          {copied ? "Copied TS — paste into CardBinderEngine.ts" : "Copy TypeScript defaults (clipboard)"}
        </button>
      </div>
    </div>
  );
}
