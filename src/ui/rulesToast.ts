import { getControlProfile } from "../controlProfile";

const ROOT_ID = "signal-wars-onboarding";
const STORAGE_KEY = "sw:onboarding:hero-pivot:v1:dismissed";

const STAGES: string[] = [
  "You are a <b>Wizard</b>. <b>WASD</b> moves <b>relative to the camera</b>. <b>Right-click</b> sets a move goal on release; <b>Shift+right-click</b> queues it. <b>Drag right-click</b> with units selected to draw a formation line (<b>V</b> cycles Line / Wedge / Arc; <b>Shift</b> widens ranks). <b>Middle mouse</b> orbits the camera.",
  "Walk into a grey <b>Mana node</b> and stay inside the ring to claim it (no click-to-claim). A physical <b>anchor pillar</b> appears with an <b>HP bar</b>; enemies can smash it to make the node <b>neutral</b> again, then contest it. Your claim grants <b>Mana/sec</b> and expands cyan <b>territory</b> while the anchor stands.",
  "<b>Unit combat is automatic</b>: anything in <b>weapon range</b> trades damage on the sim clock (watch HP rings shrink; colored <b>attack reads</b> show who is striking and toward whom). <b>Swarm / Line / Heavy / Titan</b> matters; each tower produces a squad batch, and bigger classes hit harder while costing more population.",
  "<b>Wizard attacks are automatic</b> when something hostile is in arcane range. <b>R</b> arms a global rally; your next click sets where the army marches in Offense. <b>G</b> toggling stance cancels that march. Drag a tower card onto the map to summon inside your territory.",
  "<b>G</b> toggles Offense / Defense. Offense: engage foes; with a rally point set, units march there until you change stance. Defense: army gathers on you.",
  "Defeat = your <b>Keep</b> or <b>Wizard</b> dies. Victory = shatter the red <b>Dark Fortresses</b> or rout the camps. Good luck.",
];

const MOBILE_STAGES: string[] = [
  "You are an interdimensional <b>Wizard</b>. On mobile, <b>tap ground</b> to move or send selected squads, use the <b>bottom bar</b> for formation, rally, and stance, and let <b>Captain mode</b> steer the Wizard when you are busy dragging cards.",
  "Walk into a grey <b>Mana node</b> and stay inside the ring to claim it. Claimed nodes grant <b>Mana/sec</b>, expand cyan <b>territory</b>, and grow the battlefield where your doctrine can be summoned.",
  "<b>Cards drive the war</b>: drag a tower or spell from the bottom doctrine strip onto valid ground. Green/blue reads mean playable; warnings explain Mana, cooldown, territory, or target problems.",
  "<b>Combat is automatic</b>, but your taps still matter. Move squads from the map and steer macro flow with the dock while armies trade blows and the Wizard auto-strikes hostile targets in range.",
  "Victory = shatter the red <b>Dark Fortresses</b> or rout the camps. Defeat = your <b>Keep</b> or <b>Wizard</b> falls.",
];

/** Show a staged, dismissible overlay that can be skipped forever (per browser). */
export function showRulesToast(): void {
  if (document.getElementById(ROOT_ID)) return;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("noOnboarding") === "1" || params.get("onboarding") === "0") return;
  } catch {
    /* ignore */
  }
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
  const stages = getControlProfile().mode === "mobile" ? MOBILE_STAGES : STAGES;

  let stage = 0;

  const render = (): void => {
    const n = stages.length;
    const dots = Array.from({ length: n })
      .map((_, i) => `<span class="ob-dot${i === stage ? " ob-dot--on" : ""}"></span>`)
      .join("");
    el.innerHTML = `
      <div class="onboarding-card" role="document">
        <div class="ob-stage">Step ${stage + 1} of ${n}</div>
        <div class="ob-text">${stages[stage]}</div>
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
      if (stage >= stages.length - 1) dismiss();
      else {
        stage += 1;
        render();
      }
    }
  });

  render();
  document.body.appendChild(el);
}

export function hideRulesToast(): void {
  document.getElementById(ROOT_ID)?.remove();
}
