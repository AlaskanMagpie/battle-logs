/**
 * Pan a track inside a clipped view using range inputs (no native scrollbars).
 * Updates slider max from overflow; hides rows when no pan is needed.
 */
export function wirePanStrip(opts: {
  view: HTMLElement;
  track: HTMLElement;
  sliderX?: HTMLInputElement;
  rowX?: HTMLElement | null;
  sliderY?: HTMLInputElement;
  rowY?: HTMLElement | null;
}): () => void {
  const { view, track, sliderX, rowX, sliderY, rowY } = opts;

  const apply = (): void => {
    const maxX = Math.max(0, Math.round(track.scrollWidth - view.clientWidth));
    const maxY = Math.max(0, Math.round(track.scrollHeight - view.clientHeight));

    let x = 0;
    let y = 0;
    if (sliderX) {
      sliderX.max = String(Math.max(1, maxX));
      x = Math.min(Math.max(0, Number(sliderX.value)), maxX);
      sliderX.value = String(x);
      if (rowX) rowX.hidden = maxX <= 1;
    }
    if (sliderY) {
      sliderY.max = String(Math.max(1, maxY));
      y = Math.min(Math.max(0, Number(sliderY.value)), maxY);
      sliderY.value = String(y);
      if (rowY) rowY.hidden = maxY <= 1;
    }
    track.style.transform = `translate(${-x}px, ${-y}px)`;
  };

  const onInput = (): void => {
    const maxX = Math.max(0, Math.round(track.scrollWidth - view.clientWidth));
    const maxY = Math.max(0, Math.round(track.scrollHeight - view.clientHeight));
    const x = sliderX ? Math.min(Math.max(0, Number(sliderX.value)), maxX) : 0;
    const y = sliderY ? Math.min(Math.max(0, Number(sliderY.value)), maxY) : 0;
    if (sliderX) sliderX.value = String(x);
    if (sliderY) sliderY.value = String(y);
    track.style.transform = `translate(${-x}px, ${-y}px)`;
  };

  const ro = new ResizeObserver(() => apply());
  ro.observe(view);
  ro.observe(track);
  sliderX?.addEventListener("input", onInput);
  sliderY?.addEventListener("input", onInput);
  window.addEventListener("resize", apply);
  queueMicrotask(apply);

  return (): void => {
    ro.disconnect();
    sliderX?.removeEventListener("input", onInput);
    sliderY?.removeEventListener("input", onInput);
    window.removeEventListener("resize", apply);
  };
}
