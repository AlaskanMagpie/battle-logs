const TOAST_ID = "signal-wars-rules-toast";

export function showRulesToast(): void {
  if (document.getElementById(TOAST_ID)) return;
  const el = document.createElement("div");
  el.id = TOAST_ID;
  el.className = "rules-toast";
  el.setAttribute("role", "status");
  el.innerHTML = `
    <div class="rules-toast-title">Quick rules</div>
    <ul class="rules-toast-list">
      <li><b>Tap</b> rings (80 Flux) → +Flux/sec (finite yield).</li>
      <li><b>Relay</b> pillars: build in order; <b>Shift+click</b> a built relay (desktop) or tap <b>Relay shift</b> then the relay (touch) to <b>cycle Signal</b> (V / B / R).</li>
      <li><b>Doctrine</b>: <b>drag</b> a ready card onto the map to place / cast (green = ready; amber = signals locked; grey = cooldown / empty). Short tap still arms then tap the map.</li>
      <li><b>Structures</b>: near Tap/Relay, or <b>forward</b> near your unit/structure (slower build, fragile).</li>
      <li><b>Rally</b>: tap your structure, then the ground.</li>
      <li><b>Salvage</b> trickles to Flux; <b>commands</b> dump cost to Salvage first.</li>
      <li><b>Camera</b>: pinch / wheel zoom · drag pan · <b>Alt+drag</b> orbit on desktop (two-finger pan on touch).</li>
    </ul>
    <div class="rules-toast-dismiss">Tap anywhere to dismiss</div>
  `;
  document.body.appendChild(el);
  const dismiss = (): void => {
    el.remove();
  };
  const t = window.setTimeout(dismiss, 16000);
  el.addEventListener("click", () => {
    window.clearTimeout(t);
    dismiss();
  });
}
