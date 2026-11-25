import { createInitialState, findKeep, pruneUnitSpellStatuses, tickHeroTeleportCooldown, type GameState } from "../game/state";
import type { MapData, TeamId } from "../game/types";
import type { PlayerIntent } from "../game/intents";
import { movement } from "../game/sim/systems/ai";
import { heroSystem, respawnDeadHeroAtKeep } from "../game/sim/systems/hero";
import { applyPlayerIntents, resolveDueFirestorms } from "../game/sim/systems/intents";
import { economy, salvageTrickle, tickDoctrineCooldowns } from "../game/sim/systems/economy";
import { buildProgress, production } from "../game/sim/systems/production";
import { auras } from "../game/sim/systems/auras";
import { combat } from "../game/sim/systems/combat";
import { cleanupDead } from "../game/sim/systems/deaths";
import { timeLimitCheck } from "../game/sim/systems/winlose";
import { advanceWorldObjectives } from "../game/surfaces";
import { KEEP_ID, ENEMY_DAMAGE_MULT, ENEMY_PRODUCTION_RATE_MULT } from "../game/constants";
import { stateChecksum } from "../game/replay";

// These controls belong to a particular Wizard. World coordinates and entity IDs are shared.
const personal = [
  "salvage","doctrineSlotCatalogIds","doctrineChargesRemaining","doctrineCooldownTicks",
  "selectedDoctrineIndex","selectedStructureId","selectedUnitId","selectedUnitIds","selectedUnitBox",
  "heroCaptainEnabled","heroCaptainLastManualTick","teleportClickPending","heroTeleportCooldownTicks",
  "pendingPlacementCatalogId","armyStance","formationPreset","formationMarches","rallyClickPending",
  "globalRallyActive","globalRallyX","globalRallyZ","globalPopCapBonus","lastMessage","pendingFirestorms",
] as const;
type WizardControls = Pick<GameState,(typeof personal)[number]>;
function controls(s:GameState): WizardControls {
  return Object.fromEntries(personal.map(key=>[key,s[key]])) as WizardControls;
}
function invert(team:TeamId): TeamId { return team === "player" ? "enemy" : "player"; }
function invertMap(map:MapData):MapData {
  return {...map,playerStart:map.enemyStart ?? {x:-map.playerStart.x,z:map.playerStart.z},enemyStart:map.playerStart,
    playerRelaySlots:map.enemyRelaySlots,enemyRelaySlots:map.playerRelaySlots};
}

export class BattleAuthority {
  readonly state: GameState;
  private other: WizardControls;
  private reverseMap: MapData;

  constructor(map: MapData, seed:number, hands:Record<TeamId,(string|null)[]>) {
    const pvpMap = {...map, difficulty:{enemyEffectivenessMult:1,enemyDamageMult:1/ENEMY_DAMAGE_MULT,
      enemyProductionSpeedMult:1/ENEMY_PRODUCTION_RATE_MULT}};
    const s=createInitialState(pvpMap,hands.player);
    this.state=s;
    this.reverseMap=invertMap(s.map);
    const opponent=createInitialState(this.reverseMap,hands.enemy);
    this.other=controls(opponent);
    const keep=findKeep(opponent)!;
    s.structures.push({...keep,id:s.nextId.structure++,team:"enemy"});
    s.enemyRelays=[];
    s.enemyFlux=s.flux;
    s.enemyHero.speedPerSec=s.hero.speedPerSec;
    s.rngState=seed>>>0;
  }

  // Run the existing local order, placement and claim rules from the other Wizard's side.
  // Restoring the perspective a second time keeps IDs, positions, HP and the shared clock intact.
  private swap():void {
    const s=this.state;
    const current=controls(s);
    Object.assign(s,this.other);
    this.other=current;
    [s.hero,s.enemyHero]=[s.enemyHero,s.hero];
    [s.flux,s.enemyFlux]=[s.enemyFlux,s.flux];
    this.reverseMap.ringAligned=s.map.ringAligned;
    [s.map,this.reverseMap]=[this.reverseMap,s.map];
    [s.stats.damageDealtPlayer,s.stats.damageDealtEnemy]=[s.stats.damageDealtEnemy,s.stats.damageDealtPlayer];
    for(const unit of s.units) unit.team=invert(unit.team);
    for(const building of s.structures) building.team=invert(building.team);
    for(const mark of s.combatHitMarks) mark.team=invert(mark.team);
    for(const tap of s.taps) {
      if(tap.ownerTeam) tap.ownerTeam=invert(tap.ownerTeam);
      if(tap.claimTeam) tap.claimTeam=invert(tap.claimTeam);
    }
    for(const zone of s.tacticsFieldZones){
      [zone.allyDamageMult,zone.enemyDamageMult]=[zone.enemyDamageMult,zone.allyDamageMult];
      [zone.allySpeedMult,zone.enemySpeedMult]=[zone.enemySpeedMult,zone.allySpeedMult];
      [zone.allyIncomingDamageMult,zone.enemyIncomingDamageMult]=[zone.enemyIncomingDamageMult,zone.allyIncomingDamageMult];
    }
  }

  private otherSide(action:()=>void):void {
    this.swap();
    try {action();} finally {this.swap();}
  }

  step(player:PlayerIntent[], enemy:PlayerIntent[]):void {
    const s=this.state;
    if(s.phase!=="playing") return;
    timeLimitCheck(s);
    if(s.phase!=="playing") return;
    s.tacticsFieldZones=s.tacticsFieldZones.filter(z=>z.untilTick>s.tick);
    pruneUnitSpellStatuses(s);
    const orders=(intents:PlayerIntent[])=>{
      tickDoctrineCooldowns(s);
      tickHeroTeleportCooldown(s);
      applyPlayerIntents(s,intents);
      salvageTrickle(s);
    };
    orders(player);
    this.otherSide(()=>orders(enemy));
    economy(s,false);
    buildProgress(s);
    production(s);
    auras(s);
    this.otherSide(()=>auras(s));
    heroSystem(s);
    this.otherSide(()=>heroSystem(s));
    movement(s,"firstSeat");
    this.otherSide(()=>movement(s,"secondSeat"));
    advanceWorldObjectives(s);
    resolveDueFirestorms(s);
    this.otherSide(()=>resolveDueFirestorms(s));
    combat(s);
    cleanupDead(s);
    respawnDeadHeroAtKeep(s);
    this.otherSide(()=>respawnDeadHeroAtKeep(s));
    if(!findKeep(s) || !s.structures.some(st=>st.team==="enemy" && st.catalogId===KEEP_ID && st.hp>0)){
      s.phase=findKeep(s)?"win":"lose";
      s.matchEndDetail="The opposing army destroyed the Keep.";
    }
    s.tick++;
  }

  setCaptain(seat:TeamId, enabled:boolean):void {
    if(seat==="player") this.state.heroCaptainEnabled=enabled;
    else this.other.heroCaptainEnabled=enabled;
  }

  forSeat(seat:TeamId): GameState {
    if(seat==="player") return structuredClone(this.state);
    this.swap();
    try {
      const view=structuredClone(this.state);
      if(view.phase!=="playing") view.phase=view.phase==="win"?"lose":"win";
      return view;
    } finally {this.swap();}
  }

  checksum():number {return stateChecksum(this.state);}
}
