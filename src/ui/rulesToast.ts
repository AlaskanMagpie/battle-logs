const ROOT_ID = "signal-wars-onboarding";
const STORAGE_KEY = "sw:onboarding:v2:dismissed";

const STAGES: string[] = [
  "You are a <b>Wizard</b>. <b>WASD</b> strafes; <b>right-click</b> sets a move goal; <b>hold right-click</b> to follow the cursor. <b>Middle mouse</b> orbits the camera.",
  "Walk onto a grey <b>Mana node</b> and stand still to claim it (no click-to-claim). A physical <b>anchor pillar</b> appears with an <b>HP bar</b> — enemies can smash it to make the node <b>neutral</b> again, then contest it. Your claim grants <b>Mana/sec</b>, raises <b>Tier</b> (2 nodes = T2, 4 = T3), and expands cyan <b>territory</b> while the anchor stands.",
  "<b>Unit combat is automatic</b>: anything in <b>weapon range</b> trades damage on the sim clock (watch HP rings shrink; orange <b>wedges</b> show who is striking and toward whom). <b>Swarm · Line · Heavy · Titan</b> matters; <b>anti-Class</b> tags and <b>trample</b> (e.g. Heavy vs Swarm) change damage. Your <b>wizard</b> also has an automatic <b>arcane strike</b> in melee range (lightning bolt + ring) on its own cooldown — separate from troop AI. <b>Click a friendly troop</b> (when not summoning) to preview its <b>melee range ring</b>; click again to clear.",
  "<b>Left-click</b> triggers the same wizard strike when you are not placing a tower (shows HUD feedback). <b>R</b> arms a global rally — your next click sets where the army marches in Offense; <b>G</b> toggling stance cancels that march. Drag a tower card onto the map to summon.",
  "<b>G</b> toggles Offense / Defense. Offense: engage foes; with a rally point set, units march there until you change stance. Defense: army gathers on you.",
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
