import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import type { RoadNavigation } from './road-data';
import type { CharacterData } from './character';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export interface Place { name: string; position: [number, number, number] }
export interface LevelData { id: number; scenes: string[]; locations: Place[]; locators: (Place & { kind: number })[]; roads: number[][][]; fences: number[][][];navigation?:RoadNavigation }
export interface Catalog { carNames?:Record<string,string>;levels: number[]; cars: string[]; textures: Record<string,string>; stats: Record<string,number> }
export interface SceneryMaterial {albedo:string;kind:string;detail:string;roughness:number;metalness:number;bump:number;scale:number}
interface MaterialData {scenery?:SceneryMaterial; texture: string; textureUrl?: string; alpha: boolean; blend: number; lit: boolean; translucent: boolean }
interface Primitive { shader: string; attributes: Record<string,[number,number]> }
interface AssetData { collision: [number,number] | null; objects: { name: string; mesh: string; matrix: number[];interactiveId?:string;movable?:boolean }[]; meshes: Record<string,Primitive[]>; materials: Record<string,MaterialData> }

export const assetURL=(path:string)=>`${import.meta.env?.BASE_URL??'/'}assets/${path}`;
const textureLoader=new THREE.TextureLoader();
/** Load a converted texture, preferring its smaller WebP twin and falling back to the PNG. */
export async function loadTexture(url:string){
  const webp=url.replace(/\.png$/,'.webp');
  if(webp!==url)try{return await textureLoader.loadAsync(assetURL(webp));}catch{/* fall through */}
  return textureLoader.loadAsync(assetURL(url));
}
export async function json<T>(file: string): Promise<T> {
  const response = await fetch(assetURL(file));
  if (!response.ok) throw new Error(`Could not load ${file} (${response.status})`);
  return response.json();
}

export class Assets {
  textures = new Map<string,THREE.Texture>();
  materials = new Map<string,THREE.Material>();
  geometries = new Set<THREE.BufferGeometry>();
  private pendingTextures=new Map<string,Promise<THREE.Texture>>();
  private pendingCharacters=new Map<string,Promise<{data:CharacterData;binary:ArrayBuffer}>>();
  surfaceOverrides:Record<string,string>={};
  sceneryMaterials:Record<string,SceneryMaterial>={};sceneryScenes=new Set<string>();
  constructor(public catalog: Catalog) {}

  /** Fetch a texture once, even when several regions request it before the first download finishes. */
  async texture(url:string,configure:(texture:THREE.Texture)=>void,key=url){
    const cached=this.textures.get(key);if(cached)return cached;
    let pending=this.pendingTextures.get(key);
    if(!pending){pending=(async()=>{const texture=await loadTexture(url);configure(texture);this.textures.set(key,texture);return texture;})();this.pendingTextures.set(key,pending);}
    return pending;
  }

  /**
   * Fetch a character's skeleton, geometry and animations once.
   *
   * A crowd repeats the same few models, and a caller that wants several can
   * start them all before awaiting any, so the downloads overlap instead of
   * queueing one behind the next.
   */
  character(asset:string){
    let pending=this.pendingCharacters.get(asset);
    if(!pending){
      pending=(async()=>{
        const [data,response]=await Promise.all([json<CharacterData>(`${asset}.json`),fetch(assetURL(`${asset}.bin`))]);
        if(!response.ok)throw new Error(`Missing character geometry: ${asset}`);
        return {data,binary:await response.arrayBuffer()};
      })();
      this.pendingCharacters.set(asset,pending);
    }
    return pending;
  }

  async load(name: string, vehicle = false) {
    if(vehicle){
      const gltf=await new GLTFLoader().loadAsync(assetURL(`remaster/${name}.glb`)).catch(error=>{throw new Error(`Could not load converted vehicle ${name}: ${error.message}`,{cause:error});});
      const root=(gltf.scene.children[0]??gltf.scene) as THREE.Group;
      root.traverse(object=>{
        if(object.userData.p3dName)object.name=object.userData.p3dName;
        if(object instanceof THREE.Mesh){
          this.geometries.add(object.geometry);
          for(const mat of Array.isArray(object.material)?object.material:[object.material]){
            this.materials.set(mat.uuid,mat);
            for(const value of Object.values(mat))if(value instanceof THREE.Texture){this.textures.set(value.uuid,value);value.anisotropy=16;}
          }
        }
      });
      return {root,collision:null};
    }
    const path=this.sceneryScenes.has(name)?`remaster/scenes/${name}`:name;
    const [meta, response] = await Promise.all([json<AssetData>(`${path}.json`), fetch(assetURL(`${path}.bin`))]);
    if (!response.ok) throw new Error(`Missing geometry: ${name}`);
    const binary = await response.arrayBuffer();
    for(const mat of Object.values(meta.materials)){const url=mat.textureUrl??this.catalog.textures[mat.texture];if(this.sceneryMaterials[url]){mat.scenery=this.sceneryMaterials[url];mat.textureUrl=mat.scenery.albedo;}else if(this.surfaceOverrides[url])mat.textureUrl=this.surfaceOverrides[url];}
    const textures = [...new Set(Object.values(meta.materials).map(m => m.textureUrl ?? this.catalog.textures[m.texture]).filter(Boolean))];
    const details=[...new Set(Object.values(meta.materials).map(m=>m.scenery?.detail).filter((p):p is string=>!!p))];
    const detailMaps=new Map<string,THREE.Texture>();
    // Albedo and detail maps download together; regions loading at the same time share one request per texture.
    await Promise.all([
      ...textures.map(url=>this.texture(url,texture=>{
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.anisotropy = 16;
        // The converted Pure3D UVs already address image rows from the top.
        texture.flipY = false;
      })),
      ...details.map(async url=>{detailMaps.set(url,await this.texture(url,texture=>{texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.repeat.set(6,6);texture.anisotropy=4;},`detail:${url}`));}),
    ]);
    const material = (shader: string) => {
      const source = meta.materials[shader];
      const url = source?.textureUrl ?? this.catalog.textures[source?.texture];
      const key = JSON.stringify([source,url,vehicle]);
      if (!this.materials.has(key)) {
        const map=this.textures.get(url);
        const options = {...(map?{map}:{}), vertexColors:!vehicle, side:THREE.DoubleSide,
          alphaTest: source?.alpha || !vehicle && source?.translucent ? 0.4 : 0,
          transparent: vehicle && source?.blend === 1, color:0xffffff};
        this.materials.set(key,vehicle
          ? new THREE.MeshPhysicalMaterial({...options,roughness:source?.blend===1?0.16:0.42,metalness:0.12,clearcoat:0.65,clearcoatRoughness:0.24,envMapIntensity:0.55})
          : new THREE.MeshStandardMaterial({...options,roughness:source?.scenery?.roughness??0.94,metalness:source?.scenery?.metalness??0,envMapIntensity:0.2,...(source?.scenery?.bump?{bumpMap:detailMaps.get(source.scenery.detail),bumpScale:source.scenery.bump}: {})}));
      }
      const mat=this.materials.get(key)!;mat.name=shader;return mat;
    };
    const groups = new Map<string, {geometry: THREE.BufferGeometry; material: THREE.Material; shader: string}[]>();
    for (const [name,primitives] of Object.entries(meta.meshes)) {
      groups.set(name,primitives.map(part => {
        const geometry = new THREE.BufferGeometry();
        for (const [key,[offset,length]] of Object.entries(part.attributes)) {
          if (key === 'indices') geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(binary,offset,length),1));
          else geometry.setAttribute(key,new THREE.BufferAttribute(new Float32Array(binary,offset,length),key==='uv'?2:3));
        }
        if (vehicle && !geometry.getAttribute('normal')) geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
        this.geometries.add(geometry);
        return {geometry,material:material(part.shader),shader:part.shader};
      }));
    }
    const root = new THREE.Group(); root.name = name;
    // Batch static geometry by material inside each streaming region.
    const batches = new Map<THREE.Material,THREE.BufferGeometry[]>();
    const interactive=new Map<string,THREE.Group>();
    for (const object of meta.objects) {
      const matrix = new THREE.Matrix4().fromArray(object.matrix);
      const group = new THREE.Group();group.name=object.name;
      const individual=vehicle||object.movable||/^powerbox\d+$/i.test(object.name);
      for (const part of groups.get(object.mesh) ?? []) {
        if (individual) {
          const mesh = new THREE.Mesh(part.geometry,part.material);
          mesh.castShadow=true;mesh.receiveShadow=true;
          group.add(mesh);
        } else {
          const geometry = part.geometry.clone().applyMatrix4(matrix);
          if(!geometry.getAttribute('normal'))geometry.computeVertexNormals();
          const batch=batches.get(part.material) ?? [];batch.push(geometry);batches.set(part.material,batch);
        }
      }
      if (individual) {group.applyMatrix4(matrix);
        if(object.movable){let owner=interactive.get(object.interactiveId!);if(!owner){owner=new THREE.Group();owner.name=object.interactiveId!;interactive.set(owner.name,owner);root.add(owner);}owner.add(group);}
        else root.add(group);
      }
    }
    for (const [mat,geometries] of batches) {
      const merged=mergeGeometries(geometries);
      geometries.forEach(g=>g.dispose());
      if (merged) {if(!merged.getAttribute('normal'))merged.computeVertexNormals();this.geometries.add(merged);const mesh=new THREE.Mesh(merged,mat);mesh.castShadow=true;mesh.receiveShadow=true;root.add(mesh);}
    }
    let collision: THREE.BufferGeometry | null = null;
    if (meta.collision) {
      collision = new THREE.BufferGeometry();
      collision.setAttribute('position',new THREE.BufferAttribute(new Float32Array(binary,...meta.collision),3));
      this.geometries.add(collision);
    }
    return {root,collision};
  }

  dispose() {
    this.geometries.forEach(g=>{g.disposeBoundsTree();g.dispose();});
    this.materials.forEach(m=>m.dispose());this.textures.forEach(t=>t.dispose());
    this.geometries.clear();this.materials.clear();this.textures.clear();this.pendingCharacters.clear();
  }
}
