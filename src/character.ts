import * as THREE from 'three';
import { type Assets } from './assets';
export interface CharacterData {placement?:number[];bones:{name:string;parent:number;matrix:number[]}[];primitives:{shader:string;attributes:Record<string,[number,number]>}[];materials:Record<string,{textureUrl:string}>;animations:{name:string;duration:number;tracks:{bone:string;kind:string;times:number[];values:number[]}[]}[]}
export class Character {
  group=new THREE.Group();private mixer=new THREE.AnimationMixer(this.group);private actions=new Map<string,THREE.AnimationAction>();private active='';
  private bones:THREE.Bone[]=[];private skeleton!:THREE.Skeleton;
  private meshes:THREE.SkinnedMesh[]=[];
  async load(assets:Assets,asset="homer"){
    const {data,binary}=await assets.character(asset);
    this.bones=data.bones.map(source=>{const bone=new THREE.Bone();bone.name=source.name;bone.applyMatrix4(new THREE.Matrix4().fromArray(source.matrix));return bone;});
    data.bones.forEach((source,i)=>{if(i===0)this.group.add(this.bones[i]);else this.bones[source.parent].add(this.bones[i]);});
    this.group.updateMatrixWorld(true);this.skeleton=new THREE.Skeleton(this.bones);
    for(const primitive of data.primitives){
      const source=data.materials[primitive.shader];if(!source?.textureUrl)throw new Error(`Missing character texture: ${asset}/${primitive.shader}`);
      const textureKey=`character:${source.textureUrl}`;let texture=assets.textures.get(textureKey);
      if(!texture){texture=await assets.texture(source.textureUrl,t=>{t.colorSpace=THREE.SRGBColorSpace;t.flipY=true;t.wrapS=t.wrapT=THREE.RepeatWrapping;},textureKey);}
      const geometry=new THREE.BufferGeometry();
      for(const [name,[offset,length]] of Object.entries(primitive.attributes)){
        if(name==='indices')geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(binary,offset,length),1));
        else geometry.setAttribute(name,new THREE.BufferAttribute(new Float32Array(binary,offset,length),name==='uv'?2:name.startsWith('skin')?4:3));
      }
      const material=new THREE.MeshLambertMaterial({map:texture,side:THREE.DoubleSide});assets.materials.set(`${asset}-${primitive.shader}-${material.uuid}`,material);assets.geometries.add(geometry);
      const mesh=new THREE.SkinnedMesh(geometry,material);mesh.name=`homer-${primitive.shader}`;mesh.frustumCulled=false;mesh.castShadow=true;mesh.receiveShadow=true;
      this.group.add(mesh);mesh.bind(this.skeleton);mesh.normalizeSkinWeights();this.meshes.push(mesh);
    }
    for(const source of data.animations){
      const tracks=source.tracks.map(track=>track.kind==='quaternion'?new THREE.QuaternionKeyframeTrack(`${track.bone}.quaternion`,track.times,track.values):new THREE.VectorKeyframeTrack(`${track.bone}.position`,track.times,track.values));
      const clip=new THREE.AnimationClip(source.name,source.duration,tracks);const action=this.mixer.clipAction(clip);this.actions.set(source.name,action);if(asset!=='menu-homer')this.actions.set(source.name.replace(/^[^_]+_/,'hom_'),action);
    }
    if(data.placement)this.group.applyMatrix4(new THREE.Matrix4().fromArray(data.placement));
    this.play(asset==='menu-homer'?'PTRN_Motion_Root':'hom_loco_idle_rest');
  }
  duration(name:string){return this.actions.get(name)?.getClip().duration??0;}
  play(name:string,once=false){
    if(name===this.active)return;
    this.actions.get(this.active)?.fadeOut(.15);const next=this.actions.get(name);if(next){next.setLoop(once?THREE.LoopOnce:THREE.LoopRepeat,once?1:Infinity);next.clampWhenFinished=once;next.reset().fadeIn(.15).play();}this.active=name;
  }
  drive(car:THREE.Group){
    car.add(this.group);this.group.position.set(-0.48,-0.32,-0.15);this.group.rotation.set(0,Math.PI,0);this.group.scale.setScalar(1);
    this.play('hom_in_car_idle');
  }
  walk(scene:THREE.Scene,position:THREE.Vector3,heading:number){scene.add(this.group);this.group.position.copy(position);this.group.rotation.set(0,heading,0);this.play('hom_loco_idle_rest');}
  update(dt:number){this.mixer.update(dt);}
  dispose(){this.mixer.stopAllAction();this.mixer.uncacheRoot(this.group);this.group.removeFromParent();this.skeleton?.dispose();}
}
