import * as THREE from 'three';
import type { CarState,Terrain } from './physics';

// PAL CharacterManager 0x26e9f0, WalkerLocomotionAction 0x121438,
// JumpAction 0x1248f0 / 0x125b38, and jump dispatch 0x107f60.
export const PLAYER_RULES={walkSpeed:4,runSpeed:8,acceleration:20,deceleration:10,gravity:25,jumpHeight:1.9,doubleJumpHeight:1,doubleJumpUpSpeed:2,doubleJumpFallSpeed:12,airSpeed:4,airAcceleration:Math.fround(.078)*60,stompGravityScale:Math.fround(3.22)};
export interface WalkingControls {x:number;z:number;run:boolean;jump:boolean}
export class PlayerMovement {
  readonly velocity=new THREE.Vector3();heading=0;jumps=0;stomping=false;
  private wasGrounded=false;
  /** Camera yaw sampled when the movement keys last changed. A held key keeps its world direction while the camera swings. */
  private frame=0;private held={x:0,z:0};
  reset(heading=0){this.velocity.set(0,0,0);this.heading=heading;this.jumps=0;this.stomping=false;this.wasGrounded=false;this.frame=heading;this.held.x=0;this.held.z=0;}
  kick(){if(this.jumps===2)this.stomping=true;}
  update(state:CarState,controls:WalkingControls,dt:number,terrain:Terrain,cameraYaw=state.heading){
    terrain.carry(state);
    const previous=state.position.clone();
    if(state.grounded){this.jumps=0;this.stomping=false;}
    if(controls.jump){
      const second=this.jumps===1&&state.verticalSpeed<=PLAYER_RULES.doubleJumpUpSpeed&&state.verticalSpeed>=-PLAYER_RULES.doubleJumpFallSpeed;
      if(state.grounded||second){
        state.verticalSpeed=Math.sqrt(2*PLAYER_RULES.gravity*(second?PLAYER_RULES.doubleJumpHeight:PLAYER_RULES.jumpHeight));
        this.jumps=second?2:1;state.grounded=false;
      }
    }
    const magnitude=Math.min(1,Math.hypot(controls.x,controls.z));
    const speed=magnitude*(state.grounded?(controls.run?PLAYER_RULES.runSpeed:PLAYER_RULES.walkSpeed):PLAYER_RULES.airSpeed);
    if(controls.x!==this.held.x||controls.z!==this.held.z){this.frame=cameraYaw;this.held.x=controls.x;this.held.z=controls.z;}
    const direction=this.frame-Math.atan2(controls.x,controls.z);
    const desired=new THREE.Vector3(Math.sin(direction)*speed,0,Math.cos(direction)*speed);
    const delta=desired.sub(this.velocity),rate=state.grounded?(speed>this.velocity.length()?PLAYER_RULES.acceleration:PLAYER_RULES.deceleration):PLAYER_RULES.airAcceleration;
    if(delta.length()>rate*dt)delta.setLength(rate*dt);this.velocity.add(delta);
    if(!state.grounded&&this.velocity.length()>PLAYER_RULES.airSpeed)this.velocity.setLength(PLAYER_RULES.airSpeed);
    if(this.stomping)this.velocity.set(0,0,0);
    if(magnitude)this.heading=direction;
    state.heading=this.heading;
    state.position.addScaledVector(this.velocity,dt);
    terrain.resolve(state,previous,dt,.35,true,PLAYER_RULES.gravity*(this.stomping?PLAYER_RULES.stompGravityScale:1));
    const travelled=state.position.clone().sub(previous);travelled.y=0;state.speed=travelled.length()/dt;state.distance+=travelled.length();
    if(state.grounded&&!this.wasGrounded){this.jumps=0;this.stomping=false;}
    this.wasGrounded=!!state.grounded;
    return this.stomping?'hom_jump_kick':!state.grounded?(this.jumps===2?'hom_jump_dash_in_air':'hom_jump_idle_in_air'):state.speed>4.1?'hom_loco_run':state.speed>.1?'hom_loco_walk':'hom_loco_idle_rest';
  }
}
