# Opus 4.7-style Supercharge Plan for Signal Wars

## Goal
Push the current playable prototype into a faster, clearer, and more “premium-feeling” strategy experience by focusing on:

1. **Deterministic competitive integrity** (sim reliability + replayability)
2. **Tactical clarity** (players instantly understand why they won/lost)
3. **Meta depth** (doctrine building and counterplay)
4. **Content throughput** (ship new structures/commands quickly)
5. **Presentation quality** (juice and legibility)

---

## 1) Simulation architecture upgrades (high impact, low risk)

### 1.1 Move from monolithic tick order to explicit simulation stages + event bus
`advanceTick` currently runs a fixed ordered chain of systems, which is clean but tightly coupled. Introduce an event queue (`SimEvent[]`) and per-stage processing:

- Pre-intents
- Intents
- Economy
- Production
- Combat resolve
- Death + cleanup
- Win/Lose + telemetry

**Why:** easier to add new mechanics (auras, procs, commands, hazards) without brittle ordering bugs.

### 1.2 Add frame-to-frame deterministic snapshot hashing
Compute a cheap hash each N ticks over state slices (units, structures, relays, resources).

**Why:** catches non-determinism early and unlocks deterministic replay verification.

### 1.3 Add replay capture
Persist match seed + intents by tick. A replay runner can reconstruct match state exactly.

**Why:** huge for balancing, bug reports, and future asynchronous challenge modes.

---

## 2) Combat and AI sophistication (big gameplay lift)

### 2.1 Replace nearest-target scan with spatial partitioning
Current unit combat loops perform many full scans. Introduce a uniform grid (or hash buckets) rebuilt each tick:

- query nearby foes in local cells
- query nearby structures/relays in local cells

**Why:** scale to larger battles and enable richer unit counts without frame drops.

### 2.2 Threat-based target selection
Instead of only nearest target, score by:

- priority class (anti-tag matchups)
- low HP execute opportunities
- distance cost
- strategic objective modifiers (relay/core focus)

**Why:** battles feel smarter with minimal micro complexity.

### 2.3 Sticky combat windows
Add short lock-on windows (e.g., 0.4–0.8s) before retargeting.

**Why:** reduces jitter and “unit indecision” in crowded fights.

### 2.4 Intentional enemy camp behaviors
Upgrade camp wake logic into behavior profiles:

- Turtle (defend core radius)
- Skirmish (probe edges)
- Punish (counter-push weak lanes)

**Why:** makes PvE feel authored rather than generic.

---

## 3) Doctrine and meta depth (what keeps players returning)

### 3.1 Add doctrine archetype tags
Tag entries with roles (Tempo, Siege, Sustain, Control) and expose synergy indicators in UI.

**Why:** guides deckbuilding and lowers onboarding friction.

### 3.2 Add side-grade augment system
Between matches (or at scenario nodes), allow one augment per entry:

- +cadence / -HP
- +range / -speed
- +salvage return aura / -damage

**Why:** increases combinatorial depth without multiplying catalog size.

### 3.3 Introduce “signal pressure” mechanics
When a signal count barely meets requirement, apply instability risk events (e.g., brief production stalls) unless stabilized by specific support structures.

**Why:** makes relay destruction and tech denial more strategically meaningful.

---

## 4) UX and readability upgrades (critical for perceived quality)

### 4.1 Add explainable combat feedback
On major hits, emit readable floating tags:

- “ANTI-CLASS +50%”
- “FORWARD BUILD x2 INCOMING”
- “FORTIFIED -50% INCOMING”

**Why:** teaches players systems through play.

### 4.2 Add tactical overlays toggle
Hotkey overlays:

- unit aggro radii
- production ranges
- relay influence / requirement satisfaction
- blocked placement reasons with geometry preview

**Why:** turns hidden rules into visible strategy tools.

### 4.3 Add post-match timeline panel
Per-minute graph of Flux, Salvage, pop, structures alive, and relay count.

**Why:** players can diagnose losses and iterate doctrine choices.

---

## 5) Content pipeline acceleration (ship faster)

### 5.1 Move structure/unit definitions to versioned data packs
Formalize catalog schema with JSON validation (zod or TS runtime guards), including migration versions.

**Why:** safer balancing edits, easier community content later.

### 5.2 Add lightweight balance simulator CLI
Run 1000 seeded skirmish sims headlessly to compare entries:

- win rate by doctrine archetype
- average TTK by unit class
- Flux efficiency curves

**Why:** faster balancing than manual playtests alone.

### 5.3 Add “content lint” checks
CI lint for:

- missing icons/model references
- impossible signal requirements
- extreme cadence/pop outliers

**Why:** prevents broken content from reaching playtest builds.

---

## 6) Presentation and feel upgrades (“Opus polish”)

### 6.1 Impact framing
- camera micro-shake on siege hits
- selective chromatic pulse on relay loss
- timed audio stingers for tier unlocks

### 6.2 Construction storytelling
Three-step building lifecycle visuals:

1. foundation marker
2. scaffold growth
3. finished silhouette + signal crest

### 6.3 Strong faction identity pass
Per-signal VFX language:

- Vanguard = sharp, hot, high-frequency
- Bastion = heavy, low-frequency, shield arcs
- Reclaim = organic pulses, salvage motes

**Why:** gameplay readability and emotional identity increase together.

---

## 7) Prioritized execution roadmap

## Phase A (1–2 weeks): “stability + clarity”
- event bus + staged tick
- deterministic hash checks
- basic replay recording
- explainable combat tags
- tactical overlays (minimal)

**Success metric:** fewer simulation regressions and faster bug reproduction.

## Phase B (2–4 weeks): “depth + scale”
- spatial partitioning
- threat-based targeting + sticky locks
- camp behavior profiles
- post-match timeline

**Success metric:** larger battles remain smooth; players report clearer strategy differences.

## Phase C (2–3 weeks): “meta + pipeline”
- archetype/synergy tags
- data-pack schema + lint
- headless balance simulator

**Success metric:** content iteration speed improves and doctrine diversity increases.

## Phase D (ongoing): “premium feel”
- faction VFX/audio language
- construction lifecycle visuals
- high-value hit/reward moments

**Success metric:** higher session length and stronger first-impression feedback.

---

## Suggested first three tasks (do these immediately)
1. Build deterministic replay scaffold (seed + intents log + checksum).
2. Add spatial grid utility and migrate combat neighbor queries.
3. Implement combat feedback tags for anti-class / fortify / forward-build modifiers.

If these three land cleanly, every other upgrade becomes easier, safer, and faster.
