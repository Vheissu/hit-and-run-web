import { devTools } from './dev-tools';
import { Campaign,type CampaignAssets } from './campaign/runtime';
import { newProgress,validateProgress } from './campaign/engine';
import { arg,type Chapter,type Progress,type Vec3 } from './campaign/types';
import { pursuitSettings } from './hit-and-run';
import { Pursuit } from './pursuit';
import { DEFAULT_FOOTPRINT,type VehicleFootprint } from './vehicle-collision';
import { Motion } from './motion';
import './style.css';
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { World, CAR_NAMES, LEVEL_NAMES } from './world';
import { json, type Catalog } from './assets';
import { Input } from './input';
import { drive, type CarState } from './physics';
import { PlayerMovement } from './player-movement';
import { renderVehicleWheels,simulateVehicle,vehicleProfile,DEFAULT_VEHICLE,resetVehicle,type VehicleProfile } from './vehicle-physics';
import { HUD, element } from './hud';
import { Challenge } from './challenge';
import { Traffic } from './traffic';
import { Sound } from './audio';
import { Character } from './character';
import { Coins } from './coins';
import { FrameMetrics } from './performance';
import { originalArt,OriginalMenu,OriginalHUD,FrontendRoom } from './original-ui';

const controller=new AbortController(), options={signal:controller.signal};
const scene=new THREE.Scene(), camera=new THREE.PerspectiveCamera(55,innerWidth/innerHeight,0.2,900);
const renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setSize(innerWidth,innerHeight);
renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.25;
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;renderer.info.autoReset=false;
renderer.domElement.setAttribute('aria-label','Springfield 3D driving scene');renderer.domElement.tabIndex=0;
element('game').append(renderer.domElement);
const composer=new EffectComposer(renderer);
composer.renderTarget1.samples=4;composer.renderTarget2.samples=4;
const bloom=new UnrealBloomPass(new THREE.Vector2(innerWidth,innerHeight),0.035,0.25,1.5);
composer.addPass(new RenderPass(scene,camera));composer.addPass(bloom);composer.addPass(new OutputPass());
const input=new Input(),hud=new HUD(),challenge=new Challenge(scene),sound=new Sound(),metrics=new FrameMetrics();let metricText='',metricTime=0;
const state:CarState={position:new THREE.Vector3(220,3.5,172),heading:Math.PI/2,speed:0,verticalSpeed:0,steer:0,distance:0,damage:0};
const motion=new Motion();motion.reset(state);
const walking=new PlayerMovement();
let nativeMenu:OriginalMenu|undefined,menuRoom:FrontendRoom|undefined;const nativeHUD=new OriginalHUD();
let coins:Coins|undefined;let campaign:Campaign|undefined,campaignAssets:CampaignAssets;let kickUntil=0;let police:Pursuit|undefined,freeMoney=0;
let world:World, traffic:Traffic|undefined, car:THREE.Group|undefined,carOffset=0.65,footprint:VehicleFootprint=DEFAULT_FOOTPRINT;
let chassis:VehicleProfile=DEFAULT_VEHICLE;
let catalog:Catalog, loading=true,paused=true,highQuality=true,cameraMode=0,debug=false;
let onFoot=false,cruise=false,character:Character|undefined,footHeading=0,cameraYaw=0;const parkedPosition=new THREE.Vector3();let parkedHeading=0;
/** How quickly the on-foot camera swings back behind the character, in radians of remaining error per second. */
const FOOT_CAMERA_FOLLOW=2.2;
let level=1, carId='famil_v',carModels=new Map<string,THREE.Group>();
let last=performance.now(),accumulator=0,time=0,frame=0,fps=60,lastFPS=last,photo=false;
const previous=new THREE.Vector3(),desiredCamera=new THREE.Vector3(),look=new THREE.Vector3(),smoothLook=new THREE.Vector3(),sunOffset=new THREE.Vector3();
const forward=new THREE.Vector3(),right=new THREE.Vector3(),normal=new THREE.Vector3(),rotationMatrix=new THREE.Matrix4(),rotation=new THREE.Quaternion();
const cameraRay=new THREE.Raycaster();cameraRay.firstHitOnly=true;
const CHARACTER_IDS=['homer','bart','lisa','marge','apu','bart','homer'];
const CHARACTER_NAMES=['HOMER SIMPSON','BART SIMPSON','LISA SIMPSON','MARGE SIMPSON','APU','BART SIMPSON','HOMER SIMPSON'];
const levelSelect=element<HTMLSelectElement>('level'),carSelect=element<HTMLSelectElement>('car'),locationSelect=element<HTMLSelectElement>('location'),lighting=element<HTMLSelectElement>('lighting');
const play=element<HTMLButtonElement>('play'),run=element<HTMLButtonElement>('challenge');

function progress(value:number,message:string){element('load-progress').style.width=`${value*100}%`;element('load-message').textContent=message;}
function lock(value:boolean){loading=value;for(const node of document.querySelectorAll<HTMLButtonElement|HTMLSelectElement>('#menu button,#menu select'))node.disabled=value;}
function pause(value:boolean){
  if(loading)return;paused=value;input.clear();accumulator=0;motion.reset(state);traffic?.resetInterpolation();police?.resetInterpolation();campaign?.resetInterpolation();campaign?.presentation.setPaused(value);element('menu').hidden=!value;element('hud').hidden=value||photo;
  if(value){nativeMenu?.show('pause');cruise=false;play.querySelector('span')!.textContent='Back to Springfield';sound.pause();play.focus();}
  else{metrics.reset();sound.start();renderer.domElement.focus();smoothLook.copy(state.position);}
}
function toast(message:string){hud.toast(message);}
function nearestRoad(position:THREE.Vector3){
  let point=position.clone(),heading=state.heading,distance=Infinity;
  for(const [av,bv] of world.data.roads){
    const a=new THREE.Vector3(...av as [number,number,number]),b=new THREE.Vector3(...bv as [number,number,number]);
    const line=new THREE.Line3(a,b);const p=line.closestPointToPoint(position,true,new THREE.Vector3());
    const d=p.distanceTo(position);if(d<distance){distance=d;point=p;heading=Math.atan2(b.x-a.x,b.z-a.z);}
  }
  return {point,heading};
}
function respawn(location?:number){
  if(!world?.terrain)return;
  const place=location===undefined?state.position.clone():new THREE.Vector3(...world.data.locations[location].position);
  const road=nearestRoad(place);state.position.copy(road.point);state.heading=road.heading;
  const ground=world.terrain.ground(state.position.x,state.position.z,state.position.y,10);
  if(ground)state.position.y=ground.point.y+0.06;
  state.speed=0;state.verticalSpeed=0;state.damage=0;state.steer=0;state.grounded=true;walking.reset(state.heading);cameraYaw=state.heading;resetVehicle(state);cruise=false;smoothLook.copy(state.position);motion.reset(state);
  if(car)car.position.copy(state.position).add(new THREE.Vector3(0,carOffset,0));
  updateCamera(1,true);
}
async function setCar(id:string){
  if(onFoot){onFoot=false;state.position.copy(parkedPosition);state.heading=parkedHeading;}
  character?.group.removeFromParent();car?.removeFromParent();
  if(!carModels.has(id)){const asset=await world.assets.load(`car-${id}`,true);carModels.set(id,asset.root);}
  car=carModels.get(id)!;carId=id;carSelect.value=id;
  police?.enterVehicle(id);
  car.rotation.set(0,0,0);car.position.set(0,0,0);
  const box=new THREE.Box3().setFromObject(car),size=box.getSize(new THREE.Vector3());carOffset=-box.min.y+0.04;footprint={halfWidth:size.x/2,halfLength:size.z/2};
  chassis=vehicleProfile(car);carOffset=chassis.offset;resetVehicle(state);
  car.traverse(o=>{if(o instanceof THREE.Mesh){o.castShadow=true;o.receiveShadow=true;}});
  scene.add(car);character?.drive(car);element('car-label').textContent=(CAR_NAMES[id]??id).toUpperCase();
  element('scene-info').textContent=`${CAR_NAMES[id]??id} · ${LEVEL_NAMES[level-1]}`;
}
async function loadLevel(nextLevel:number){
  lock(true);paused=true;element('loading').hidden=false;element('hud').hidden=true;challenge.stop();
  campaign?.dispose();campaign=undefined;nativeHUD.campaign=null;police?.dispose();police=undefined;traffic?.dispose();coins?.dispose();character?.dispose();character=undefined;onFoot=false;cruise=false;car?.removeFromParent();world?.dispose();carModels.clear();
  level=nextLevel;levelSelect.value=String(nextLevel);lighting.value=level===7?'night':level>=4?'golden':'day';world=new World(scene,catalog);
  try{
    const chapterPromise=json<Chapter>(`campaign/level${level}.json`);await world.load(level,progress);coins=new Coins(scene,world.data);freeMoney=coins.collected;progress(0.9,'Getting the cars ready…');
    locationSelect.replaceChildren(...world.data.locations.map((place,i)=>new Option(place.name,String(i))));
    const chapter=await chapterPromise,driver=new Character();traffic=new Traffic(world,chapter.initial,campaignAssets.tuning);
    police=new Pursuit(world,pursuitSettings(chapter.initial),campaignAssets,{toast,fine:amount=>{const paid=Math.min(amount,campaign?.progress.money??freeMoney);if(campaign)campaign.progress.money-=paid;else freeMoney-=paid;saveGame();return paid;},busted:()=>sound.busted()});
    await Promise.all([setCar(carId),driver.load(world.assets,CHARACTER_IDS[level-1]),traffic.load(),police.load(),coins.load(world.assets,world.objectData.coin)]);
    character=driver;character.drive(car!);
    element('district').textContent=`SPRINGFIELD · LEVEL ${String(level).padStart(2,'0')}`;
    element('menu-place').textContent=level===1?'742 Evergreen Terrace':LEVEL_NAMES[level-1];
    world.setLighting(lighting.value);respawn(0);renderer.compile(scene,camera);
    progress(1,'Ready');lock(false);element('loading').hidden=true;element('menu').hidden=false;
    nativeMenu?.show(nativeMenu.mode);
  }catch(error){
    progress(0,error instanceof Error?error.message:String(error));element('load-message').textContent+=' · Check the console, then reload to retry.';console.error(error);
  }
}
function startChallenge(){campaign?.dispose();campaign=undefined;nativeHUD.campaign=null;police?.reset();world.leaveInterior();if(onFoot){onFoot=false;character?.drive(car!);}challenge.start(world.data);respawn(0);pause(false);element('mode-badge').textContent='SPRINGFIELD RUN';toast('Five stops. Five minutes. Make it home.');}
function updateCamera(dt:number,snap=false){
  const position=motion.position;
  const conversation=campaign?.conversationCamera;if(conversation&&!paused){camera.position.copy(conversation.position);smoothLook.copy(conversation.look);camera.lookAt(smoothLook);camera.fov=45;camera.updateProjectionMatrix();return;}
  if(paused&&nativeMenu?.mode==='pause'&&!snap)return;
  if(paused){
    const angle=motion.heading+0.6+Math.sin(time*0.07)*0.13;
    desiredCamera.set(position.x-Math.sin(angle)*9,position.y+4,position.z-Math.cos(angle)*9);
    look.copy(position).add(new THREE.Vector3(-2.2,1,0));
  }else{
    const backwards=input.down('KeyB'),heading=(onFoot?cameraYaw:motion.heading)+(backwards?Math.PI:0);
    const distance=onFoot?4.3:cameraMode===1?12.5:cameraMode===2?0.2:8.1;
    desiredCamera.set(position.x-Math.sin(heading)*distance,position.y+(onFoot?2.7:cameraMode===1?6.5:cameraMode===2?1.55:3.55),position.z-Math.cos(heading)*distance);
    look.set(position.x+Math.sin(heading)*5,position.y+1.2,position.z+Math.cos(heading)*5);
    if(world?.terrain&&cameraMode!==2){
      const anchor=position.clone().add(new THREE.Vector3(0,1.6,0));const direction=desiredCamera.clone().sub(anchor);const distance=direction.length();
      cameraRay.set(anchor,direction.normalize());cameraRay.far=distance;
      const hit=world.terrain.raycast(anchor,direction,distance);
      if(hit)desiredCamera.copy(hit.point).addScaledVector(direction,-0.35);
      const ground=world.terrain.ground(desiredCamera.x,desiredCamera.z,position.y,4);
      if(ground)desiredCamera.y=Math.max(desiredCamera.y,ground.point.y+1);
    }
  }
  camera.position.lerp(desiredCamera,snap?1:1-Math.exp(-dt*5.5));
  smoothLook.lerp(look,snap?1:1-Math.exp(-dt*9));camera.lookAt(smoothLook);
  camera.fov=THREE.MathUtils.damp(camera.fov,paused?49:55+Math.min(Math.abs(state.speed)*0.16,6),4,dt);camera.updateProjectionMatrix();
}
function animate(now:number){
  const frameMs=now-last,dt=Math.min(frameMs/1000,0.08);last=now;time+=dt;frame++;
  if(now-lastFPS>750){fps=Math.round(frame*1000/(now-lastFPS));frame=0;lastFPS=now;}
  if(!loading){
    if(input.consume('Escape')){if(!paused)pause(true);else if(nativeMenu?.mode==='pause')pause(false);else if(nativeMenu&&nativeMenu.mode!=='main'&&nativeMenu.mode!=='splash')nativeMenu.back();}
    if(input.consume('F3')){debug=!debug;element('debug').hidden=!debug;}
    if(!paused){
      if(input.consume('Enter')&&campaign?.engine.status==='failed')campaign.retry();
      if(input.consume('KeyF')&&onFoot&&!campaign?.frozen&&!police?.frozen){if(campaign?.interior||!world.objects.kick(state.position,footHeading))campaign?.kick();walking.kick();character?.play('hom_jump_kick');kickUntil=time+.45;}
      if(input.consume('KeyR')&&!police?.frozen){if(onFoot){onFoot=false;character?.drive(car!);}respawn();toast('Back on the road.');}
      if(input.consume('KeyH')&&!onFoot){cruise=!cruise;toast(cruise?'Cruise control · 50 km/h. Brake to cancel.':'Cruise control off.');}
      if(input.consume('KeyE')&&character&&car&&!campaign?.frozen&&!police?.frozen&&!campaign?.interact()){
        if(onFoot){
          if(state.position.distanceTo(parkedPosition)<6){onFoot=false;state.position.copy(parkedPosition);state.heading=parkedHeading;state.speed=0;character.drive(car);element('car-label').textContent=(CAR_NAMES[carId]??carId).toUpperCase();element('drive-hints').innerHTML='<span><kbd>W A S D</kbd> Drive</span><span><kbd>SPACE</kbd> Drift</span><span><kbd>E</kbd> Get out</span><span><kbd>H</kbd> Cruise</span><span><kbd>C</kbd> Camera</span>';toast('Back behind the wheel.');}
          else toast('Get closer to your car.');
        }else if(Math.abs(state.speed)<2){
          onFoot=true;car.visible=true;cruise=false;parkedPosition.copy(state.position);parkedHeading=state.heading;footHeading=state.heading;cameraYaw=state.heading;
          state.position.add(new THREE.Vector3(Math.cos(state.heading)*2,0,-Math.sin(state.heading)*2));state.speed=0;
          walking.reset(state.heading);
          character.walk(scene,state.position,state.heading);element('car-label').textContent=CHARACTER_NAMES[level-1];element('drive-hints').innerHTML='<span><kbd>W A S D</kbd> Walk</span><span><kbd>SHIFT</kbd> Run</span><span><kbd>SPACE</kbd> Jump</span><span><kbd>E</kbd> Get in</span>'; toast('WASD to walk · Shift to run · Space to jump · E to get in.');
        }else toast('Stop the car before getting out.');
        if(!onFoot)police?.enterVehicle(carId);resetVehicle(state);motion.reset(state);
      }
      if(input.consume('KeyC')){cameraMode=(cameraMode+1)%3;toast(['Chase camera','Wide camera','Hood camera'][cameraMode]);}
      if(input.consume('KeyM'))hud.bigMap=!hud.bigMap;
      if(input.consume('KeyP')){photo=!photo;element('hud').hidden=photo;}
      accumulator+=dt;
      while(accumulator>=1/60){
        const fixed=1/60;motion.capture(state);previous.copy(state.position);const controls=input.controls;
        if(!campaign?.frozen&&!police?.frozen){
        if(onFoot){
          world.terrain.setVehiclePlatforms(campaign?.interior?[]:[{id:'player',position:parkedPosition,heading:parkedHeading,half:chassis.half,center:chassis.center},...(traffic?.cars.filter(c=>c.active)??[]).map((c,i)=>({id:`traffic:${c.mesh.uuid}`,position:c.position,heading:c.heading,orientation:c.vehicleMotion?.orientation,half:c.profile.half,center:c.profile.center})),...(police?.cars??[]).map((c,i)=>({id:`police:${c.mesh.uuid}`,position:c.position,heading:c.heading,orientation:c.vehicleMotion?.orientation,half:c.profile.half,center:c.profile.center})),...(campaign?.vehicleBodies??[]).map(c=>({id:`mission:${c.mesh.uuid}`,position:c.position,heading:c.heading,orientation:c.vehicleMotion?.orientation,half:c.profile.half,center:c.profile.center}))]);
          const x=(input.down('KeyD','ArrowRight')?1:0)-(input.down('KeyA','ArrowLeft')?1:0),z=(input.down('KeyW','ArrowUp')?1:0)-(input.down('KeyS','ArrowDown')?1:0);
          const animation=walking.update(state,{x,z,run:input.down('ShiftLeft','ShiftRight'),jump:input.consume('Space')},fixed,world.terrain,cameraYaw);footHeading=walking.heading;
          if(state.speed>.2)cameraYaw+=(THREE.MathUtils.euclideanModulo(footHeading-cameraYaw+Math.PI,Math.PI*2)-Math.PI)*(1-Math.exp(-fixed*FOOT_CAMERA_FOLLOW));
          if(time>kickUntil)character?.play(animation);
        }else{
          world.terrain.setVehiclePlatforms([]);
          if(controls.brake||controls.handbrake)cruise=false;
          if(cruise)controls.throttle=state.speed<13.9?1:0;
          simulateVehicle(state,controls,fixed,campaignAssets.tuning[carId],chassis,world.terrain);
        }
        for(const reward of world.objects.drain()){
          const floor=world.terrain.support(reward.position.x,reward.position.z,reward.position.y,1)?.point.y??reward.position.y;
          const overflow=coins?.drop(reward.coins,reward.position,floor+.5,reward.inCar)??reward.coins;
          if(overflow){if(campaign)campaign.engine.earn(overflow);else freeMoney+=overflow;}
          if(reward.heat)police?.offense('propDestroyed',!!campaign?.interior);
          if(campaign)(campaign.progress.brokenProps??={})[String(level)]=world.objects.entries;saveGame();
        }
        if(!campaign?.interior&&traffic?.update(fixed,state,!onFoot,camera.getWorldDirection(new THREE.Vector3()),[...(onFoot?[parkedPosition]:[]),...(police?.cars.map(c=>c.position)??[]),...(campaign?.trafficObstacles??[])],footprint,campaignAssets.tuning[carId]?.SetMass??1500))police?.offense('vehicleHit',false);
        const result=challenge.update(fixed,state.position);
        if(result==='checkpoint')toast(`Stop ${challenge.index} reached. Keep moving.`);
        if(result==='complete'){toast(`Home in ${Math.floor(challenge.elapsed/60)}:${String(Math.floor(challenge.elapsed%60)).padStart(2,'0')}. Nice driving.`);element('mode-badge').textContent='FREE DRIVE';}
        if(result==='failed'){toast('Time’s up. Try the Springfield Run again from the menu.');element('mode-badge').textContent='FREE DRIVE';}
        if(state.position.y<world.terrain.bottom-15||state.damage>=100){if(campaign?.active)campaign.engine.fail(state.damage>=100?'VEHICLE DESTROYED':'RETURN TO THE MISSION');else{respawn();toast('A fresh start.');}}
        }
        if(!campaign?.frozen)police?.update(fixed,{state,onFoot,vehicle:carId,parkedPosition,parkedHeading,footprint},!!campaign?.interior,traffic?.cars.filter(c=>c.active).map(c=>c.position));
        if(!police?.frozen)campaign?.update(fixed);
        accumulator-=fixed;
      }
      sound.update(state.speed,input.controls.throttle);
      sound.pursuit(!!police?.hud.active&&!campaign?.frozen,police?.audibleDistance??Infinity);
    }else{accumulator=0;motion.reset(state);}
    const frozen=paused||campaign?.frozen||police?.frozen,alpha=frozen?1:accumulator*60;motion.sample(state,alpha);traffic?.render(frozen?0:dt,alpha,state.position);police?.render(frozen?0:dt,alpha);campaign?.render(frozen?0:dt,alpha);nativeHUD.campaign=campaign?.active?campaign.hud:null;nativeHUD.pursuit=police?.hud;
    if(car&&!onFoot){
      car.position.copy(motion.position);car.position.add(new THREE.Vector3(0,carOffset,0).applyQuaternion(state.vehicleMotion?.orientation??new THREE.Quaternion()));
      normal.copy(world.terrain.normal(state.position.x,state.position.z,state.position.y));
      normal.lerp(new THREE.Vector3(0,1,0),0.3).normalize();
      forward.set(-Math.sin(motion.heading),0,-Math.cos(motion.heading));right.crossVectors(normal,forward).normalize();forward.crossVectors(right,normal).normalize();
      rotationMatrix.makeBasis(right,normal,forward);rotation.setFromRotationMatrix(rotationMatrix);
      if(state.vehicleMotion)rotation.copy(state.vehicleMotion.orientation).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),Math.PI));
      car.quaternion.slerp(rotation,1-Math.exp(-dt*12));
      renderVehicleWheels(car,state.vehicleMotion,chassis,campaignAssets.tuning[carId]);
      car.visible=paused||cameraMode!==2;
    }
    if(onFoot&&character){character.group.position.copy(motion.position);character.group.rotation.y+=THREE.MathUtils.euclideanModulo(footHeading-character.group.rotation.y+Math.PI,Math.PI*2)-Math.PI;}
    if(campaign?.playerAnimation)character?.play(campaign.playerAnimation);character?.update(paused?dt*0.35:dt);
    if(car&&onFoot)car.visible=!campaign?.interior;if(coins)coins.mesh.visible=!campaign?.interior;if(traffic)traffic.group.visible=!campaign?.interior;sound.cinematic=!!campaign?.presentation.active;
    if(coins){const gained=coins.update(frozen?0:dt,state.position,!frozen&&!campaign?.interior,!onFoot);if(gained){if(campaign){campaign.engine.earn(gained);campaign.progress.coins[String(level)]=coins.entries;}else freeMoney+=gained;sound.coin();saveGame();toast(`+${gained} coin${gained===1?'':'s'}`);}element('coin-count').textContent=String(campaign?.progress.money??freeMoney);}
    const worldStart=performance.now();world.update(state.position);const worldMs=performance.now()-worldStart;metrics.record(frameMs,worldMs);updateCamera(dt);
    if(now-metricTime>500){metricText=metrics.summary();metricTime=now;}
    hud.update(dt,state,world.data,challenge,traffic);nativeHUD.draw(dt,state,world.data,challenge,traffic,hud.bigMap,onFoot);
    if(debug)element('debug').textContent=`${fps} FPS · ${renderer.info.render.calls} draws · ${renderer.info.render.triangles.toLocaleString()} triangles\nposition ${state.position.x.toFixed(1)}, ${state.position.y.toFixed(1)}, ${state.position.z.toFixed(1)} · speed ${state.speed.toFixed(2)}\nlevel ${level} · ${carId} · ${paused?'paused':'driving'} · ${renderer.info.memory.geometries} geometries · ${renderer.info.memory.textures} textures\n${metricText}`;
  }
  renderer.info.reset();
  if(paused&&!loading&&nativeMenu?.mode==='splash'){
    // The splash screen is the full-frame logo; nothing should show around its edges.
    renderer.setScissorTest(false);renderer.setClearColor(0x000000);renderer.clear();
  }else if(paused&&!loading&&menuRoom&&nativeMenu?.mode!=='pause'){
    const width=Math.min(innerWidth,innerHeight*4/3),height=width*.75;
    renderer.setScissorTest(false);renderer.setClearColor(0x000000);renderer.clear();renderer.setViewport((innerWidth-width)/2,(innerHeight-height)/2,width,height);renderer.setScissor((innerWidth-width)/2,(innerHeight-height)/2,width,height);renderer.setScissorTest(true);
    menuRoom.actor?.update(dt);renderer.render(menuRoom.scene,menuRoom.camera);renderer.setScissorTest(false);renderer.setViewport(0,0,innerWidth,innerHeight);
  }else if(highQuality)composer.render();else renderer.render(scene,camera);
}
function placePlayer(position:Vec3,heading:number,foot:boolean,parked?:Vec3){
  state.position.fromArray(position);state.heading=heading;state.speed=0;state.verticalSpeed=0;state.steer=0;state.grounded=false;walking.reset(heading);resetVehicle(state);cruise=false;onFoot=foot;footHeading=heading;cameraYaw=heading;
  if(parked)parkedPosition.fromArray(parked);else if(!foot)parkedPosition.copy(state.position);parkedHeading=heading;
  if(car){car.position.copy(foot?parkedPosition:state.position);car.position.y+=carOffset;car.rotation.y=heading+Math.PI;car.visible=true;}
  if(character&&car){if(foot)character.walk(scene,state.position,heading);else character.drive(car);}
  motion.reset(state);smoothLook.copy(state.position);updateCamera(1,true);
}
async function changeSkin(id:string){
  const asset=campaignAssets.characters[id]??id;const next=new Character();await next.load(world.assets,asset);character?.dispose();character=next;
  if(onFoot)character.walk(scene,state.position,state.heading);else character.drive(car!);
}
function saveGame(){
  try{if(campaign&&coins)campaign.progress.coins[String(level)]=coins.entries;
    localStorage.setItem('hit-and-run:save',JSON.stringify({version:2,level,car:carId,position:state.position.toArray(),heading:state.heading,onFoot,parkedPosition:parkedPosition.toArray(),parkedHeading,money:freeMoney,campaign:campaign?.progress??null}));
  }catch{toast('Could not save in this browser.');}
}
async function startCampaign(saved?:Progress,location?:{position:Vec3;heading:number;onFoot:boolean;parkedPosition:Vec3}){
  const progressState=saved??newProgress(),newChapter=!saved||!saved.mission;lock(true);paused=true;element('loading').hidden=false;progress(.92,'Loading the mission…');
  try{
    if(level!==progressState.level)await loadLevel(progressState.level);campaign?.dispose();campaign=undefined;world.leaveInterior();
    campaign=await Campaign.create(world,level,progressState,{
      player:()=>({state,onFoot,vehicle:carId,parkedPosition,parkedHeading,footprint}),place:placePlayer,vehicle:setCar,skin:changeSkin,
      chapter:async(next,progressState)=>{await loadLevel(next);progressState.mission='';progressState.stage=0;progressState.phase='intro';progressState.equippedSkin=null;await startCampaign(progressState);},toast,traffic:limit=>{if(traffic)traffic.limit=limit;},save:saveGame,law:police
    });
    if(newChapter){const initial=arg(campaign.data.initial,'InitLevelPlayerVehicle');await setCar(String(initial[0]));state.damage=0;}
    coins?.reset(progressState.coins[String(level)]??[]);world.objects.reset(progressState.brokenProps?.[String(level)]??[]);await campaign.start(progressState.mission,!!saved&&!newChapter);

    if(progressState.equippedSkin)await changeSkin(progressState.equippedSkin);
    lock(false);element('loading').hidden=true;pause(false);element('mode-badge').textContent='STORY';if(!saved)void campaign.presentation.playMovie('campaign/movies/fmv1a.mp4');
  }catch(error){console.error(error);lock(false);element('loading').hidden=true;pause(true);nativeMenu?.notice(error instanceof Error?error.message:String(error));}
}
async function loadGame(){
  let saved;try{saved=JSON.parse(localStorage.getItem('hit-and-run:save')??'null');}catch{}
  const vector=(p:unknown):p is Vec3=>Array.isArray(p)&&p.length===3&&p.every(Number.isFinite);
  if(!saved){nativeMenu?.notice('NO SAVED GAME');return;}
  if(!catalog.levels.includes(saved.level)||!catalog.cars.includes(saved.car)||!vector(saved.position)||!Number.isFinite(saved.heading)){nativeMenu?.notice('THIS SAVE IS NOT VALID');return;}
  carId=saved.car;await loadLevel(saved.level);
  if(saved.campaign&&validateProgress(saved.campaign))await startCampaign(saved.campaign,{position:saved.position,heading:saved.heading,onFoot:!!saved.onFoot,parkedPosition:vector(saved.parkedPosition)?saved.parkedPosition:saved.position});
  else{if(Number.isFinite(saved.money)&&saved.money>=0)freeMoney=saved.money;placePlayer(saved.position,saved.heading,false);pause(false);}
}
play.addEventListener('click',()=>pause(false),options);
run.addEventListener('click',startChallenge,options);
element('pause').addEventListener('click',()=>pause(true),options);
levelSelect.addEventListener('change',()=>void loadLevel(Number(levelSelect.value)),options);
carSelect.addEventListener('change',async()=>{lock(true);try{await setCar(carSelect.value);respawn(Number(locationSelect.value));}catch(error){console.error(error);toast('That car could not be loaded.');}finally{lock(false);}},options);
locationSelect.addEventListener('change',()=>{if(onFoot){onFoot=false;character?.drive(car!);}challenge.stop();respawn(Number(locationSelect.value));element('menu-place').textContent=world.data.locations[Number(locationSelect.value)].name;},options);
lighting.addEventListener('change',()=>world.setLighting(lighting.value),options);
element('sound').addEventListener('click',async()=>{const enabled=await sound.toggle();element('sound').textContent=enabled?'SOUND ON':'SOUND OFF';element('sound').setAttribute('aria-pressed',String(enabled));},options);
element('quality').addEventListener('click',()=>{highQuality=!highQuality;renderer.shadowMap.enabled=highQuality;renderer.setPixelRatio(Math.min(devicePixelRatio,highQuality?2:1));composer.setPixelRatio(renderer.getPixelRatio());element('quality').textContent=highQuality?'HIGH QUALITY':'PERFORMANCE';},options);
element('fullscreen').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{toast('Fullscreen is unavailable in this browser.');}},options);
window.addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);composer.setSize(innerWidth,innerHeight);},options);
window.addEventListener('blur',()=>{if(!paused&&!loading)pause(true);},options);
document.addEventListener('visibilitychange',()=>{if(document.hidden&&!paused&&!loading)pause(true);},options);
renderer.domElement.addEventListener('webglcontextlost',event=>{event.preventDefault();pause(true);element('loading').hidden=false;progress(0,'The graphics context was interrupted. Reload to reconnect.');},options);
renderer.setAnimationLoop(animate);
async function init(){
  try{
    // The menu art, catalogue and campaign index have no dependencies, so they download together.
    const artReady=originalArt.load();const catalogReady=Promise.all([json<Catalog>('catalog.json'),json<CampaignAssets>('campaign/assets.json')]);
    await artReady;
    const nativeOptions=document.createElement('section');nativeOptions.id='native-options';nativeOptions.hidden=true;
    const settings=document.querySelector('.settings-grid')!,footer=document.querySelector('.menu-footer')!;
    nativeOptions.append(settings,footer);(settings as HTMLElement).hidden=false;(footer as HTMLElement).hidden=false;element('menu').append(nativeOptions);
    for(const label of settings.querySelectorAll('label')){
      const text=[...label.childNodes].find(n=>n.nodeType===Node.TEXT_NODE);const span=document.createElement('span');span.className='native-label';span.dataset.text=text?.textContent?.trim()??'';text?.remove();label.prepend(span);label.querySelector('select')?.setAttribute('aria-label',span.dataset.text);
    }
    nativeMenu=new OriginalMenu({start:()=>pause(false),newGame:()=>void startCampaign(),missions:()=>campaign?campaign.data.missions.filter(m=>!m.transition).map(m=>({title:m.title,enabled:!!m.optional||m.id===campaign!.progress.mission||campaign!.progress.completed.includes(`${level}:${m.id}`),select:()=>{void campaign!.start(m.id).then(()=>pause(false));}})):[],run:startChallenge,main:()=>{},
      save:()=>{saveGame();nativeMenu?.notice('GAME SAVED');},
      load:()=>void loadGame()
    });nativeMenu.show('splash');
    [catalog,campaignAssets]=await catalogReady;Object.assign(CAR_NAMES,catalog.carNames??{});carSelect.replaceChildren(...catalog.cars.map(id=>new Option(CAR_NAMES[id]??id,id)));
    // The menu room and the first level share no state, so they load side by side.
    const room=new FrontendRoom(catalog);await Promise.all([room.load().then(()=>{menuRoom=room;}),loadLevel(1)]);}
  catch(error){console.error(error);progress(0,'Game assets are missing. Run npm run extract and npm run convert, then reload.');}
}
void init();
const removeDevTools=devTools(input,{place:value=>{const parts=value.trim().split(/\s+/),numbers=parts.slice(0,4).map(Number);if(numbers.length!==4||numbers.some(n=>!Number.isFinite(n))||!['foot','car'].includes(parts[4]))throw new Error('Use x y z heading-degrees foot/car');placePlayer(numbers.slice(0,3) as Vec3,THREE.MathUtils.degToRad(numbers[3]),parts[4]==='foot',parkedPosition.toArray());},scenario:async(value)=>{const [chapter,mission,phase,stage]=value.split(':');const p=newProgress();p.level=Number(chapter);p.mission=mission;p.phase=phase==='main'?'main':'intro';p.stage=Number(stage)||0;p.checkpoint={phase:p.phase,stage:p.stage};await startCampaign(p);},state:()=>`${campaign?`${level}:${campaign.progress.mission}:${campaign.progress.phase}:${campaign.progress.stage} · ${state.position.toArray().map(n=>n.toFixed(1)).join(',')} · ${campaign.error||campaign.engine.status}`:'No campaign'} · ${onFoot?'foot':'car'} ${state.speed.toFixed(1)} m/s ${state.grounded?'ground':'air'} · jumps ${walking.jumps} · coins ${campaign?.progress.money??freeMoney} · heat ${police?.meter.heat.toFixed(1)??0} · police ${police?.cars.length??0} · nearest ${police?.audibleDistance.toFixed(1)??'-'}`,resume:()=>pause(false),retry:()=>campaign?.retry(),objective:()=>{const target=campaign?.hud.target;if(target){const p=[...target] as Vec3;p[2]-=2;placePlayer(p,0,onFoot,parkedPosition.toArray());}},pursuit:()=>police?.command({op:'SetHitAndRunMeter',args:[100],line:0}),clearPursuit:()=>police?.reset(),testCoins:()=>{if(campaign)campaign.engine.earn(75);else freeMoney+=75;}});
function dispose(){removeDevTools();campaign?.dispose();controller.abort();renderer.setAnimationLoop(null);input.dispose();sound.dispose();nativeMenu?.dispose();nativeHUD.canvas.remove();menuRoom?.dispose();coins?.dispose();character?.dispose();challenge.dispose();police?.dispose();traffic?.dispose();world?.dispose();composer.passes.forEach(pass=>pass.dispose());composer.dispose();renderer.dispose();renderer.domElement.remove();}
window.addEventListener('pagehide',dispose,{once:true});
if(import.meta.hot)import.meta.hot.dispose(dispose);
