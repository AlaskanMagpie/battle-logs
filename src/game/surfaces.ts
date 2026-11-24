import type { GameState } from "./state";
import type { MapData, Vec2 } from "./types";

/** Local X runs from one ramp toe to the other. Ground beneath stays traversable. */
export interface RaisedSurface extends Vec2 {
  id: string;
  length: number;
  width: number;
  height: number;
  ramp: number;
}
export type SurfacePoint = Vec2 & { surfaceId?: string };
export function containsSurface(s: RaisedSurface, p: Vec2, pad = 0): boolean {
  return Math.abs(p.x - s.x) <= s.length / 2 + pad && Math.abs(p.z - s.z) <= s.width / 2 + pad;
}
export function elevation(s: RaisedSurface, x: number): number {
  return s.height * Math.max(0, Math.min(1, (s.length / 2 - Math.abs(x - s.x)) / s.ramp));
}
export function surfaceHeight(map: MapData, p: SurfacePoint): number {
  const s = p.surfaceId && map.surfaces?.find(s => s.id === p.surfaceId);
  return s ? elevation(s, p.x) : 0;
}
export function sameSurface(a: SurfacePoint, b: SurfacePoint): boolean {
  return a.surfaceId === b.surfaceId;
}
export function updateSurface(state: GameState, actor: SurfacePoint): void {
  const surfaces = state.map.surfaces;
  if (!surfaces?.length) return;
  const current = actor.surfaceId && surfaces.find(s => s.id === actor.surfaceId);
  if (current && Math.abs(actor.x - current.x) < current.length / 2) {
    actor.z = Math.max(current.z - current.width / 2, Math.min(current.z + current.width / 2, actor.z));
    return;
  }
  delete actor.surfaceId;
  for (const s of surfaces) {
    if (!containsSurface(s, actor)) continue;
    if (state.map.mapId === "fallen_orrery" && (state.orreryOpenUntil ?? 0) <= state.tick) continue;
    if (s.length / 2 - Math.abs(actor.x - s.x) < 3) actor.surfaceId = s.id;
  }
}
export function advanceWorldObjectives(s: GameState): void {
  if (s.map.mapId === "fallen_orrery") {
    s.map.ringAligned = (s.orreryOpenUntil ?? 0)>s.tick;
    const control = {x: 0, z: -44};
    const inside = [s.hero, s.enemyHero].filter(h => h.hp > 0 && Math.hypot(h.x-control.x,h.z-control.z)<10);
    if (inside.length === 1 && (s.orreryOpenUntil ?? 0) <= s.tick) {
      s.orreryChannel = (s.orreryChannel ?? 0) + 1;
      if (s.orreryChannel >= 40) {
        s.orreryOpenUntil = s.tick + 360;
        s.map.ringAligned = true;
        s.orreryChannel = 0;
        s.lastMessage = "The observatory aligned the equatorial crossing for 18 seconds.";
      }
    } else s.orreryChannel = 0;
  }
  if (s.map.mapId === "drowned_causeway" && !s.evacuationSecured) {
    const ford = s.taps.find(t=>t.defId === "ford");
    s.evacuationTicks = ford?.ownerTeam === "player" && ford.active ? (s.evacuationTicks ?? 0) + 1 : 0;
    if (s.evacuationTicks >= 240) {
      s.evacuationSecured = true;
      s.lastMessage = "The spellrunners escaped. Their Oasis will answer your call.";
    }
  }
}

/** Ramp toes link the upper surface to the ground. Enter the ford from its bank. */
export function surfaceRoute(map:MapData, from:Vec2, to:Vec2, clearance:number): Vec2[] {
  const checkpoints:Vec2[]=[];
  for(const deck of map.surfaces ?? []) {
    const end=deck.length/2+clearance+1;
    const sign=(from.x<deck.x?-1:1);
    if(from.surfaceId===deck.id && to.surfaceId!==deck.id) {
      const exitSign=to.x<deck.x?-1:1;
      checkpoints.push({x:deck.x+exitSign*end,z:deck.z});
      if (containsSurface(deck,to)) {
        const bank=deck.z+(to.z<deck.z?-1:1)*(deck.width/2+clearance+3);
        checkpoints.push({x:deck.x+exitSign*end,z:bank},{x:to.x,z:bank});
      }
    }
    if(to.surfaceId===deck.id && from.surfaceId!==deck.id) {
      checkpoints.push({x:deck.x+sign*end,z:deck.z});
    } else if(!to.surfaceId && containsSurface(deck,to) && from.surfaceId!==deck.id &&
      Math.abs(from.x-deck.x)>deck.length/2) {
      const bank=deck.z+(from.z<deck.z?-1:1)*(deck.width/2+clearance+3);
      checkpoints.push({x:deck.x+sign*end,z:bank},{x:to.x,z:bank});
    }
  }
  return [...checkpoints,to];
}
