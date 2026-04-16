# Signal Wars — Vibejam PRD v2
## "Every card is a building. Every building makes an army."

### One-liner
Deterministic deck RTS where you place production structures on the map and they raise your army for you.

---

## Core Loop (30-second pitch)
1. Player brings a **16-slot Doctrine** into a match. Every slot is a **Structure** or a **Command** (spell).
2. All 16 are visible. None are shuffled. Availability is gated by **Relays** on the map.
3. Player captures **Taps** (income) and **Relays** (tech) across the map.
4. Player places Structures near infrastructure. Each Structure **produces units on a cadence** once built.
5. Units auto-deploy from their parent Structure and fight with simple AI (attack-move, hold, patrol).
6. Destroyed Structures refund partial Flux via Salvage. Destroyed Taps and Relays refund nothing.
7. Win by eliminating all enemy Relays or completing the scenario objective.

**The key difference from v1:** You do not summon units directly. You build the thing that makes them. Your Doctrine is a roster of production buildings, not a hand of creature cards.

---

## Why Buildings-as-Cards Works

This does three things at once.

**It gives the game a visual identity.** The card art IS the building. The 3D map model IS the building. One asset does double duty. Each Structure is a miniature fortress, outpost, workshop, or encampment with its own silhouette and personality. The concept art direction (civilizations built into stumps, roots, driftwood, natural formations) makes every Structure feel like a place, not a stat block.

**It makes placement the core skill.** In BattleForge, you summoned units near infrastructure and then micro'd them. Here, the building IS the investment. Where you drop it, how you protect it, and when you commit to it are the decisions. Units flow out automatically. The strategy is in the city planning, not the hand management.

**It scales the roster cleanly.** New content = new building. Each building has a name, a look, a unit type it produces, and a production cadence. You can add buildings to the roster indefinitely without reworking systems. The Doctrine slot limit (16) keeps matches tight even as the total catalog grows.

---

## Economy

### Flux (main resource)
- **Taps** generate Flux. Each Tap produces **1 Flux/sec**.
- Taps cost **80 Flux** to activate. Finite capacity per Tap (~250 total yield). Payoff ~80 sec.
- Map has a fixed number of Tap slots. No passive Flux gen without Taps.

### Salvage (recycling pool)
- When a Structure or its units are destroyed, **80% of the original build cost** enters Salvage. **20% is lost.**
- Salvage converts back to Flux at `salvagePool / 40` per sec, capped at **15 Flux/tick**.
- **Taps and Relays return 0% on death.** This is the macro punishment lever.
- Commands (spells) dump 100% of cost into Salvage immediately.

### Production cost model
Structures have a **one-time build cost**. Units produced by that Structure are free. The cost of the building prices in the value of everything it will produce. Destroying a Structure kills the income stream, not just one unit.

This means a 200-Flux Structure that produces Swarm squads every 20 seconds is not "a 200 Flux unit." It is a 200 Flux factory. Losing it hurts more than losing any single squad. Protecting your production line is the game.

---

## Tech System — Relays

### How Relays gate your Doctrine
- Relays are built on fixed map slots.
- Each Relay has a **Signal Type** chosen at build time.
- Your Doctrine entries each require a certain number and combination of Signal Types to become active.
- **Tier = total Relay count.** Tier 1 = 1 Relay. Tier 2 = 2. Tier 3 = 3.
- **Specialization = Signal Type combo.** A building might need "2 any + 1 Vanguard" to unlock.

### Relay costs
| Relay # | Cost |
|---------|------|
| 1       | Free (assigned by first Structure placed) |
| 2       | 120 Flux |
| 3       | 200 Flux |
| 4       | 250 Flux |

### Relay destruction
- If a Relay dies, any Doctrine entries that depended on it go dark. You cannot place new copies.
- **Existing Structures on the map stay alive** but stop producing units until the Relay requirement is restored.
- Rebuilding a Relay costs 80 Flux.
- Lose all Relays = 10-second grace period, then defeat.

---

## Signal Types (factions/colors)

Three for the jam. Four is the stretch goal.

| Signal | Identity | Building personality |
|--------|----------|---------------------|
| **Vanguard** | Aggro, siege, speed | War camps, siege workshops, assault towers. Fast-producing, fragile structures. Units hit hard, die fast. |
| **Bastion** | Defense, fortification, area denial | Stone keeps, walled outposts, shield generators. Slow to build, tough to kill. Units are durable and short-range. |
| **Reclaim** | Healing, economy, attrition | Apothecaries, salvage yards, root gardens. Structures that buff nearby allies, boost Salvage return, or resummon fallen units. |

Hybrid buildings (e.g. 1 Vanguard + 1 Reclaim) are the most interesting designs. A Vanguard/Reclaim building might produce glass-cannon units that heal on kill. A Bastion/Reclaim building might be a fortified recycling node that returns extra Salvage when nearby units die.

---

## Structures (the cards)

Every Doctrine entry is one of two types: **Structure** or **Command.**

### Structure cards (the core)
Each Structure has:
- **Name and art.** The card face shows the building. The diorama aesthetic (civilizations in stumps, forts in roots, workshops in driftwood) is the visual brand.
- **Flux cost.** One-time placement cost.
- **Signal requirements.** Which Relays you need active.
- **Build time.** 10-20 seconds depending on tier.
- **Unit produced.** What comes out.
- **Production cadence.** How often a new unit (or squad) spawns. Measured in seconds.
- **Unit cap contribution.** Each Structure adds a fixed amount to your local pop. If the Structure dies, those pop slots go with it.
- **HP.** How tough the building is.
- **Charges.** How many times you can place this Structure in a match (1-3). Cooldown between placements.

### How production works
Once a Structure finishes building, it begins producing units automatically. Units spawn at the Structure's location and idle nearby until given orders or until they auto-engage enemies in range. Production pauses if you hit the Structure's local pop cap (its units are still alive). Production resumes when units die and free slots.

A Structure can be **rallied** to a map point. New units will attack-move toward the rally point instead of idling.

### Structure placement rules
- **Safe placement:** Near a Tap or Relay. Normal build time, full HP on completion.
- **Forward placement:** Near a friendly ground unit but not near infrastructure. Build time is **doubled**. Structure takes **double damage** while under construction. This is the "forward base" gamble.
- **Structures cannot be placed in enemy aggro radius** (jam simplification to prevent cheese).

### Command cards (spells)
Commands are instant or channeled effects. They do not produce units.
- Cost goes straight to Salvage (no permanent board presence).
- Require friendly ground presence in the target area (a unit or Structure).
- Examples: AoE damage, heal burst, speed boost, temporary shield on a Structure, emergency unit warp.
- 2-4 Command slots in a 16-slot Doctrine is the expected ratio. The rest are Structures.

---

## Unit System

Units come from Structures. You do not summon them directly.

### Size classes

| Class | Pop per unit | Typical spawn | Trample |
|-------|-------------|---------------|---------|
| **Swarm** (squads of 4-6) | 4 | Every 15-20s | — |
| **Line** (1-2 models) | 2 | Every 12-18s | — |
| **Heavy** (single model) | 4 | Every 25-35s | Crushes Swarm |
| **Titan** (single model) | 8 | Every 45-60s | Crushes Swarm + Line |

- **Population cap: 80 total** across all your Structures.
- Each Structure contributes a local cap (e.g. a Swarm barracks might cap at 3 squads = 12 pop, a Titan forge might cap at 1 Titan = 8 pop).
- Each unit has an **anti-class tag** (anti-Swarm, anti-Line, anti-Heavy, anti-Titan). Hitting the tagged class deals **+50% damage**.

### Unit behavior (jam scope)
- **Auto-attack** nearest enemy in detection range.
- **Rally point** from parent Structure. Units attack-move to rally.
- **Hold position** toggle per unit or group.
- No complex micro. No ability activation on units for the jam. Abilities live on Structures and Commands.

---

## Starter Structure Roster (jam scope)

Ship **18-24 Structures + 4-6 Commands** for the full catalog. Player picks 16 for their Doctrine.

### Tier 1 (1 Relay, any Signal Type)
These are your openers. Cheap, fast to build, basic units.

| Name | Signal | Cost | Produces | Cadence | Pop cap | Notes |
|------|--------|------|----------|---------|---------|-------|
| **Watchtower** | Vanguard | 60 | Swarm scouts (ranged, fast, fragile) | 18s | 8 | Anti-Heavy. Your early map control. |
| **Root Bunker** | Bastion | 70 | Line sentinels (melee, shielded) | 16s | 6 | Anti-Swarm. Cheap wall of bodies. |
| **Mender's Hut** | Reclaim | 60 | Line medics (heals nearest ally, weak attack) | 20s | 4 | No anti-tag. Passive heal aura while alive. |

### Tier 2 (2 Relays)
The mid-game backbone. Stronger units, more expensive buildings.

| Name | Signal | Cost | Produces | Cadence | Pop cap | Notes |
|------|--------|------|----------|---------|---------|-------|
| **Siege Works** | Vanguard x2 | 150 | Heavy rams (slow, massive structure damage) | 30s | 8 | Anti-building. Ignores 50% structure armor. |
| **Bastion Keep** | Bastion x2 | 180 | Heavy knights (melee, high HP) | 28s | 8 | Anti-Line. Structure itself has a turret. |
| **Salvage Yard** | Reclaim x2 | 120 | Swarm scrappers (melee, fast) | 16s | 8 | Anti-Swarm. +20% Salvage return for all deaths within radius. |
| **War Camp** | Vanguard + Bastion | 140 | Line soldiers (balanced melee) | 14s | 8 | Anti-Heavy. Rally radius grants safe deploy to other Structures nearby. |
| **Root Garden** | Reclaim + Bastion | 130 | Line thorns (ranged, poison DoT) | 18s | 6 | Anti-Line. Heals 2 HP/sec to all friendly Structures in radius. |
| **Raid Nest** | Vanguard + Reclaim | 130 | Swarm raiders (melee, heal-on-kill) | 15s | 8 | Anti-Swarm. Produced units have lifesteal. |

### Tier 3 (3 Relays)
The closers. Expensive, powerful, game-ending if protected.

| Name | Signal | Cost | Produces | Cadence | Pop cap | Notes |
|------|--------|------|----------|---------|---------|-------|
| **Dragon Roost** | Vanguard x2 + any | 280 | Titan wyvern (flying, AoE breath) | 50s | 8 | Anti-Swarm. Flying ignores ground collision. |
| **Ironhold Citadel** | Bastion x2 + any | 300 | Titan golem (melee, massive HP, slow) | 55s | 8 | Anti-Heavy. Structure itself has heavy armor + turret. |
| **Reclamation Spire** | Reclaim x2 + any | 250 | Heavy wraith (ranged, phase-shift) | 35s | 8 | Anti-Titan. On death, 100% cost returns to Salvage instead of 80%. |

### Commands (spells)

| Name | Signal | Cost | Effect |
|------|--------|------|--------|
| **Firestorm** | Vanguard | 80 | AoE damage in target area. Requires friendly ground presence. |
| **Fortify** | Bastion | 60 | Target Structure gains 50% damage reduction for 15 seconds. |
| **Recycle** | Reclaim | 40 | Instantly destroy a friendly Structure and recover 90% to Salvage (instead of 80%). |
| **Muster** | Any | 50 | Target Structure instantly produces one unit, bypassing cadence timer. |
| **Shatter** | Vanguard + Bastion | 100 | Target enemy Structure takes 300 damage and stops producing for 10 seconds. |

---

## Visual Direction

### The diorama aesthetic
Every Structure is a miniature world. The concept art establishes the brand:
- **Natural foundations.** Stumps, roots, driftwood, rock formations. Buildings are carved into, built onto, and grown out of the terrain.
- **Tiny civilizations.** Miniature figures, ladders, banners, glowing portals, workshops. Each building tells a story of who lives there and what they do.
- **Environmental variety.** Forest stumps (green, mossy, telescopes). Desert driftwood (trade posts, alchemy). Snowy stumps (clockwork, observatories). Stone fortresses (battlements, stained glass). This gives each Signal Type a biome flavor without hard-locking it.
- **Scale contrast.** Buildings are big and detailed. Units are small and readable. The building is the star.

### In-game translation (jam scope)
- **Camera:** Top-down or slight isometric tilt.
- **Structures:** Distinct 2D sprites or simple 3D models. Each must have a unique silhouette readable at zoom-out. Even placeholder art should differentiate buildings by shape (tall/narrow for Vanguard, squat/wide for Bastion, organic/branching for Reclaim).
- **Units:** Simple colored shapes or sprites. Swarm = cluster of dots. Line = pair of shapes. Heavy = single larger shape. Titan = big glowing shape. Unit color matches parent Structure's Signal Type.
- **Taps and Relays:** Neutral node markers on the map. Glow with your color when captured.
- **UI:** Doctrine bar across the bottom. Each slot shows the building thumbnail. Greyed out if requirements unmet or on cooldown. Flux counter top-left. Salvage counter below with trickle animation. Pop counter top-right.

### Card presentation
Cards show the building art front and center. Stats are overlaid:
- Top-left: Flux cost.
- Top-right: Signal requirement dots.
- Bottom: unit produced icon + cadence timer + pop cap.
- Charges shown as pips below the card.

---

## Tech Stack (suggestion)

- **Engine:** Phaser 3 or Three.js (web-native for jam). Godot if native is fine.
- **State:** Single game state object. Tick-based loop (10 ticks/sec).
- **Production:** Each Structure runs its own timer. On tick, check local pop cap. If under cap, decrement timer. On zero, spawn unit at Structure position, reset timer.
- **AI:** Simple FSM. Units: idle > attack-move to rally > engage nearest enemy. Enemy camps: static until triggered, then attack-move toward nearest player Structure.
- **Networking:** None. Solo PvE only.

---

## Build Priority

### Phase 1 — Playable loop
1. Map with Tap slots and Relay slots. Click to build Taps/Relays.
2. Flux generation. Flux counter in UI.
3. Doctrine bar with 3 hardcoded Structures. Click a card, click the map to place.
4. Structures build over time, then begin auto-producing units.
5. Units idle near parent Structure. Click to set rally point.
6. Units auto-attack enemies in range.
7. One enemy camp with static hostile units.

### Phase 2 — Systems
8. Salvage pool + trickle-back.
9. Relay Signal Types gating Doctrine entries.
10. Structure placement rules (safe vs forward).
11. Size classes + anti-class bonus damage.
12. Charges and cooldowns on Structure cards.
13. Structure local pop caps.

### Phase 3 — Content
14. Full 18-24 Structure roster + 4-6 Commands.
15. Full scenario map with 3-4 camps and a final objective.
16. Difficulty scaling (enemy HP/DPS multiplier).
17. Doctrine selection screen pre-match.

### Phase 4 — Polish
18. Building construction animation (rises from ground).
19. Unit spawn animation (emerges from Structure).
20. Particles, glow, screen shake on Titan attacks and Structure destruction.
21. Sound (construction, production ding, combat, destruction).
22. Win/lose screens with stats (Structures built, units produced, Salvage recovered).

---

## What NOT to build for the jam
- Multiplayer/PvP.
- Card trading or marketplace.
- Upgrade/progression systems.
- More than one scenario map.
- Building affinities or alternate versions.
- Fog of war.
- Unit abilities (keep abilities on Structures and Commands only).
- Complex pathfinding (grid movement or simple steering is fine).

---

## Roster Expansion (post-jam notes)

The building-as-card model scales cleanly. To add content later:
- Design a new Structure: name, art, signal requirements, unit type, cadence, special trait.
- Slot it into the catalog. Players add it to their Doctrine if they want it.
- No system rework needed. No new unit-summoning code. Just a new entry in the Structure registry.

Seasonal or themed drops could add entire biome sets (desert driftwood structures, snow clockwork structures, swamp root structures) that all produce units within the existing size-class system but with unique visual identities and trait variations.

---

## Clone-safe checklist
- [x] No direct unit summoning (BattleForge's core interaction). Units come from production buildings.
- [x] No elemental orbs. Using Signal Types on Relays.
- [x] No faction color identity (Fire/Frost/Nature/Shadow). Using Vanguard/Bastion/Reclaim.
- [x] No "Void Power." Using Salvage.
- [x] No "Power Wells." Using Taps.
- [x] No "Monuments." Using Relay slots.
- [x] No "Dazed." Forward placement penalty is on the Structure, not the unit.
- [x] No TCG hand/draw mechanics. Deterministic loadout of buildings.
- [x] Different economy numbers (80% salvage, different tick rates, one-time build cost model).
- [x] Different deck size (16 vs 20).
- [x] Structural DNA preserved. Surface fingerprint replaced. Production model adds a new layer BattleForge did not have.
