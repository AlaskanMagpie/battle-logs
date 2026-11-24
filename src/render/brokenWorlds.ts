import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { elevation } from "../game/surfaces";
import type { MapData } from "../game/types";

/** Bake repeated masonry, roots and inlays into one draw per material. */
export function buildWorldLandmark(map: MapData): THREE.Group {
  const group = new THREE.Group();
  const surface = map.surfaces?.[0];
  if (!surface) return group;
  const batches = new Map<number, THREE.BufferGeometry[]>();
  function place(color: number, geometry: THREE.BufferGeometry, x: number, y: number, z: number, rx=0, ry=0, rz=0) {
    geometry.rotateX(rx).rotateY(ry).rotateZ(rz).translate(x,y,z);
    const batch = batches.get(color) ?? [];
    batch.push(geometry);
    batches.set(color,batch);
  }
  const box = (w:number,h:number,d:number) => new THREE.BoxGeometry(w,h,d);
  const stone=0x81938b, darkStone=0x43534f, brass=0xc89b55, basalt=0x523e37;
  const id=map.mapId;
  const deckColor=id==="fallen_orrery"?brass:id==="emberroot_caldera"?basalt:stone;
  const segments=32, length=surface.length/segments;
  for (let i=0;i<segments;i++) {
    const x=surface.x-surface.length/2+(i+.5)*length;
    const y=elevation(surface,x);
    const slope=Math.atan2(elevation(surface,x+length/2)-elevation(surface,x-length/2),length);
    place(deckColor,box(length/Math.cos(slope)+.04,.5,surface.width),x,y-.18,surface.z,0,0,slope);
  }
  if(id==="fallen_orrery") {
    const deckGeometry=mergeGeometries((batches.get(deckColor) ?? []).map(g=>g.toNonIndexed()));
    if(deckGeometry) {
      const ringDeck=new THREE.Mesh(deckGeometry,new THREE.MeshStandardMaterial({color:brass}));
      ringDeck.name="alignment-deck";
      group.add(ringDeck);
    }
    batches.delete(deckColor);
  }
  if (id==="drowned_causeway") {
    place(0x477d78,box(25,.05,229),0,.045,0);
    for(let i=-10;i<=10;i++) place(0x84aba1,box(8,.04,.22),Math.sin(i*4)*6,.09,i*10);
    // Pointed abbey arches laid from individual voussoirs on both sides of the road.
    for(const side of [-1,1]) for(const x of [-24,-12,0,12,24]) {
      const z=side*7.7;
      place(darkStone,box(2,4.6,2.2),x-5,2.3,z);
      for(let k=0;k<13;k++) {
        const a=(k+.5)*Math.PI/13;
        place(stone,box(1.45,1.65,2),x+5*Math.cos(a),3.5+4.8*Math.sin(a),z,0,0,a);
      }
      place(stone,box(1,2.6,1),x,10,z);
    }
    for(const x of [-38,-27,-16]) for(const z of [-46,-57]) {
      const h=12+4*Math.cos(x+z);
      place(darkStone,new THREE.CylinderGeometry(1.2,2,h,8),x,h/2,z);
      place(stone,new THREE.ConeGeometry(2,4,6),x,h+2,z);
    }
  } else if(id==="emberroot_caldera") {
    for(let k=0;k<9;k++) {
      const a=k*2.4;
      const points=[new THREE.Vector3(0,29,24),new THREE.Vector3(4*Math.cos(a),12,23+4*Math.sin(a)),
        new THREE.Vector3(12*Math.cos(a),4,23+12*Math.sin(a)),new THREE.Vector3(28*Math.cos(a),.3,23+23*Math.sin(a))];
      place(0x713c28,new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points),15,1.5,6,false),0,0,0);
      place(0xe18a39,new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points),12,.2,5,false),0,1.15,0);
    }
    for(const x of [-15,0,15]) {
      place(basalt,box(8,9,6),x,4.5,23);
      place(0xa74730,new THREE.ConeGeometry(7.4,6,4),x,11.2,23,0,Math.PI/4);
      place(brass,box(2,4,.3),x,3,19.9);
    }
  } else if(id==="fallen_orrery") {
    for(let k=0;k<3;k++) place(k===1?brass:0x6d9baf,new THREE.TorusGeometry(19+k*2,.62,7,80,Math.PI*1.84),0,18,-44,.3+k*.58,k*.77,k*.49);
    place(0xf1dbad,new THREE.IcosahedronGeometry(4.2,2),0,18,-44);
    place(brass,new THREE.TorusGeometry(9,.46,7,60),0,.32,-44,Math.PI/2);
    for(let k=0;k<12;k++){const a=k*Math.PI/6;place(0x6b8295,box(2,4,2.5),13*Math.cos(a),2,-44+13*Math.sin(a),0,-a);}
  }
  for(const [color,geometries] of batches) {
    const geom=mergeGeometries(geometries.map(g=>g.index?g.toNonIndexed():g));
    if(geom) group.add(new THREE.Mesh(geom,new THREE.MeshStandardMaterial({color,roughness:.76})));
    geometries.forEach(g=>g.dispose());
  }
  return group;
}
