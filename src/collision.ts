import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Capsule } from 'three/addons/math/Capsule.js';

type Vec3 = [number, number, number];
export type StaticShape = { name: string; center: Vec3;transform?:number[] } & (
  { kind: 'box'; halfExtents: Vec3; axes: [Vec3, Vec3, Vec3] } |
  { kind: 'cylinder'; radius: number; length: number; flatEnds: boolean; axis: Vec3 } |
  { kind: 'sphere'; radius: number }
);
export interface InteriorCollision { version: number; source: string; sha256: string; shapes: StaticShape[] }

/** Native static volumes use world coordinates, already reflected by the exporter. */
export function staticCollisionGeometry(data: InteriorCollision): THREE.BufferGeometry {
  const parts = data.shapes.map(shape => {
    let geometry: THREE.BufferGeometry;
    if (shape.kind === 'box') {
      geometry = new THREE.BoxGeometry(...shape.halfExtents.map(n => n * 2) as Vec3);
      const x = new THREE.Vector3(...shape.axes[0]).normalize();
      const y = new THREE.Vector3(...shape.axes[1]).normalize();
      // A reflected basis has negative determinant. A box is symmetric about its
      // axes, so choosing a right-handed third axis preserves its shape and winding.
      const z = new THREE.Vector3().crossVectors(x, y).normalize();
      geometry.applyMatrix4(new THREE.Matrix4().makeBasis(x, y, z));
    } else if (shape.kind === 'cylinder') {
      // PAL native constructor 0x002ce390 bounds rounded cylinders by length +
      // radius, and flat cylinders by sqrt(length² + radius²): length is half-span.
      geometry = shape.flatEnds
        ? new THREE.CylinderGeometry(shape.radius, shape.radius, shape.length * 2, 12)
        : new THREE.CapsuleGeometry(shape.radius, shape.length * 2, 4, 12);
      geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...shape.axis).normalize()));
    } else {
      geometry = new THREE.SphereGeometry(shape.radius, 12, 8);
    }
    geometry.translate(...shape.center);
    if(shape.transform)geometry.applyMatrix4(new THREE.Matrix4().fromArray(shape.transform));
    const triangles = geometry.toNonIndexed();
    geometry.dispose();
    triangles.deleteAttribute('normal');triangles.deleteAttribute('uv');
    return triangles;
  });
  const result = mergeGeometries(parts);
  parts.forEach(part => part.dispose());
  if (!result) throw new Error(`No static collision shapes in ${data.source}`);
  return result;
}

const _plane=new THREE.Plane(),_triangle=new THREE.Triangle(),_cross=new THREE.Vector3(),_edge=new THREE.Vector3();
const _line1=new THREE.Line3(),_line2=new THREE.Line3(),_near1=new THREE.Vector3(),_near2=new THREE.Vector3();
const _r=new THREE.Vector3(),_s=new THREE.Vector3(),_w=new THREE.Vector3();
const EDGES:[0|1|2,0|1|2][]=[[0,1],[1,2],[2,0]];
/** Closest points on two segments, clamped to their ends. */
function segmentClosestPoints(line1:THREE.Line3,line2:THREE.Line3,target1:THREE.Vector3,target2:THREE.Vector3){
  const r=_r.copy(line1.end).sub(line1.start),s=_s.copy(line2.end).sub(line2.start),w=_w.copy(line2.start).sub(line1.start);
  const a=r.dot(s),b=r.dot(r),c=s.dot(s),d=s.dot(w),e=r.dot(w),divisor=b*c-a*a;
  let t1:number,t2:number;
  if(Math.abs(divisor)<1e-10){
    const first=-d/c,second=(a-d)/c;
    if(Math.abs(first-0.5)<Math.abs(second-0.5)){t1=0;t2=first;}else{t1=1;t2=second;}
  }else{t1=(d*a+e*c)/divisor;t2=(t1*a-d)/c;}
  t1=THREE.MathUtils.clamp(t1,0,1);t2=THREE.MathUtils.clamp(t2,0,1);
  target1.copy(r).multiplyScalar(t1).add(line1.start);target2.copy(s).multiplyScalar(t2).add(line2.start);
}
/**
 * Push-out of a walking capsule from one world triangle.
 *
 * Converted intersect surfaces are exported double-sided, so their winding does
 * not say which way is up. Pass `upward` for those: a downward-facing triangle
 * is flipped, and the capsule rides on top of it instead of being pushed
 * through the floor. Static solids face outward already and must not flip.
 */
export function capsuleTriangleContact(capsule:Capsule,triangle:THREE.Triangle,upward=false){
  // Twice the triangle area, and its sign on Y, without the square root.
  _cross.subVectors(triangle.c,triangle.b).cross(_edge.subVectors(triangle.a,triangle.b));
  if(_cross.lengthSq()<4e-16)return undefined;
  const points=upward&&_cross.y<0?[triangle.c,triangle.b,triangle.a]:[triangle.a,triangle.b,triangle.c];
  _triangle.set(points[0],points[1],points[2]);
  _triangle.getPlane(_plane);
  const start=_plane.distanceToPoint(capsule.start)-capsule.radius,end=_plane.distanceToPoint(capsule.end)-capsule.radius;
  if((start>0&&end>0)||(start<-capsule.radius&&end<-capsule.radius))return undefined;
  const along=Math.abs(start/(Math.abs(start)+Math.abs(end)));
  if(_triangle.containsPoint(_near1.copy(capsule.start).lerp(capsule.end,along)))
    return {normal:_plane.normal.clone(),depth:Math.abs(Math.min(start,end))};
  const reach=capsule.radius*capsule.radius;
  _line1.set(capsule.start,capsule.end);
  for(const [from,to] of EDGES){
    _line2.set(points[from],points[to]);
    segmentClosestPoints(_line1,_line2,_near1,_near2);
    const gap=_near1.distanceToSquared(_near2);
    if(gap<reach)return {normal:_near1.clone().sub(_near2).normalize(),depth:capsule.radius-Math.sqrt(gap)};
  }
  return undefined;
}
