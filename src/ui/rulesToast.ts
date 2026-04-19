const ROOT_ID = "signal-wars-onboarding";
const STORAGE_KEY = "sw:onboarding:v2:dismissed";

const STAGES: string[] = [
  "You are a <b>Wizard</b>. <b>WASD</b> strafes; <b>right-click</b> sets a move goal; <b>hold right-click</b> to follow the cursor. <b>Middle mouse</b> orbits the camera.",
  "Walk onto a grey <b>Mana node</b> and stand still to claim it (no click-to-claim). Each claim grants <b>Mana/sec</b>, raises your <b>Tier</b> (2 nodes = T2, 4 = T3), and expands your cyan <b>territory</b>.",
  "<b>Left-click</b> on the ground to swing at nearby enemies when not placing a tower. Inside territory, <b>drag a tower card</b> onto the ground — it arrives with a flash of <b>lightning</b>. Your <b>Keep</b> slowly vents a free swarm.",
  "<b>G</b> toggles Offense / Defense. Offense: your army seeks foes. Defense: they all rally on you.",
  "Defeat = your <b>Keep</b> or <b>Wizard</b> dies. Victory = shatter the red <b>Dark Fortresses</b> or rout the camps. Good luck.",
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
