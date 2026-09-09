import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import '../src/assets.ts';
import { Terrain,type CarState } from '../src/physics.ts';
import { staticCollisionGeometry } from '../src/collision.ts';
import { PlayerMovement,PLAYER_RULES } from '../src/player-movement.ts';
import { CoinSimulation,coinWithinReach,COIN_RULES } from '../src/coin-simulation.ts';
import type { LevelData } from '../src/assets.ts';
const idle={x:0,z:0,run:false,jump:false};
const state=():CarState=>({position:new THREE.Vector3(0,.06,0),heading:0,speed:0,verticalSpeed:0,steer:0,distance:0,damage:0,grounded:true});
function terrain(obstacle=false){
  const floor=new THREE.PlaneGeometry(100,100).rotateX(-Math.PI/2).toNonIndexed();floor.deleteAttribute('uv');floor.deleteAttribute('normal');
  const bodies=staticCollisionGeometry({version:1,source:'test',sha256:'',shapes:[{kind:'box',name:'wall',center:[0,obstacle?.5:4,2],axes:[[1,0,0],[0,1,0],[0,0,1]],halfExtents:[2,obstacle?.5:.1,.2]}]});
  const result=new Terrain([floor],{fences:[[[2,0,2],[-2,0,2],[0,0,-1]]]} as unknown as LevelData,bodies);floor.dispose();bodies.dispose();return result;
}
test('native jumping has a bounded second jump and resets only on landing',()=>{
  const world=terrain(),player=state(),movement=new PlayerMovement();let highest=0,second=false;
  for(let frame=0;frame<130;frame++){
    const request=frame===0||frame===1||frame===22||frame===23;
    movement.update(player,{...idle,jump:request},1/60,world);highest=Math.max(highest,player.position.y-.06);if(frame===22){second=movement.jumps===2;assert(player.verticalSpeed>6);}
  }
  assert(second);assert(highest>2.6&&highest<2.95,`apex ${highest}`);assert.equal(movement.jumps,0);assert(player.grounded);world.dispose();
});
test('single jump uses the native height instead of testing velocity at the apex for grounding',()=>{
  const world=terrain(),player=state(),movement=new PlayerMovement();let highest=0;
  for(let frame=0;frame<90;frame++){movement.update(player,{...idle,jump:frame===0},1/60,world);highest=Math.max(highest,player.position.y-.06);}
  assert(highest>1.8&&highest<=PLAYER_RULES.jumpHeight);assert(player.grounded);world.dispose();
});
test('the player can jump over a finite wall that blocks walking',()=>{
  const world=terrain(true),player=state(),movement=new PlayerMovement();
  for(let frame=0;frame<60;frame++)movement.update(player,{...idle,z:1},1/60,world);
  assert(player.position.z<1.6);player.position.set(0,.06,.3);player.grounded=true;movement.reset();
  for(let frame=0;frame<90;frame++)movement.update(player,{...idle,z:1,jump:frame===0||frame===22},1/60,world);
  assert(player.position.z>3,`blocked at ${player.position.toArray()}`);assert(player.position.y>.04);world.dispose();
});
test('walking reports the facing that the radar arrow and camera read',()=>{
  const world=terrain(),player=state(),movement=new PlayerMovement();
  for(let frame=0;frame<20;frame++)movement.update(player,{...idle,z:1},1/60,world,0);
  assert(Math.abs(player.heading)<1e-6,`walking away faces ${player.heading}`);
  for(let frame=0;frame<20;frame++)movement.update(player,{...idle,z:-1},1/60,world,0);
  assert(Math.abs(Math.abs(player.heading)-Math.PI)<1e-6,`walking back faces ${player.heading}`);
  assert(movement.velocity.z<-1,`walking back moves ${movement.velocity.z}`);world.dispose();
});
test('a held key keeps its world direction while the camera swings behind',()=>{
  const world=terrain(),player=state(),movement=new PlayerMovement();
  let cameraYaw=0;const headings:number[]=[];
  for(let frame=0;frame<90;frame++){
    movement.update(player,{...idle,z:-1},1/60,world,cameraYaw);
    headings.push(movement.heading);
    cameraYaw+=(THREE.MathUtils.euclideanModulo(movement.heading-cameraYaw+Math.PI,Math.PI*2)-Math.PI)*(1-Math.exp(-2.2/60));
  }
  const drift=Math.max(...headings.map(h=>Math.abs(THREE.MathUtils.euclideanModulo(h-headings[0]+Math.PI,Math.PI*2)-Math.PI)));
  assert(drift<1e-6,`the walk curved by ${drift} radians`);
  const behind=Math.abs(THREE.MathUtils.euclideanModulo(cameraYaw-movement.heading+Math.PI,Math.PI*2)-Math.PI);
  assert(behind<.2,`camera stopped ${behind} radians off the walk`);
  world.dispose();
});
test('world support checks do not select a ceiling above the player',()=>{
  const world=terrain();assert(Math.abs(world.support(0,2,.06)!.point.y)<.001);assert(Math.abs(world.support(0,2,4.2)!.point.y-4.1)<.001);world.dispose();
});
test('jumping onto a vehicle lands on its roof and moves with it',()=>{
  const world=terrain(),player=state(),movement=new PlayerMovement(),platform={id:'car',position:new THREE.Vector3(0,0,3),heading:0,half:new THREE.Vector3(.9,.65,1.7),center:new THREE.Vector3(0,.9,0)};
  world.setVehiclePlatforms([platform]);
  for(let i=0;i<60;i++)movement.update(player,{...idle,z:i<32?1:0,jump:i===0||i===22},1/60,world);
  assert(player.grounded);assert.equal(player.supportVehicle,'car');assert(player.position.y>1.5);const x=player.position.x;
  platform.position.x+=1;world.setVehiclePlatforms([platform]);movement.update(player,idle,1/60,world);assert(Math.abs(player.position.x-x-1)<.02);world.dispose();
});
test('coin collection uses native height and diamond bounds, including car reach',()=>{
  const origin=new THREE.Vector3();assert(coinWithinReach(new THREE.Vector3(2,1,.5),origin,false));assert(!coinWithinReach(new THREE.Vector3(2,1,2),origin,false));
  assert(coinWithinReach(new THREE.Vector3(4,1,1),origin,true));assert(!coinWithinReach(new THREE.Vector3(0,2.25,0),origin,true));
});
test('coins reach the wallet once after attraction and retain trail collection across reset',()=>{
  const coins=new CoinSimulation([new THREE.Vector3(1,1,0)],()=>.5),position=new THREE.Vector3();
  assert.equal(coins.update(.1,position,false),0);let earned=0;for(let i=0;i<8;i++)earned+=coins.update(.1,position,false);
  assert.equal(earned,1);assert.deepEqual([...coins.found],[0]);coins.reset([...coins.found]);assert.equal(coins.update(.1,position,false),0);
});
test('loose coins bounce, expire, and credit a full-pool overflow without loss',()=>{
  const coins=new CoinSimulation([],()=>.5),origin=new THREE.Vector3(0,1,0),far=new THREE.Vector3(50,0,50);
  assert.equal(coins.drop(COIN_RULES.poolSize+3,origin,.5),3);let bounced=false;
  for(let i=0;i<170;i++){coins.update(.1,far,false);if(coins.coins[0].velocity.y>0&&!coins.coins[0].airborne)bounced=true;}
  assert(bounced);assert(coins.coins.every(c=>!c.active));
});
