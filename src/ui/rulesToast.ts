const ROOT_ID = "signal-wars-onboarding";
const STORAGE_KEY = "sw:onboarding:hero-pivot:v1:dismissed";

const STAGES: string[] = [
  "You are the <b>blue Wizard</b>. <b>Right-click</b> to move. <b>Hold right-click</b> to follow the cursor. <b>WASD</b> strafes; <b>middle mouse</b> orbits the camera.",
  "Walk onto a <b>grey Mana node</b> to claim it. Claiming gives <b>Mana/sec</b> and expands your <b>territory</b> (cyan area) while the anchor stands.",
  "Inside your territory, <b>drag a tower card</b> from the deck onto the ground to summon. Towers auto-produce units.",
  "Units push toward the <b>red Dark Fortresses</b> by default. Stay close and they will follow you. <b>Alt+click</b> a tower to toggle <b>Hold</b>.",
  "Destroy the red fortresses or wipe the enemy camps to win.",
];

/** Show a staged, dismissible overlay that can be skipped forever (per browser). */
export function showRulesToast(): void {
  if (document.getElementById(ROOT_ID)) return;
  try {
    if (window.localStorage.getItem(STORAGE_KEY) === "1") return;
  } catch {
    /* ignore */
  }

  const el = document.createElement("div");
  el.id = ROOT_ID;
  el.className = "onboarding-overlay";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Tutorial");

  let stage = 0;

  const render = (): void => {
    const n = STAGES.length;
    const dots = Array.from({ length: n })
      .map((_, i) => `<span class="ob-dot${i === stage ? " ob-dot--on" : ""}"></span>`)
      .join("");
    el.innerHTML = `
      <div class="onboarding-card" role="document">
        <div class="ob-stage">Step ${stage + 1} of ${n}</div>
        <div class="ob-text">${STAGES[stage]}</div>
        <div class="ob-dots">${dots}</div>
        <div class="ob-actions">
          <button class="ob-btn ob-btn--skip" type="button" data-action="skip">Skip</button>
          <button class="ob-btn ob-btn--primary" type="button" data-action="next">${
            stage === n - 1 ? "Got it" : "Next"
          }</button>
        </div>
      </div>
    `;
  };

  const dismiss = (): void => {
    try {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      /* ignore */
    }
    el.remove();
  };

  el.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest("button[data-action]") as HTMLButtonElement | null;
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "skip") dismiss();
    else if (action === "next") {
      if (stage >= STAGES.length - 1) dismiss();
      else {
        stage += 1;
        render();
      }
    }
  });

  render();
  document.body.appendChild(el);
}
