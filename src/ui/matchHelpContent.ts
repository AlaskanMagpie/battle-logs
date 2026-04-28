/**
 * Prematch binder: goals + map loop (shown in the hold-to-open overlay, not the strip).
 */
export const BINDER_PREMATCH_GOALS_HTML = `
<div class="binder-help-goals" role="region" aria-label="Match goals">
  <p><strong>Goal:</strong> Knock out the enemy HQ (Keep), or deal the most damage when the match timer runs out.</p>
  <p><strong>How:</strong> Capture and fight for Mana nodes, play cards from your doctrine to build and cast, and direct your troops on the field.</p>
</div>
`.trim();

/**
 * Shared keyboard / mouse reference (match HUD dock + binder hold overlay).
 * Keep in sync with gameplay / hotkeys when they change.
 */
export const MATCH_HELP_INNER_HTML = `
<div class="hud-help-grid" role="region" aria-label="Keyboard and mouse controls">
  <div class="hud-help-item hud-help-item--desktop"><kbd>1</kbd>–<kbd>0</kbd> doctrine · <kbd>WASD</kbd> pan camera · <kbd>RMB</kbd> move · drag <kbd>RMB</kbd> formation</div>
  <div class="hud-help-item hud-help-item--mobile"><strong>Mobile:</strong> tap ground to move/attack-move · dock bar for formation, rally, stance · drag cards to summon</div>
  <div class="hud-help-item"><kbd>MMB</kbd> drag pan · <kbd>Shift</kbd>+<kbd>MMB</kbd> orbit · <kbd>C</kbd> follow wizard · <kbd>Z</kbd> battle cam</div>
  <div class="hud-help-item"><kbd>LMB</kbd> select troop · drag <strong>card</strong> to map to build</div>
  <div class="hud-help-item"><kbd>V</kbd> formation · <kbd>Shift</kbd>+<kbd>RMB</kbd> queue/wide · <kbd>Alt</kbd>+<kbd>RMB</kbd> attack-move · <kbd>R</kbd> rally · <kbd>G</kbd> stance</div>
  <div class="hud-help-item"><kbd>Shift</kbd>+tower <span class="hud-help-muted">Muster</span> · <kbd>Alt</kbd>+tower Hold</div>
</div>
`.trim();
