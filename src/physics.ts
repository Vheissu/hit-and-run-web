import * as THREE from 'three';
import type { LevelData } from './assets';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Capsule } from 'three/addons/math/Capsule.js';
import { boxTriangleContact } from './vehicle-collision';
import { capsuleTriangleContact } from './collision';
import { simulateVehicle,type VehicleMotion } from './vehicle-physics';

export interface Controls {steer:number;throttle:number;brake:number;handbrake:boolean}
export interface CarState {position:THREE.Vector3;heading:number;speed:number;verticalSpeed:number;steer:number;distance:number;damage:number;grounded?:boolean;vehicleMotion?:VehicleMotion;supportVehicle?:string}
const up=new THREE.Vector3(0,1,0), down=new THREE.Vector3(0,-1,0);
export interface DynamicSolid {id:string;active:boolean;mesh:THREE.Mesh;bounds:THREE.Box3}
export interface VehiclePlatform {id:string;position:THREE.Vector3;heading:number;orientation?:THREE.Quaternion;half:THREE.Vector3;center:THREE.Vector3}

export function drive(state:CarState,control:Controls,dt:number,tuning?:Record<string,number>) {
  simulateVehicle(state,control,dt,tuning);
}

/** One surface the walking capsule can stand on or be stopped by. */
interface CapsuleCollider {mesh?:THREE.Mesh;triangles?:THREE.Triangle[];upward?:boolean}
const _capsule=new Capsule(),_bounds=new THREE.Box3(),_center=new THREE.Vector3(),_start=new THREE.Vector3();
/**
 * Total push-out of a capsule from one group of colliders.
 *
 * Each contact moves a working copy, so a corner resolves against every
 * triangle it touches. Candidates come from the bounds of the capsule before
 * any of that movement, matching the native walk solver.
 */
function capsulePushOut(capsule:Capsule,colliders:CapsuleCollider[]){
  _capsule.copy(capsule);
  _bounds.makeEmpty().expandByPoint(capsule.start).expandByPoint(capsule.end).expandByScalar(capsule.radius);
  let hit=false;
  const push=(triangle:THREE.Triangle,upward:boolean)=>{
    // A bounds tree leaf holds triangles the capsule never reaches. Reject those
    // on their own extents before the plane and edge tests.
    if(Math.min(triangle.a.x,triangle.b.x,triangle.c.x)>_bounds.max.x||Math.max(triangle.a.x,triangle.b.x,triangle.c.x)<_bounds.min.x
     ||Math.min(triangle.a.y,triangle.b.y,triangle.c.y)>_bounds.max.y||Math.max(triangle.a.y,triangle.b.y,triangle.c.y)<_bounds.min.y
     ||Math.min(triangle.a.z,triangle.b.z,triangle.c.z)>_bounds.max.z||Math.max(triangle.a.z,triangle.b.z,triangle.c.z)<_bounds.min.z)return;
    const contact=capsuleTriangleContact(_capsule,triangle,upward);
    if(!contact)return;
    hit=true;_capsule.translate(contact.normal.multiplyScalar(contact.depth));
  };
  for(const collider of colliders){
    if(collider.triangles){for(const triangle of collider.triangles)push(triangle,false);continue;}
    collider.mesh?.geometry.boundsTree?.shapecast({
      intersectsBounds:box=>box.intersectsBox(_bounds),
      intersectsTriangle:triangle=>{push(triangle,collider.upward===true);return false;}
    });
  }
  if(!hit)return undefined;
  const displacement=_capsule.getCenter(_center).sub(capsule.getCenter(_start));
  return {normal:displacement.clone().normalize(),depth:displacement.length()};
}
/**
 * World-space triangles of a mesh, for colliders too small to earn a bounds
 * tree. A moving vehicle rewrites its own box every frame, so reuse the
 * triangles already there rather than allocating a new set each time.
 */
function worldTriangles(mesh:THREE.Mesh,triangles:THREE.Triangle[]){
  const position=mesh.geometry.getAttribute('position'),index=mesh.geometry.index;
  const count=(index?.count??position.count)/3;
  while(triangles.length<count)triangles.push(new THREE.Triangle());
  triangles.length=count;
  for(let i=0;i<count;i++){
    const triangle=triangles[i];
    for(const [j,vertex] of ([triangle.a,triangle.b,triangle.c] as const).entries())
      vertex.fromBufferAttribute(position,index?index.getX(i*3+j):i*3+j).applyMatrix4(mesh.matrixWorld);
  }
  return triangles;
}

export class Terrain {
  mesh:THREE.Mesh;readonly bottom:number;
  readonly solids?:THREE.Mesh;
  private ray=new THREE.Raycaster();
  private origin=new THREE.Vector3();
  private fences:LevelData['fences'];
  private grid=new Map<string,number[]>();
  private dynamic=new Map<string,DynamicSolid>();private dynamicGrid=new Map<string,DynamicSolid[]>();
  private platforms=new Map<string,{mesh:THREE.Mesh;triangles:THREE.Triangle[];position:THREE.Vector3;delta:THREE.Vector3;bounds:THREE.Box3}>();
  onVehicleImpact?:(id:string,speed:number,point:THREE.Vector3)=>boolean;
  constructor(geometries:THREE.BufferGeometry[],data:LevelData,staticBodies?:THREE.BufferGeometry,private terrainTypes?:number[]) {
    const geometry=mergeGeometries(geometries);
    if(!geometry)throw new Error('No terrain collision data was converted.');
    if(terrainTypes&&terrainTypes.length!==geometry.getAttribute('position').count/3)throw new Error('Terrain types do not match the collision triangles');
    geometry.computeBoundsTree();geometry.computeBoundingBox();this.bottom=geometry.boundingBox!.min.y;
    this.mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));
    this.mesh.updateMatrixWorld();
    if(staticBodies){
      const solidGeometry=staticBodies.clone();solidGeometry.computeBoundsTree();
      this.solids=new THREE.Mesh(solidGeometry,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));this.solids.updateMatrixWorld();
    }
    this.ray.firstHitOnly=true;
    this.fences=data.fences;
    for(let i=0;i<this.fences.length;i++){
      const [a,b]=this.fences[i];
      for(let x=Math.floor(Math.min(a[0],b[0])/20);x<=Math.floor(Math.max(a[0],b[0])/20);x++)
        for(let z=Math.floor(Math.min(a[2],b[2])/20);z<=Math.floor(Math.max(a[2],b[2])/20);z++){
          const key=`${x},${z}`,bucket=this.grid.get(key)??[];bucket.push(i);this.grid.set(key,bucket);
        }
    }
  }
  ground(x:number,z:number,nearY:number,range=5):THREE.Intersection | undefined {
    this.origin.set(x,nearY+range,z);this.ray.set(this.origin,down);this.ray.far=range+20;
    return this.ray.intersectObject(this.mesh,false)[0];
  }
  surfaceKind(hit:THREE.Intersection){
    if(hit.object!==this.mesh||hit.faceIndex===undefined||hit.faceIndex===null)return 0;
    const vertex=this.mesh.geometry.index?.getX(hit.faceIndex*3)??hit.faceIndex*3;
    return this.terrainTypes?.[Math.floor(vertex/3)]??0;
  }
  addSolid(id:string,geometry:THREE.BufferGeometry){
    geometry.computeBoundsTree();geometry.computeBoundingBox();const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));mesh.updateMatrixWorld();
    const body:DynamicSolid={id,mesh,bounds:geometry.boundingBox!.clone(),active:true};this.dynamic.set(id,body);
    for(let x=Math.floor(body.bounds.min.x/20);x<=Math.floor(body.bounds.max.x/20);x++)for(let z=Math.floor(body.bounds.min.z/20);z<=Math.floor(body.bounds.max.z/20);z++){
      const key=`${x},${z}`,bucket=this.dynamicGrid.get(key)??[];bucket.push(body);this.dynamicGrid.set(key,bucket);
    }
    return body;
  }
  nearbySolids(point:THREE.Vector3,radius=3){
    const found=new Set<DynamicSolid>();
    for(let x=Math.floor((point.x-radius)/20);x<=Math.floor((point.x+radius)/20);x++)for(let z=Math.floor((point.z-radius)/20);z<=Math.floor((point.z+radius)/20);z++)for(const body of this.dynamicGrid.get(`${x},${z}`)??[])if(body.active)found.add(body);
    return [...found];
  }
  setVehiclePlatforms(vehicles:VehiclePlatform[]){
    const active=new Set(vehicles.map(v=>v.id));
    for(const [id,p] of this.platforms)if(!active.has(id)){p.mesh.geometry.dispose();(p.mesh.material as THREE.Material).dispose();this.platforms.delete(id);}
    for(const vehicle of vehicles){
      let platform=this.platforms.get(vehicle.id);
      if(!platform){platform={mesh:new THREE.Mesh(new THREE.BoxGeometry(vehicle.half.x*2,vehicle.half.y*2,vehicle.half.z*2),new THREE.MeshBasicMaterial()),triangles:[],position:vehicle.position.clone(),delta:new THREE.Vector3(),bounds:new THREE.Box3()};this.platforms.set(vehicle.id,platform);}
      platform.delta.copy(vehicle.position).sub(platform.position);platform.position.copy(vehicle.position);
      const previous=platform.mesh.matrixWorld.clone();platform.mesh.quaternion.copy(vehicle.orientation??new THREE.Quaternion().setFromAxisAngle(up,vehicle.heading));platform.mesh.position.copy(vehicle.center).applyQuaternion(platform.mesh.quaternion).add(vehicle.position);platform.mesh.updateMatrixWorld();
      if(!previous.equals(platform.mesh.matrixWorld)||platform.bounds.isEmpty()){worldTriangles(platform.mesh,platform.triangles);platform.bounds.setFromObject(platform.mesh);}
    }
  }
  carry(state:CarState){if(state.grounded&&state.supportVehicle){const platform=this.platforms.get(state.supportVehicle);if(platform)state.position.add(platform.delta);}}
  /** Query close below the feet/wheel, so a roof above the player cannot become its floor. */
  support(x:number,z:number,y:number,rise=.25,depth=4):THREE.Intersection|undefined{
    this.origin.set(x,y+rise,z);this.ray.set(this.origin,down);this.ray.far=rise+depth;
    let closest=this.ray.intersectObject(this.mesh,false)[0];
    for(const mesh of [this.solids,...this.nearbySolids(this.origin).map(b=>b.mesh)])if(mesh){const hit=this.ray.intersectObject(mesh,false)[0];if(hit&&(!closest||hit.distance<closest.distance))closest=hit;}
    return closest;
  }
  raycast(origin:THREE.Vector3,direction:THREE.Vector3,distance:number){
    this.ray.set(origin,direction);this.ray.far=distance;
    let closest=this.ray.intersectObject(this.mesh,false)[0];
    for(const mesh of [this.solids,...this.nearbySolids(origin.clone().addScaledVector(direction,distance/2),distance/2+2).map(b=>b.mesh)])if(mesh){const hit=this.ray.intersectObject(mesh,false)[0];if(hit&&(!closest||hit.distance<closest.distance))closest=hit;}
    return closest;
  }
  boxContact(center:THREE.Vector3,half:THREE.Vector3,orientation:THREE.Quaternion){
    const bounds=new THREE.Box3();
    for(const x of [-1,1])for(const y of [-1,1])for(const z of [-1,1])bounds.expandByPoint(new THREE.Vector3(x*half.x,y*half.y,z*half.z).applyQuaternion(orientation).add(center));
    let contact:(NonNullable<ReturnType<typeof boxTriangleContact>>&{id?:string})|undefined;
    for(const [mesh,id] of [[this.mesh,undefined],[this.solids,undefined],...this.nearbySolids(center,half.length()).map(body=>[body.mesh,body.id])] as [THREE.Mesh|undefined,string|undefined][])mesh?.geometry.boundsTree?.shapecast({
      intersectsBounds:box=>box.intersectsBox(bounds),
      intersectsTriangle:triangle=>{const hit=boxTriangleContact(center,half,orientation,triangle);if(hit&&(!contact||hit.depth>contact.depth))contact={...hit,id};return false;}
    });
    return contact;
  }
  resolve(state:CarState,previous:THREE.Vector3,dt:number,radius=1.2,collideMesh=false,gravity=18) {
    const bodyCollision=collideMesh&&!!this.solids;
    let impact=false;
    const candidates=new Set<number>();
    const gx=Math.floor(state.position.x/20),gz=Math.floor(state.position.z/20);
    for(let x=gx-1;x<=gx+1;x++)for(let z=gz-1;z<=gz+1;z++)this.grid.get(`${x},${z}`)?.forEach(n=>candidates.add(n));
    if(collideMesh&&!bodyCollision){
      const direction=state.position.clone().sub(previous);direction.y=0;const travel=direction.length();
      if(travel>0){this.ray.set(previous.clone().add(new THREE.Vector3(0,.8,0)),direction.normalize());this.ray.far=travel+radius;const wall=this.ray.intersectObject(this.mesh,false)[0];if(wall&&wall.face&&Math.abs(wall.face.normal.y)<.5){state.position.x=previous.x+direction.x*Math.max(0,wall.distance-radius);state.position.z=previous.z+direction.z*Math.max(0,wall.distance-radius);}}
    }
    // Native road fences constrain vehicles. Walking uses the actual solid
    // geometry, including finite-height walls that can be jumped over.
    for(const id of bodyCollision&&radius<1?[]:candidates){
      const [a,b]=this.fences[id];const dx=b[0]-a[0],dz=b[2]-a[2],len=dx*dx+dz*dz;
      if(len<0.001)continue;
      const t=THREE.MathUtils.clamp(((state.position.x-a[0])*dx+(state.position.z-a[2])*dz)/len,0,1);
      const x=a[0]+dx*t,z=a[2]+dz*t;let nx=state.position.x-x,nz=state.position.z-z;
      const distance=Math.hypot(nx,nz);
      // Exported fences are vertical world barriers; terrain handles height separately.
      if(distance<radius){
        if(distance<0.001){nx=previous.x-x;nz=previous.z-z;}
        const norm=Math.hypot(nx,nz)||1;
        // Correct penetration every step; bounce only while moving into the barrier.
        // Reversing an already separating car caused alternating forward/backward kicks.
        const approach=(state.position.x-previous.x)*nx/norm+(state.position.z-previous.z)*nz/norm;
        state.position.x=x+nx/norm*radius;state.position.z=z+nz/norm*radius;
        if(approach < -0.0001)impact=true;
      }
    }
    if(impact){if(radius>=1){state.damage=Math.min(100,state.damage+Math.abs(state.speed)*0.55);state.speed*=-0.25;}else state.speed=0;}
    if(bodyCollision)return this.resolveBody(state,previous,dt,radius,gravity)||impact;
    state.grounded=false;
    const ground=this.ground(state.position.x,state.position.z,previous.y,2.4);
    if(ground){
      const target=ground.point.y+0.06;
      if(state.position.y<target+0.2&&state.verticalSpeed<=0){state.position.y=target;state.verticalSpeed=0;state.grounded=true;}
      else {state.verticalSpeed-=gravity*dt;state.position.y=Math.max(target,state.position.y+state.verticalSpeed*dt);if(state.position.y===target){state.verticalSpeed=0;state.grounded=true;}}
    }else {state.verticalSpeed-=gravity*dt;state.position.y+=state.verticalSpeed*dt;}
    return impact;
  }
  private resolveBody(state:CarState,previous:THREE.Vector3,dt:number,radius:number,gravity:number){
    const clearance=.06,height=1.8;
    state.grounded=false;state.supportVehicle=undefined;state.verticalSpeed-=gravity*dt;
    const movement=state.position.clone().sub(previous);movement.y+=state.verticalSpeed*dt;
    // Bound each sweep so sprinting, jumping and long frames cannot cross a thin
    // native wall between overlap tests. Preserve tangential motion for sliding.
    const steps=Math.max(1,Math.ceil(movement.length()/(radius*.5)));
    movement.divideScalar(steps);
    const capsule=new Capsule(previous.clone().add(new THREE.Vector3(0,radius-clearance,0)),previous.clone().add(new THREE.Vector3(0,height-radius-clearance,0)),radius);
    // The world surfaces resolve as one group, so a floor and a wall meeting in
    // a corner both move the capsule before the deepest push-out is chosen.
    const reach=movement.length()*steps;
    const groups:[CapsuleCollider[],string|undefined][]=[
      [[{mesh:this.mesh,upward:true},{mesh:this.solids}],undefined],
      ...this.nearbySolids(previous,reach+radius+1).map(b=>[[{mesh:b.mesh}],undefined] as [CapsuleCollider[],undefined]),
      ...[...this.platforms.entries()].filter(([,p])=>p.bounds.distanceToPoint(previous)<reach+height+radius).map(([id,p])=>[[{triangles:p.triangles}],id] as [CapsuleCollider[],string]),
    ];
    let impact=false;
    for(let step=0;step<steps;step++){
      capsule.translate(movement);
      for(let iteration=0;iteration<4;iteration++){
        let hit:ReturnType<typeof capsulePushOut>,support:string|undefined;
        for(const [group,id] of groups){const next=capsulePushOut(capsule,group);if(next&&(!hit||next.depth>hit.depth)){hit=next;support=id;}}
        if(!hit||hit.depth<1e-7)break;
        capsule.translate(hit.normal.clone().multiplyScalar(hit.depth+1e-6));
        if(Math.abs(hit.normal.y)<.5)impact=true;
        if((hit.normal.y>.5&&state.verticalSpeed<0)||(hit.normal.y<-.5&&state.verticalSpeed>0)){
          if(hit.normal.y>.5){state.grounded=true;state.supportVehicle=support;}
          state.verticalSpeed=0;movement.y=0;
        }
      }
    }
    state.position.copy(capsule.start).add(new THREE.Vector3(0,clearance-radius,0));
    return impact;
  }
  normal(x:number,z:number,y:number){
    const hit=this.ground(x,z,y,2.4);
    if(!hit?.face)return up;
    return hit.face.normal.y<0?hit.face.normal.clone().negate():hit.face.normal;
  }
  dispose(){this.setVehiclePlatforms([]);for(const mesh of [this.mesh,this.solids,...[...this.dynamic.values()].map(b=>b.mesh)])if(mesh){mesh.geometry.disposeBoundsTree();mesh.geometry.dispose();(mesh.material as THREE.Material).dispose();}this.dynamic.clear();this.dynamicGrid.clear();}
}
