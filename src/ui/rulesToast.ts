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
      <li><b>Relay</b> pillars: build in order; <b>Shift+click</b> a built relay to <b>cycle Signal</b> (V / B / R).</li>
      <li><b>Doctrine</b>: <b>drag</b> a ready card onto the map to place / cast (green = ready; amber = signals locked; grey = cooldown / empty). Short click still arms then click map.</li>
      <li><b>Structures</b>: near Tap/Relay, or <b>forward</b> near your unit/structure (slower build, fragile).</li>
      <li><b>Rally</b>: click your structure, then ground.</li>
      <li><b>Salvage</b> trickles to Flux; <b>commands</b> dump cost to Salvage first.</li>
      <li><b>Camera</b>: wheel zoom · right-drag pan · <b>Alt+left-drag</b> orbit (a little).</li>
    </ul>
    <div class="rules-toast-dismiss">Click anywhere to dismiss</div>
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
