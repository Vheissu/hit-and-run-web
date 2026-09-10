import * as THREE from 'three';
import { json } from '../assets';
import { Character } from '../character';
import type { CarState } from '../physics';
import type { World } from '../world';
import { Motion } from '../motion';
import type { Offense } from '../hit-and-run';
import { vehicleContact,type VehicleFootprint } from '../vehicle-collision';
import { renderVehicleWheels,simulateVehicle,vehicleProfile,resetVehicle,collideVehicles,type VehicleProfile } from '../vehicle-physics';
import { SteeringDriver,AI_RULES } from '../steering';
import { CampaignEngine } from './engine';
import { RoadNetwork,MissionRoute } from './roads';
import { Presentation,type VoiceClip } from './presentation';
import {all,arg,key,distance,type Chapter,type Command,type Effect,type EntityState,type Progress,type Reward,type Snapshot,type Vec3} from './types';
export interface CampaignAssets {names:Record<string,string>;characters:Record<string,string>;cars:Record<string,string>;props:Record<string,string>;dialogue:Record<string,VoiceClip[]>;tuning:Record<string,Record<string,number>>;missionTuning:Record<string,Record<string,number>>;presentations:Record<string,string>}
export interface Player {state:CarState;onFoot:boolean;vehicle:string;parkedPosition:THREE.Vector3;parkedHeading:number;footprint?:VehicleFootprint}
export interface CampaignCallbacks {player:()=>Player;place:(position:Vec3,heading:number,onFoot:boolean,parked?:Vec3)=>void;vehicle:(id:string)=>Promise<void>;skin:(id:string)=>Promise<void>;chapter:(id:number,progress:Progress)=>Promise<void>;toast:(message:string)=>void;traffic:(limit:number)=>void;save:()=>void;law?:{reset:()=>void;command:(command:Command)=>boolean;offense:(type:Offense,interior?:boolean)=>boolean}}
export interface CampaignHUD {title:string;message:string;remaining:number|null;countdown:number;target?:Vec3;items:number;collected:number;failure:string;targetHealth?:number;hint:string}
interface NPC {id:string;actor:Character;position:THREE.Vector3;heading:number;ambient:boolean;interior:string|null;waypoints:THREE.Vector3[];waypoint:number;motion:Motion;seller?:string;bonus?:string;reaction?:{phase:'flail'|'getup';remaining:number;velocity:THREE.Vector3;body:CarState}}
interface Vehicle extends CarState {id:string;mesh:THREE.Group;motion:Motion;offset:number;footprint:VehicleFootprint;profile:VehicleProfile;driver:SteeringDriver;tuning:Record<string,number>;cruiseSpeed:number;health:number;mode:string;waypoints:THREE.Vector3[];waypoint:number;path:THREE.Vector3[];pathIndex:number;route?:MissionRoute;finished:boolean;hitCooldown:number;repath:number}
export class Campaign {
  readonly engine:CampaignEngine;readonly presentation=new Presentation();interior:string|null=null;error='';
  private npcs=new Map<string,NPC>();private vehicles=new Map<string,Vehicle>();private models=new Map<string,THREE.Group>();private items=new Map<number,THREE.Group>();private itemsRoot=new THREE.Group();private target=new THREE.Group();private road:RoadNetwork;
  private destructibles=new Map<number,THREE.Object3D[]>();private beam:THREE.Mesh|undefined;private cargoModel:THREE.Group|undefined;
  private busy=false;private disposed=false;private action=false;private kicked=false;private missionKey='';private phaseKey='';private time=0;private returnPosition:Vec3|null=null;private bossCharge=0;private bossHit=false;private stateProp:THREE.Group|undefined;private boss:THREE.Group|undefined;private retryKey='';
  private constructor(public world:World,public data:Chapter,public assets:CampaignAssets,public progress:Progress,private callbacks:CampaignCallbacks,rewards:Reward[]){
    this.engine=new CampaignEngine(data,progress,rewards);this.road=new RoadNetwork(world.data.roads,world.data.navigation);world.scene.add(this.itemsRoot,this.target);
    const ring=new THREE.Mesh(new THREE.TorusGeometry(2.3,.10,8,48),new THREE.MeshBasicMaterial({color:0xffd900,depthTest:true}));ring.rotation.x=-Math.PI/2;this.target.add(ring);
    const arrow=new THREE.Mesh(new THREE.ConeGeometry(.6,1.2,4),new THREE.MeshBasicMaterial({color:0xffd900}));arrow.rotation.z=Math.PI;arrow.position.y=4;this.target.add(arrow);
  }
  static async create(world:World,level:number,progress:Progress,callbacks:CampaignCallbacks){
    const [data,assets,rewards]=await Promise.all([json<Chapter>(`campaign/level${level}.json`),json<CampaignAssets>('campaign/assets.json'),json<Reward[]>('campaign/rewards.json')]);
    const campaign=new Campaign(world,data,assets,progress,callbacks,rewards);
    // The loop below has to stay in order: a waypoint command needs the
    // character it belongs to. Start every download first so the loop waits
    // once for the whole crowd rather than once per character.
    const crowd=new Set<string>();
    for(const c of data.initial){
      const id=c.op==='AddPurchaseCarReward'?key(c.args[1]):['AddAmbientCharacter','AddNPCCharacterBonusMission'].includes(c.op)?key(c.args[0]):null;
      const model=id===null?undefined:assets.characters[id];
      if(model)crowd.add(model);
    }
    for(const model of crowd)void world.assets.character(model).catch(()=>{/* the loop below reports it */});
    for(const c of data.initial){
      if(c.op==='AddAmbientCharacter')await campaign.npc(key(c.args[0]),c.args[1],true);
      if(c.op==='AddNPCCharacterBonusMission'){const npc=await campaign.npc(key(c.args[0]),c.args[2],true,'bonus:'+key(c.args[3]));npc.bonus=key(c.args[3]);}
      if(c.op==='AddAmbientNPCWaypoint'){const npc=campaign.npcs.get(key(c.args[0]));if(npc)npc.waypoints.push(new THREE.Vector3(...campaign.locator(c.args[1]).position));}
      if(c.op==='AddPurchaseCarReward'){const npc=await campaign.npc(key(c.args[1]),c.args[3],true);npc.seller=key(c.args[0]);}
    }
    return campaign;
  }
  get frozen(){return this.busy||this.presentation.active||this.engine.countdown>0||this.engine.status==='failed'||!!this.error;}
  get active(){return this.engine.status!=='idle';}
  get trafficObstacles(){return [...this.vehicles.values()].map(v=>v.position).concat([...this.npcs.values()].filter(n=>n.interior===null).map(n=>n.position));}
  get vehicleBodies(){return [...this.vehicles.values()];}
  get hud():CampaignHUD{
    const snapshot=this.snapshot(),target=this.navigationTarget(snapshot);
    return {title:this.engine.mission?.title??'',message:this.error||this.engine.stage?.message||'',remaining:this.engine.remaining,countdown:this.engine.countdown,target,items:this.engine.stage?this.engine.items.length:0,collected:this.engine.collected.size,failure:this.error||this.engine.failure,targetHealth:this.engine.objective==='destroy'?this.engine.targetEntity(snapshot)?.health:undefined,hint:this.hint()};
  }
  private navigationTarget(snapshot:Snapshot){
    if(!this.engine.stage)return undefined;const point=this.engine.navTarget(snapshot);if(!point)return undefined;
    const room=this.roomAt(new THREE.Vector3(...point));
    if(this.interior&&room!==this.interior)return this.data.interiors.find(i=>i.name===this.interior)?.exit?.position??point;
    if(!this.interior&&room)return Object.values(this.data.locators).find(l=>key(l.interior)===key(room))?.position??point;
    return point;
  }
  get conversationCamera(){
    if(!this.presentation.active||this.engine.objective!=='dialogue'||this.presentation.briefing)return undefined;
    const info=arg(this.engine.stage.commands,'SetDialogueInfo'),npc=this.npcs.get(key(info[1]));if(!npc)return undefined;
    const player=this.callbacks.player().state.position,choice=all(this.engine.stage.commands,'SetConversationCam').find(a=>Number(a[0])===this.presentation.line-1)?.[1]??'npc_far';
    const focusNpc=String(choice).startsWith('npc'),focus=(focusNpc?npc.position:player).clone(),other=focusNpc?player:npc.position;
    const direction=other.clone().sub(focus);direction.y=0;direction.normalize();const side=new THREE.Vector3(direction.z,0,-direction.x),near=String(choice).includes('near');
    return {position:focus.clone().addScaledVector(direction,near?2:3.2).addScaledVector(side,.75).add(new THREE.Vector3(0,1.65,0)),look:focus.clone().add(new THREE.Vector3(0,1.45,0))};
  }
  get playerAnimation(){
    if(this.engine.objective!=='dialogue'||!this.presentation.active)return undefined;const animations=all(this.engine.stage.commands,'AddAmbientPcAnimation'),name=key(animations[(this.presentation.line-1)%Math.max(1,animations.length)]?.[0]);return name&&name!=='none'?'hom_'+name:'hom_loco_idle_rest';
  }
  private locator(name:unknown){const value=this.data.locators[key(name)];if(!value)throw new Error(`Missing mission locator: ${String(name)}`);return value;}
  private roomAt(position:THREE.Vector3){return this.data.interiors.find(i=>i.start&&position.distanceTo(new THREE.Vector3(...i.start.position))<35&&position.y<-10)?.name??null;}
  private async npc(id:string,location:unknown,ambient=false,instance=id){
    const loc=this.locator(location);let npc=this.npcs.get(instance);
    if(!npc){const actor=new Character(),asset=this.assets.characters[id];if(!asset)throw new Error(`Missing NPC model: ${id}`);await actor.load(this.world.assets,asset);this.world.scene.add(actor.group);npc={id,actor,position:new THREE.Vector3(),heading:0,ambient,interior:null,waypoints:[],waypoint:0,motion:new Motion()};this.npcs.set(instance,npc);}
    npc.position.fromArray(loc.position);npc.heading=loc.heading??npc.heading;npc.interior=this.roomAt(npc.position);npc.ambient||=ambient;npc.reaction=undefined;npc.motion.reset(npc);npc.actor.group.position.copy(npc.position);npc.actor.group.rotation.y=npc.heading;return npc;
  }
  private async model(id:string){
    if(!this.models.has(id)){const result=await this.world.assets.load(id,id.startsWith('car-'));this.models.set(id,result.root);}
    return this.models.get(id)!.clone(true);
  }
  private async vehicle(id:string,location:unknown,mode='NULL',tuning=''){
    let car=this.vehicles.get(id);const loc=this.locator(location);
    if(!car){const name=this.assets.cars[id];if(!name)throw new Error(`Missing mission vehicle ${id}`);const mesh=await this.model(name),box=new THREE.Box3().setFromObject(mesh),size=box.getSize(new THREE.Vector3()),profile=vehicleProfile(mesh);this.world.scene.add(mesh);car={id,mesh,position:new THREE.Vector3(),heading:0,motion:new Motion(),offset:-box.min.y+.04,footprint:{halfWidth:size.x/2,halfLength:size.z/2},profile,driver:new SteeringDriver(),tuning:{},cruiseSpeed:13,health:1,speed:0,verticalSpeed:0,steer:0,distance:0,damage:0,mode:'null',waypoints:[],waypoint:0,path:[],pathIndex:0,finished:false,hitCooldown:0,repath:0};this.vehicles.set(id,car);}
    car.position.fromArray(loc.position);car.heading=loc.heading??car.heading;car.mode=key(mode);car.health=1;car.finished=false;car.waypoint=0;car.path=[];car.pathIndex=0;car.route=undefined;
    const config=this.assets.missionTuning[key(tuning).replaceAll('\\','/')]??this.assets.tuning[id];car.tuning=config??{};car.cruiseSpeed=(config?.SetTopSpeedKmh??75)/3.6;car.speed=car.verticalSpeed=car.damage=car.steer=0;resetVehicle(car);car.driver.reset();car.motion.reset(car);return car;
  }
  private async prop(id:unknown){const name=key(id),asset=this.assets.props[`${this.data.id}:${name}`]??this.assets.props[name];return asset?this.model(asset):undefined;}
  async start(id=this.progress.mission,restore=false){
    this.error='';this.presentation.stop();this.engine.start(this.data.missions.some(m=>m.id===id)?id:this.data.missions[0].id,restore?'load':'new',restore);await this.process();
  }
  retry(fromStart=false){this.error='';this.presentation.stop();this.callbacks.player().state.damage=0;this.clearMission();this.phaseKey='';this.engine.retry(fromStart);void this.process();}
  private async placeAt(name:unknown,onFoot:boolean,carName?:unknown){
    const loc=this.locator(name);const room=this.roomAt(new THREE.Vector3(...loc.position));
    if(room!==this.interior){if(room){const interior=this.data.interiors.find(i=>i.name===room)!;await this.world.enterInterior(interior.scene);}else this.world.leaveInterior();this.interior=room;}
    const parked=carName&&key(carName)!=='null'?this.locator(carName).position:undefined;this.callbacks.place(loc.position,loc.heading??this.callbacks.player().state.heading,onFoot,parked);
  }
  private async commands(commands:Command[],reset:boolean){
    let vehicle:Vehicle|undefined;
    for(const command of commands){
      if(this.disposed)return;const a=command.args;
      if(this.callbacks.law?.command(command))continue;
      switch(command.op){
        case 'InitLevelPlayerVehicle':await this.callbacks.vehicle(key(a[0]));await this.placeAt(a[1],false);break;
        case 'SetMissionResetPlayerInCar':if(reset)await this.placeAt(a[0],false);break;
        case 'SetMissionResetPlayerOutCar':if(reset)await this.placeAt(a[0],true,a[1]);break;
        case 'AddNPC':await this.npc(key(a[0]),a[1]);break;
        case 'RemoveNPC':{const npc=this.npcs.get(key(a[0]));npc?.actor.dispose();this.npcs.delete(key(a[0]));break;}
        case 'AddObjectiveNPCWaypoint':{const npc=this.npcs.get(key(a[0]));if(npc)npc.waypoints.push(new THREE.Vector3(...this.locator(a[1]).position));break;}
        case 'AddStageVehicle':vehicle=await this.vehicle(key(a[0]),a[1],String(a[2]??'null'),String(a[3]??''));break;
        case 'ActivateVehicle':{
          vehicle=this.vehicles.get(key(a[0]));if(!vehicle)throw new Error(`Mission activates absent vehicle ${a[0]}`);vehicle.mode=key(a[2]);vehicle.finished=false;vehicle.waypoint=0;vehicle.path=[];vehicle.pathIndex=0;vehicle.route=undefined;
          if(a[1]&&key(a[1])!=='null'){const loc=this.locator(a[1]);vehicle.position.fromArray(loc.position);vehicle.heading=loc.heading??vehicle.heading;vehicle.motion.reset(vehicle);}break;
        }
        case 'AddStageWaypoint':{
          const point=new THREE.Vector3(...this.locator(a[0]).position);for(const car of this.vehicles.values())car.waypoints.push(point.clone());break;
        }
        case 'AddStageCharacter':await this.placeAt(a[1],true,a[4]);break;
        case 'PlacePlayerCar':await this.placeAt(a[1],false);break;
        case 'PutMFPlayerInCar':{const p=this.callbacks.player();this.callbacks.place(p.parkedPosition.toArray(),p.parkedHeading,false);break;}
        case 'SwapInDefaultCar':{
          const initial=arg(this.data.initial,'InitLevelPlayerVehicle');await this.callbacks.vehicle(key(initial[0]));const at=arg(commands,'SetSwapPlayerLocator'),car=arg(commands,'SetSwapDefaultCarLocator');if(at.length)await this.placeAt(at[0],true,car[0]);break;
        }
        case 'SetMaxTraffic':this.callbacks.traffic(Number(a[0]));break;
        case 'AddCollectibleStateProp':{
          this.stateProp?.removeFromParent();this.stateProp=await this.prop(a[0]);if(this.stateProp){this.stateProp.position.fromArray(this.locator(a[1]).position);this.world.scene.add(this.stateProp);}break;
        }
      }
    }
  }
  private clearMission(){for(const [id,npc] of this.npcs)if(!npc.ambient){npc.actor.dispose();this.npcs.delete(id);}for(const car of this.vehicles.values())car.mesh.removeFromParent();this.vehicles.clear();this.stateProp?.removeFromParent();this.stateProp=undefined;this.boss?.removeFromParent();this.boss=undefined;this.beam?.removeFromParent();this.beam?.geometry.dispose();(this.beam?.material as THREE.Material|undefined)?.dispose();this.beam=undefined;this.cargoModel?.removeFromParent();this.cargoModel=undefined;}
  private clearItems(){for(const parts of this.destructibles.values())for(const part of parts)part.visible=true;this.destructibles.clear();this.itemsRoot.clear();this.items.clear();}
  private async prepare(effect:Extract<Effect,{type:'prepare'}>){
    this.presentation.stop();this.clearItems();this.action=false;this.bossHit=false;this.bossCharge=0;
    const changed=this.missionKey!==this.engine.missionKey;if(changed){this.clearMission();this.missionKey=this.engine.missionKey;this.callbacks.law?.reset();}
    for(const npc of this.npcs.values())if(!npc.ambient){npc.waypoints=[];npc.waypoint=0;}
    for(const car of this.vehicles.values())if(effect.commands.some(c=>c.op==='AddStageWaypoint')){car.waypoints=[];car.waypoint=0;car.path=[];car.pathIndex=0;car.route=undefined;car.finished=false;}
    const reset=['new','load','checkpoint'].includes(effect.reason);
    if(reset&&!changed)this.callbacks.law?.reset();
    const phaseKey=this.engine.missionKey+':'+this.progress.phase;if(reset||this.phaseKey!==phaseKey){await this.commands(effect.setup,reset);this.phaseKey=phaseKey;}if(effect.replay.length)await this.commands(effect.replay,false);await this.commands(effect.commands,false);
    if((effect.reason==='load'||effect.reason==='checkpoint')&&this.progress.checkpoint.player){
      const saved=this.progress.checkpoint.player;await this.callbacks.vehicle(saved.vehicle);
      if(saved.interior){const room=this.data.interiors.find(i=>i.name===saved.interior);if(room){await this.world.enterInterior(room.scene);this.interior=room.name;}}else{this.world.leaveInterior();this.interior=null;}
      this.callbacks.place(saved.position,saved.heading,saved.onFoot,saved.parkedPosition);this.callbacks.player().state.damage=0;
    }
    const dialoguePositions=arg(effect.commands,'SetDialoguePositions');if(this.engine.objective==='dialogue'&&dialoguePositions.length){
      await this.placeAt(dialoguePositions[0],true,dialoguePositions[2]);const info=arg(effect.commands,'SetDialogueInfo');if(info[1]&&dialoguePositions[1]){const npc=await this.npc(key(info[1]),dialoguePositions[1]),player=this.callbacks.player();const direction=npc.position.clone().sub(player.state.position);this.callbacks.place(player.state.position.toArray(),Math.atan2(direction.x,direction.z),true,player.parkedPosition.toArray());npc.heading=Math.atan2(-direction.x,-direction.z);npc.motion.reset(npc);}
    }
    if(this.engine.objective==='getin'&&this.engine.target&&!['current','default',key(this.callbacks.player().vehicle)].includes(this.engine.target)){
      const target=this.vehicles.get(this.engine.target);if(target){/* E enters the staged vehicle near its actual position. */}
    }
    if(this.engine.objective==='dialogue'){
      const info=arg(effect.commands,'SetDialogueInfo'),clips=this.assets.dialogue[`${this.data.id}:${key(info[2])}`]??[];
      const specific=clips.filter(c=>c.mission===this.engine.mission.id);const bitmap=key(arg(effect.commands,'SetPresentationBitmap')[0]).replaceAll('\\','/');void this.presentation.dialogue(specific.length?specific:clips.filter(c=>!c.mission),this.assets.presentations[bitmap]?{image:this.assets.presentations[bitmap],title:this.engine.mission.title}:undefined);
    }
    if(this.engine.objective==='fmv')void this.presentation.playMovie(`campaign/movies/${key(arg(effect.commands,'SetFMVInfo')[0]).replace('.rmv','.mp4')}`);
    if(!['dialogue','fmv'].includes(this.engine.objective)){const bitmap=key(arg(effect.commands,'SetPresentationBitmap')[0]).replaceAll('\\','/');if(this.assets.presentations[bitmap])this.presentation.missionBriefing({image:this.assets.presentations[bitmap],title:this.engine.mission.title});}
    if(this.engine.objective==='goto'){const destination=arg(effect.commands,'SetDestination'),model=await this.prop(destination[1]),position=this.engine.locator(destination[0]);if(model&&position){model.position.fromArray(position);this.itemsRoot.add(model);}}
    for(let i=0;i<this.engine.items.length;i++){
      const item=this.engine.items[i];if(item.length===1&&this.engine.objective==='delivery'){const name=key(item[0]).replace(/^pp_/,''),parts:THREE.Object3D[]=[];this.world.group.traverse(o=>{if(key(o.name)===name)parts.push(o);});this.destructibles.set(i,parts);}
      const model=await this.prop(item[1]);if(!model)continue;const position=this.engine.locator(item[0]);if(position)model.position.fromArray(position);model.visible=this.engine.objective!=='dump';this.items.set(i,model);this.itemsRoot.add(model);
    }
    if(this.engine.objective==='pickupitem'&&!this.stateProp){
      const props=all([...effect.setup,...effect.replay,...effect.commands],'AddCollectibleStateProp'),definition=props.find(a=>key(a[0])===this.engine.target);
      if(definition)await this.commands([{op:'AddCollectibleStateProp',args:definition,line:0}],false);
    }
    if(this.engine.objective==='destroyboss'&&!this.boss){this.boss=await this.prop('ufo');if(this.boss){const target=this.engine.navTarget(this.snapshot());if(target)this.boss.position.fromArray(target).add(new THREE.Vector3(0,12,0));this.world.scene.add(this.boss);}}
    if(this.engine.objective==='destroyboss'&&!this.beam){this.beam=new THREE.Mesh(new THREE.CylinderGeometry(3,11,12,48,1,true),new THREE.MeshBasicMaterial({color:0x9aff68,transparent:true,opacity:.16,side:THREE.DoubleSide,depthWrite:false}));const target=this.engine.navTarget(this.snapshot());if(target)this.beam.position.fromArray(target).add(new THREE.Vector3(0,6,0));this.world.scene.add(this.beam);}
    if(['pickupitem','destroyboss'].includes(this.engine.objective)&&!this.cargoModel){this.cargoModel=await this.prop('bombbarrel');if(this.cargoModel)this.world.scene.add(this.cargoModel);}
    const checkpoint=this.progress.checkpoint;if(checkpoint.phase===this.progress.phase&&checkpoint.stage===this.progress.stage&&!checkpoint.player){const p=this.callbacks.player();checkpoint.player={position:p.state.position.toArray(),heading:p.state.heading,onFoot:p.onFoot,vehicle:p.vehicle,parkedPosition:p.parkedPosition.toArray(),parkedHeading:p.parkedHeading,interior:this.interior};checkpoint.remaining=this.engine.remaining;checkpoint.cargo=this.engine.cargo;}
    const laps=Number(arg(effect.commands,'SetRaceLaps',[1])[0]);if(laps>1)for(const car of this.vehicles.values()){const points=car.waypoints;car.waypoints=Array.from({length:laps},()=>points.map(p=>p.clone())).flat();}
    this.engine.ready();this.callbacks.save();
  }
  private async process(){
    if(this.busy||this.disposed)return;this.busy=true;
    try{
      for(const effect of this.engine.drain()){
        if(this.disposed)return;
        if(effect.type==='prepare')await this.prepare(effect);
        if(effect.type==='failed')this.callbacks.toast(`${effect.message} · Enter to retry`);
        if(effect.type==='stage-complete'&&this.engine.stage.commands.some(c=>c.op==='ShowStageComplete'))this.callbacks.toast('STAGE COMPLETE');
        if(effect.type==='mission-complete'){this.callbacks.toast(`MISSION COMPLETE · ${effect.title}`);this.callbacks.save();}
        if(effect.type==='chapter-complete'){if(this.data.endMovie){await this.presentation.playMovie(`campaign/movies/${this.data.endMovie}.mp4`);await this.presentation.waitForFinish();if(this.disposed)return;}this.progress.level=effect.nextLevel;await this.callbacks.chapter(effect.nextLevel,this.progress);}
        if(effect.type==='campaign-complete'){this.callbacks.toast('GAME COMPLETE');void this.presentation.playMovie('campaign/movies/fmv7.mp4');this.callbacks.save();}
        if(effect.type==='collect'){this.items.get(effect.index)?.removeFromParent();const parts=this.destructibles.get(effect.index)??[];if(parts.some(p=>p.visible))this.callbacks.law?.offense('propDestroyed',!!this.interior);for(const part of parts)part.visible=false;}
        if(effect.type==='drop'){const item=this.items.get(effect.index);if(item){item.position.fromArray(effect.position);item.visible=true;}}
        if(effect.type==='purchase'){if(effect.reward.type==='car')await this.callbacks.vehicle(effect.reward.id);else await this.callbacks.skin(effect.reward.id);this.callbacks.save();}
      }
    }catch(error){this.error=error instanceof Error?error.message:String(error);console.error('Campaign:',error);this.callbacks.toast(this.error);}
    finally{this.busy=false;}
  }
  private snapshot():Snapshot{
    const p=this.callbacks.player(),entities:Record<string,EntityState>={};
    for(const [id,npc] of this.npcs)entities[id]={id,position:npc.position.toArray(),health:1,interior:npc.interior??undefined};
    for(const [id,car] of this.vehicles)entities[id]={id,position:car.position.toArray(),health:car.health,finished:car.finished,waypoint:car.waypoint,progress:car.waypoint/(car.waypoints.length||1)};
    return {position:p.state.position.toArray(),onFoot:p.onFoot,vehicle:p.vehicle,health:1-p.state.damage/100,interior:this.interior,entities,parkedPosition:p.parkedPosition.toArray(),interact:this.action,dialogueDone:this.presentation.done,movieDone:this.presentation.done,bossHit:this.bossHit};
  }
  private updateVehicles(dt:number){
    const player=this.callbacks.player();let hit:string|undefined;
    if(this.interior)return hit;
    for(const car of this.vehicles.values()){
      car.motion.capture(car);car.hitCooldown=Math.max(0,car.hitCooldown-dt);car.repath-=dt;if(car.health<=0||this.engine.countdown>0)continue;
      const chase=car.mode==='chase';
      if(chase&&car.repath<=0&&!this.interior){car.route=new MissionRoute(this.road.route(car.position,player.state.position));car.repath=1.2;car.finished=false;}
      if(car.mode!=='null'&&!chase&&(!car.route||car.route.finished)&&!car.finished){
        if(car.waypoint>=car.waypoints.length){car.finished=car.waypoints.length>0;}
        else
        car.route=new MissionRoute(this.road.route(car.position,car.waypoints[car.waypoint]));
      }
      if(car.route&&!car.finished){
        const target=car.route.follow(car.position,Math.max(AI_RULES.minimumLookahead,Math.abs(car.speed)*AI_RULES.lookaheadSeconds));
        const obstacles=[...this.vehicles.values()].filter(v=>v!==car).map(v=>({position:v.position,heading:v.heading,footprint:v.footprint}));
        if(!chase)obstacles.push({position:player.state.position,heading:player.state.heading,footprint:player.footprint??car.footprint});
        const control=car.driver.controls(car,target,car.cruiseSpeed,dt,car.tuning,obstacles,car.footprint);
        simulateVehicle(car,control,dt,car.tuning,car.profile,this.world.terrain,false);
        if(!chase&&car.route.finished){car.waypoint++;car.finished=car.waypoint>=car.waypoints.length;}
      }else simulateVehicle(car,{steer:0,throttle:0,brake:0,handbrake:true},dt,car.tuning,car.profile,this.world.terrain,false);
      car.health=Math.min(car.health,1-car.damage/100);
      if(!player.onFoot){
        const contact=collideVehicles(player.state,car,this.assets.tuning[player.vehicle]?.SetMass??1500,car.tuning.SetMass??1500,player.footprint,car.footprint);
        if(contact&&contact.closing>1&&car.hitCooldown===0){const closing=contact.closing,alive=car.health>0;car.health=Math.max(0,car.health-Math.min(.35,.06+closing*.008));player.state.damage=Math.min(100,player.state.damage+closing*.18);car.hitCooldown=1;hit=car.id;if(alive)this.callbacks.law?.offense(car.health===0?'vehicleDestroyed':'vehicleHit',!!this.interior);}
      }
    }
    return hit;
  }
  update(dt:number){
    if(this.disposed||!this.active)return;this.time+=dt;if(this.busy||this.error)return;
    if(!this.presentation.active&&this.engine.status!=='failed'){
      const player=this.callbacks.player();
      for(const npc of this.npcs.values()){
        npc.motion.capture(npc);
        const contact=npc.interior===this.interior&&npc.position.distanceTo(player.state.position)<(player.onFoot?2.5:2.2);
        if(!npc.reaction&&contact&&(player.onFoot?this.kicked:Math.abs(player.state.speed)>3)){
          const direction=npc.position.clone().sub(player.state.position).setY(0).normalize();
          npc.reaction={phase:'flail',remaining:npc.actor.duration('hom_flail')||.8,velocity:direction.multiplyScalar(player.onFoot?3:Math.min(8,Math.abs(player.state.speed)*.3)),body:{position:npc.position,heading:npc.heading,speed:0,verticalSpeed:3.5,steer:0,distance:0,damage:0}};
          this.callbacks.law?.offense(player.onFoot?'pedestrianKicked':'pedestrianHit',!!this.interior);
        }
        if(npc.reaction){
          const reaction=npc.reaction;reaction.remaining-=dt;npc.actor.play(reaction.phase==='flail'?'hom_flail':'hom_get_up',true);
          if(npc.interior===this.interior){const previous=npc.position.clone();npc.position.addScaledVector(reaction.velocity,dt);reaction.velocity.multiplyScalar(Math.exp(-5*dt));this.world.terrain.resolve(reaction.body,previous,dt,.35,true);}
          if(reaction.remaining<=0){if(reaction.phase==='flail'){reaction.phase='getup';reaction.remaining=npc.actor.duration('hom_get_up')||1;}else npc.reaction=undefined;}
          continue;
        }
        if(npc.ambient&&npc.waypoint>=npc.waypoints.length)npc.waypoint=0;const target=npc.waypoints[npc.waypoint];
        if(target){const delta=target.clone().sub(npc.position),d=delta.length();if(d<.2){npc.waypoint++;}else{npc.position.addScaledVector(delta,Math.min(d,dt*1.25)/d);npc.heading=Math.atan2(delta.x,delta.z);}}npc.actor.play(target?'hom_loco_walk':'hom_loco_idle_rest');
      }
    }
    const snapshot=this.snapshot();if(!this.presentation.active)snapshot.hitVehicle=this.updateVehicles(dt);
    if(this.stateProp){this.stateProp.visible=!this.engine.cargo;}
    if(this.cargoModel){const p=this.callbacks.player();this.cargoModel.visible=!!this.engine.cargo;this.cargoModel.position.copy(p.onFoot?p.parkedPosition:p.state.position).add(new THREE.Vector3(0,1.9,0));}
    if(this.beam){this.beam.visible=this.engine.objective==='destroyboss';(this.beam.material as THREE.MeshBasicMaterial).opacity=.12+Math.sin(this.time*7)*.04+Math.min(.2,this.bossCharge*.03);}
    if(this.engine.objective==='destroyboss'&&this.engine.cargo){
      const p=this.callbacks.player(),target=this.engine.navTarget(snapshot),car=p.onFoot?p.parkedPosition:p.state.position;
      if(target&&car.distanceTo(new THREE.Vector3(...target))<11){this.bossCharge+=dt;if(p.onFoot&&this.bossCharge>=3)this.bossHit=true;else if(!p.onFoot&&this.bossCharge>6)this.engine.fail('LEAVE YOUR VEHICLE BEFORE IT IS ABDUCTED');}else this.bossCharge=0;
      if(this.cargoModel&&p.onFoot)this.cargoModel.position.y+=Math.min(10,this.bossCharge*3);snapshot.bossHit=this.bossHit;if(this.bossHit&&this.boss)this.boss.rotation.z=Math.sin(this.time*18)*.035;
    }
    snapshot.brokenCollectibles=[];if(this.engine.stage){const p=this.callbacks.player();this.engine.items.forEach((item,i)=>{const target=this.engine.locator(item[0]);if(item.length===1&&target&&distance(snapshot.position,target)<(p.onFoot?3:5)&&(this.kicked||!p.onFoot&&Math.abs(p.state.speed)>4))snapshot.brokenCollectibles!.push(i);});}
    this.engine.tick(dt,snapshot);this.action=false;this.kicked=false;void this.process();
  }
  render(dt:number,alpha:number){
    const player=this.callbacks.player();
    for(const npc of this.npcs.values()){const pose=npc.motion.sample(npc,alpha);npc.actor.group.position.copy(pose.position);npc.actor.group.rotation.y=pose.heading;npc.actor.group.visible=(!npc.bonus||!this.engine.mission.optional)&&npc.interior===this.interior&&npc.position.distanceToSquared(player.state.position)<150**2;if(npc.actor.group.visible){if(this.presentation.active&&this.engine.objective==='dialogue'){const animations=all(this.engine.stage.commands,'AddAmbientNpcAnimation'),name=key(animations[(this.presentation.line-1)%Math.max(1,animations.length)]?.[0]);npc.actor.play(name&&name!=='none'?'hom_'+name:'hom_loco_idle_rest');}npc.actor.update(dt);}}
    for(const car of this.vehicles.values()){const pose=car.motion.sample(car,alpha);car.mesh.position.copy(pose.position);car.mesh.position.y+=car.offset;car.mesh.rotation.y=pose.heading+Math.PI;if(car.vehicleMotion){car.mesh.position.copy(pose.position).add(new THREE.Vector3(0,car.offset,0).applyQuaternion(car.vehicleMotion.orientation));car.mesh.quaternion.copy(car.vehicleMotion.orientation).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),Math.PI));}renderVehicleWheels(car.mesh,car.vehicleMotion,car.profile,car.tuning);car.mesh.visible=!this.interior&&car.position.distanceToSquared(player.state.position)<460**2;}
    if(this.engine.stage){const point=this.navigationTarget(this.snapshot());this.target.scale.setScalar(player.onFoot?.55:1);this.target.visible=!!point&&!this.presentation.active&&!this.error;if(point){this.target.position.fromArray(point);this.target.position.y+=.2;this.target.children[1].position.y=3.5+Math.sin(this.time*3)*.3;this.target.children[1].rotation.y=this.time;}}
    this.itemsRoot.visible=!this.presentation.active;
  }
  interact(){
    if(this.frozen)return false;const p=this.callbacks.player();this.action=true;
    if(!p.onFoot)return false;
    if(this.interior){
      const room=this.data.interiors.find(i=>i.name===this.interior);if(room?.exit&&distance(p.state.position.toArray(),room.exit.position)<3){void this.exitInterior();return true;}
    }else{
      const entrance=Object.values(this.data.locators).find(l=>l.kind===7&&l.interior&&distance(p.state.position.toArray(),l.position)<4);
      if(entrance){void this.enterInterior(entrance.interior!);return true;}
    }
    const required=this.engine.target&&this.vehicles.get(this.engine.target);
    if(required&&p.state.position.distanceTo(required.position)<6){void (async()=>{await this.callbacks.vehicle(required.id);this.callbacks.place(required.position.toArray(),required.heading,false);required.mesh.removeFromParent();this.vehicles.delete(required.id);})();return true;}
    const npc=[...this.npcs.values()].find(n=>n.interior===this.interior&&n.position.distanceTo(p.state.position)<4);
    if(npc){
      if(npc.reaction){this.action=false;return true;}
      if(npc.bonus&&!this.engine.mission.optional){void this.start(npc.bonus);return true;}
      if(['buycar','buyskin'].includes(this.engine.objective)&&key(this.engine.stage.objective.mode)){const reward=this.engine.rewards.find(r=>r.id===key(this.engine.stage.objective.mode)&&r.level===this.data.id);if(reward&&!this.engine.purchase(reward.id))this.callbacks.toast(`${reward.cost} COINS REQUIRED`);void this.process();}
      return true;
    }
    return this.engine.objective==='goto'&&this.engine.stage.commands.some(c=>c.op==='MustActionTrigger');
  }
  kick(){this.kicked=true;}
  private hint(){
    if(this.engine.objective==='coins')return `E: PAY ENTRY FEE · ${arg(this.engine.stage.commands,'SetCoinFee',[0])[0]} COINS`;
    if(this.error)return 'MISSION ERROR';if(this.engine.status==='failed')return 'ENTER: RETRY · ESC: MENU';if(this.presentation.active)return '';
    if(['buycar','buyskin'].includes(this.engine.objective)){const reward=this.engine.rewards.find(r=>r.id===key(this.engine.stage.objective.mode)&&r.level===this.data.id);return reward?`E: BUY · ${reward.cost} COINS`:'';}
    return this.callbacks.player().onFoot?'E: TALK / ENTER · F: KICK':'E: GET OUT';
  }
  private async enterInterior(name:string){
    const room=this.data.interiors.find(i=>key(i.name)===key(name));if(!room?.start)return;this.busy=true;
    try{this.returnPosition=this.callbacks.player().state.position.toArray();await this.world.enterInterior(room.scene);this.interior=room.name;this.callbacks.place(room.start.position,room.start.heading??Math.PI,true);}
    catch(error){this.error=String(error);}finally{this.busy=false;}
  }
  private async exitInterior(){
    this.world.leaveInterior();const entrance=Object.values(this.data.locators).find(l=>key(l.interior)===key(this.interior));const position=this.returnPosition??entrance?.position;this.interior=null;if(position)this.callbacks.place(position,this.callbacks.player().state.heading,true);this.returnPosition=null;
  }
  resetInterpolation(){for(const npc of this.npcs.values())npc.motion.reset(npc);for(const car of this.vehicles.values())car.motion.reset(car);}
  dispose(){this.disposed=true;this.presentation.dispose();for(const npc of this.npcs.values())npc.actor.dispose();this.npcs.clear();this.clearMission();this.clearItems();this.itemsRoot.removeFromParent();this.target.removeFromParent();this.target.traverse(o=>{if(o instanceof THREE.Mesh){o.geometry.dispose();(o.material as THREE.Material).dispose();}});}
}
