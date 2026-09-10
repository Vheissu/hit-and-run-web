import type { CampaignHUD } from './campaign/runtime';
import type { PursuitHUD } from './pursuit';
import * as THREE from 'three';
import { Assets,assetURL,json,type Catalog,type LevelData } from './assets';
import type { CarState } from './physics';
import type { Challenge } from './challenge';
import type { Traffic } from './traffic';
import { element } from './hud';
import { Character } from './character';
interface Glyph{x:number;y:number;width:number;height:number;advance:number;left:number}
interface Font{file:string;size:number;height:number;baseline:number;glyphs:Record<string,Glyph>}
const source=assetURL('ui/');
export class OriginalArt {
  images=new Map<string,HTMLImageElement>();private textCache=new Map<string,{canvas:HTMLCanvasElement;width:number}>();fonts:Record<string,Font>={};layouts:Record<string,any[]>={};ready=false;
  async load(){
    this.fonts=await json<Record<string,Font>>('ui/fonts.json');this.layouts=await json<Record<string,any[]>>('ui/layouts.json');
    const names=['gamelogo.png','tvframe.png','larrow.png','rarrow.png','accept.png','back.png','radar.png','radartop.png','hrmetter.png','hrsector.png','hrticket.png','hitnrun0.png','hitnrun1.png','hitnrun2.png','damage.png','greybar.png','coins.png','user.png','aicar.png','mission.png','phone.png','checkflag.png','collect.png','helptext.png','frame_t.png','frame_b.png','frame_l.png','frame_r.png','frame_tl.png','frame_tr.png','frame_bl.png','frame_br.png','qhomer.png','check.png',...Array.from({length:10},(_,i)=>`${i}.png`),'colon.png','slash.png',...Object.values(this.fonts).map(f=>f.file)];
    await Promise.all(names.map(name=>this.loadImage(name)));this.ready=true;
  }
  // The load event is used instead of decode(): Chrome can defer decode() of a detached image for a very long time.
  async loadImage(name:string){if(this.images.has(name))return this.images.get(name)!;const image=new Image();image.decoding='async';image.src=source+name;await new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(new Error(`Could not load ${name}`));});this.images.set(name,image);return image;}
  draw(c:CanvasRenderingContext2D,name:string,x:number,y:number,w?:number,h?:number){const image=this.images.get(name);if(image)c.drawImage(image,x,y,w??image.width,h??image.height);}
  text(c:CanvasRenderingContext2D,text:string,x:number,y:number,size=24,align:'left'|'center'|'right'='left',color='#fff'){
    const font=this.fonts.boulder_24;if(!font)return;const image=this.images.get(font.file);if(!image)return;
    const cacheKey=JSON.stringify([text,size,color]);let cached=this.textCache.get(cacheKey);
    if(!cached){
      const factor=size/font.size,glyphs=[...text].map(char=>font.glyphs[char]??font.glyphs['?']);const width=glyphs.reduce((a,g)=>a+g.advance*factor,0);
      const scratch=document.createElement('canvas');scratch.width=Math.max(1,Math.ceil(width+8));scratch.height=Math.ceil(font.height*factor+4);const ctx=scratch.getContext('2d')!;let cursor=0;ctx.imageSmoothingEnabled=false;
      for(const glyph of glyphs){ctx.drawImage(image,glyph.x,glyph.y,glyph.width,glyph.height,cursor+glyph.left*factor,0,glyph.width*factor,glyph.height*factor);cursor+=glyph.advance*factor;}
      ctx.globalCompositeOperation='source-in';ctx.fillStyle=color;ctx.fillRect(0,0,scratch.width,scratch.height);cached={canvas:scratch,width};this.textCache.set(cacheKey,cached);
      if(this.textCache.size>256)this.textCache.delete(this.textCache.keys().next().value!);
    }
    const {canvas:scratch,width}=cached;if(align==='center')x-=width/2;if(align==='right')x-=width;
    c.save();c.shadowColor='#000';c.shadowBlur=0;c.shadowOffsetX=2;c.shadowOffsetY=2;c.drawImage(scratch,x,y);c.restore();return width;
  }
  label(button:HTMLElement,text:string,size=22,width=280,height=Math.ceil(size*1.4+8)){
    button.setAttribute('aria-label',text);const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;canvas.style.width='100%';canvas.style.height='100%';
    this.text(canvas.getContext('2d')!,text,width/2,Math.max(0,(height-size*1.2)/2),size,'center');button.replaceChildren(canvas);
  }
  digits(c:CanvasRenderingContext2D,text:string,x:number,y:number,height=38){
    const chars=[...text].map(char=>char===':'?'colon.png':char==='/'?'slash.png':`${char}.png`);const width=chars.reduce((w,name)=>w+(this.images.get(name)?.width??20)*height/50,0);
    for(const name of chars){const im=this.images.get(name);if(!im)continue;const w=im.width*height/im.height;c.drawImage(im,x,y,w,height);x+=w*.8;}
    return width;
  }
}
export const originalArt=new OriginalArt();
export class OriginalHUD {
  campaign:CampaignHUD|null=null;pursuit?:PursuitHUD;canvas=document.createElement('canvas');private c=this.canvas.getContext('2d')!;private time=0;
  constructor(){this.canvas.id='original-hud';this.canvas.setAttribute('role','img');element('hud').append(this.canvas);}
  /** Draws a target on the radar, pinned to the rim with an arrow when it lies beyond the radar's range. */
  private marker(c:CanvasRenderingContext2D,cx:number,cy:number,zoom:number,state:CarState,p:ArrayLike<number>){
    const dx=(p[0]-state.position.x)*zoom,dy=(p[2]-state.position.z)*zoom,d=Math.hypot(dx,dy),rim=43;
    if(d<=rim){originalArt.draw(c,'mission.png',cx+dx-6,cy+dy-6,12,12);return;}
    const ux=dx/d,uy=dy/d;
    c.save();c.translate(cx+ux*52,cy+uy*52);c.rotate(Math.atan2(uy,ux));c.fillStyle='#ffe02a';c.strokeStyle='#1b1b1b';c.lineWidth=1.5;c.beginPath();c.moveTo(6,0);c.lineTo(-4,-6);c.lineTo(-4,6);c.closePath();c.fill();c.stroke();c.restore();
    originalArt.draw(c,'mission.png',cx+ux*rim-7,cy+uy*rim-7,14,14);
  }
  draw(dt:number,state:CarState,data:LevelData,challenge:Challenge,traffic:Traffic|undefined,bigMap=false,onFoot=false){
    if(!originalArt.ready)return;this.time+=dt;
    const dpr=Math.min(devicePixelRatio,2),width=innerWidth,height=innerHeight;
    if(this.canvas.width!==width*dpr||this.canvas.height!==height*dpr){this.canvas.width=width*dpr;this.canvas.height=height*dpr;}
    const scale=Math.min(width/640,height/480),w=width/scale,h=height/scale,c=this.c;
    c.setTransform(dpr*scale,0,0,dpr*scale,0,0);c.clearRect(0,0,w,h);c.imageSmoothingEnabled=true;
    const x=w-186,y=h-176,cx=x+76,cy=y+76;
    originalArt.draw(c,'radar.png',x,y,152,152);
    c.save();c.beginPath();c.arc(cx,cy,51,0,Math.PI*2);c.clip();c.translate(cx,cy);c.scale(bigMap?.17:.58,bigMap?.17:.58);c.translate(-state.position.x,-state.position.z);
    c.strokeStyle='#86cc73';c.lineWidth=7;c.lineCap='round';c.beginPath();for(const [a,b] of data.roads){c.moveTo(a[0],a[2]);c.lineTo(b[0],b[2]);}c.stroke();
    c.fillStyle='#ffca17';for(const vehicle of traffic?.cars??[])if(vehicle.active){c.beginPath();c.arc(vehicle.mesh.position.x,vehicle.mesh.position.z,3,0,Math.PI*2);c.fill();}
    for(const position of this.pursuit?.cars??[]){c.fillStyle=Math.sin(this.time*10)>0?'#ff2626':'#315eff';c.beginPath();c.arc(position.x,position.z,6,0,Math.PI*2);c.fill();originalArt.draw(c,'aicar.png',position.x-6,position.z-6,12,12);}
    c.restore();
    const heat=this.pursuit?.heat??0;
    if(heat>0){c.save();c.beginPath();c.moveTo(cx,cy);c.arc(cx,cy,70,-Math.PI/2,-Math.PI/2+Math.PI*2*heat/100);c.closePath();c.clip();originalArt.draw(c,'hrmetter.png',x,y,152,152);c.restore();}
    originalArt.draw(c,'radartop.png',x+4,y,150,150);
    originalArt.draw(c,this.pursuit?.active?(Math.sin(this.time*10)>0?'hitnrun2.png':'hitnrun1.png'):heat>78?'hitnrun1.png':'hitnrun0.png',x+40,y+9,73,30);
    const zoom=bigMap?.17:.58;
    if(this.campaign?.target)this.marker(c,cx,cy,zoom,state,this.campaign.target);
    if(challenge.active)this.marker(c,cx,cy,zoom,state,challenge.route[challenge.index].position);
    c.save();c.translate(cx,cy);c.rotate(Math.PI-state.heading);originalArt.draw(c,'user.png',-9,-11,19,22);c.restore();
    const count=element('coin-count').textContent?.split('/')[0].trim()??'0';originalArt.draw(c,'coins.png',w-180,31,39,34);originalArt.digits(c,count,w-135,21,44);
    // The damage frame and fill use the original Hud.pag coordinates and artwork.
    if(!onFoot){
      originalArt.draw(c,'greybar.png',144,56,117,23);c.save();c.beginPath();c.rect(144,56,117*state.damage/100,23);c.clip();c.filter='sepia(1) saturate(8) hue-rotate(315deg)';originalArt.draw(c,'greybar.png',144,56,117,23);c.restore();originalArt.draw(c,'damage.png',140,54,129,30);
    }
    if(challenge.active){originalArt.draw(c,'checkflag.png',35,48,42,42);originalArt.digits(c,element('timer').textContent??'',86,23,40);originalArt.text(c,challenge.route[challenge.index].name,35,103,16);}
    if(this.campaign){
      const mission=this.campaign;originalArt.text(c,mission.title,w/2,20,16,'center');
      const words=(mission.failure||mission.message).split(/\s+/);let line='',lines:string[]=[];for(const word of words){if((line+' '+word).trim().length>49){lines.push(line);line=word;}else line=(line+' '+word).trim();}if(line)lines.push(line);
      lines.slice(0,3).forEach((line,i)=>originalArt.text(c,line,w/2,96+i*19,15,'center',mission.failure?'#ffda1c':'#fff'));
      if(mission.remaining!==null){const seconds=Math.max(0,Math.ceil(mission.remaining));originalArt.digits(c,`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`,35,29,40);}
      if(mission.items)originalArt.text(c,`${mission.collected} / ${mission.items}`,w/2,161,20,'center');
      if(mission.countdown>0)originalArt.digits(c,String(Math.ceil(mission.countdown)),w/2-16,h*.4,60);
      if(mission.targetHealth!==undefined){c.fillStyle='#171d4b';c.fillRect(w/2-65,165,130,12);c.fillStyle='#e14432';c.fillRect(w/2-65,165,130*mission.targetHealth,12);}
      originalArt.text(c,mission.hint,w/2,h-31,12,'center');
    }
    const message=element('toast');if(message.classList.contains('visible')){originalArt.draw(c,'helptext.png',(w-330)/2,h*.26,330,88);originalArt.text(c,(message.textContent??'').slice(0,50),w/2,h*.26+25,13,'center');}
    if(this.pursuit&&this.pursuit.busted>0){originalArt.draw(c,'hrticket.png',w/2-38,h*.33,76,98);originalArt.text(c,'BUSTED!',w/2,h*.33+102,30,'center','#ffe02a');originalArt.text(c,`-${this.pursuit.fine} COINS`,w/2,h*.33+141,20,'center');}
    this.canvas.setAttribute('aria-label',`Original HUD. ${count} coins. ${Math.round(100-state.damage)} percent vehicle condition. ${Math.round(Math.abs(state.speed)*3.6)} kilometres per hour. Hit and Run heat ${Math.round(heat)} percent. ${this.pursuit?.active?`${this.pursuit.cars.length} police vehicles pursuing.`:''}${this.pursuit?.busted?` BUSTED. ${this.pursuit.fine} coins lost.`:''}${this.campaign?` Mission: ${this.campaign.title}. ${this.campaign.failure||this.campaign.message}. ${this.campaign.hint}`:''}`);
  }
}

export class FrontendRoom {
  actor:Character|undefined;scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(50,4/3,.1,100);assets:Assets;
  constructor(catalog:Catalog){
    this.assets=new Assets(catalog);this.scene.background=new THREE.Color(0x181028);
    this.scene.add(new THREE.HemisphereLight(0xffe8d0,0x60444b,2.5));const key=new THREE.DirectionalLight(0xffdab5,2);key.position.set(2,5,-3);this.scene.add(key);
    this.camera.position.set(2.888,2.13,-4.573);this.camera.lookAt(2.483,1.91,-3.685);
  }
  async load(){const asset=await this.assets.load('frontend-room');this.scene.add(asset.root);this.actor=new Character();await this.actor.load(this.assets,'menu-homer');this.scene.add(this.actor.group);}
  dispose(){this.actor?.dispose();this.assets.dispose();this.scene.clear();}
}
interface MenuCallbacks {newGame:()=>void;missions:()=>{title:string;enabled:boolean;select:()=>void}[];start:()=>void;run:()=>void;save:()=>void;load:()=>void;main:()=>void}
export class OriginalMenu {
  mode:'splash'|'main'|'pause'|'options'|'cards'|'progress'|'missions'='splash';private stage:HTMLDivElement;private actions:HTMLDivElement;private index=0;private previous:'main'|'pause'='main';private callbacks:MenuCallbacks;private controller=new AbortController();
  constructor(callbacks:MenuCallbacks){
    this.callbacks=callbacks;this.stage=document.createElement('div');this.stage.className='original-stage';this.stage.innerHTML='<canvas class="original-board" width="640" height="480"></canvas><img class="original-tv" src="/assets/ui/tvframe.png" alt="Original TV frame"><img class="original-logo" src="/assets/ui/gamelogo.png" alt="The Simpsons Hit and Run"><div class="original-actions"></div><button class="original-back" aria-label="Back"><img src="/assets/ui/back.png" alt=""> BACK</button><div class="original-note"></div>'.replaceAll('/assets/ui/',source);
    element('menu').append(this.stage);
    const board=this.stage.querySelector<HTMLCanvasElement>('.original-board')!.getContext('2d')!;board.fillStyle='rgba(3,15,75,.82)';board.fillRect(60,50,517,376);
    for(const [name,x,y,w,h] of [['frame_t.png',88,44,461,12],['frame_b.png',88,428,461,12],['frame_l.png',50,84,13,316],['frame_r.png',574,84,13,316],['frame_tl.png',50,44,38,40],['frame_tr.png',549,44,38,40],['frame_bl.png',50,400,38,40],['frame_br.png',549,400,38,40]] as [string,number,number,number,number][])originalArt.draw(board,name,x,y,w,h);
    this.actions=this.stage.querySelector('.original-actions')!;
    for(const button of element('native-options').querySelectorAll<HTMLButtonElement>('button')){
      const observer=new MutationObserver(()=>{if(button.firstElementChild?.tagName!=='CANVAS')originalArt.label(button,button.textContent?.trim()??'',15);});observer.observe(button,{childList:true,characterData:true,subtree:true});this.controller.signal.addEventListener('abort',()=>observer.disconnect());
    }
    this.stage.querySelector('.original-back')!.addEventListener('click',()=>this.back());
    window.addEventListener('keydown',e=>{
      if(element('menu').hidden||!originalArt.ready)return;
      if(e.target instanceof HTMLSelectElement)return;
      if(this.mode==='splash'&&e.code==='Enter'){e.preventDefault();this.show('main');return;}// Prevent the same key press from also activating the newly focused NEW GAME button.
      if(this.mode==='main'&&['ArrowLeft','ArrowRight'].includes(e.code)){e.preventDefault();this.index=(this.index+(e.code==='ArrowRight'?1:5))%6;this.show('main');}
    },{signal:this.controller.signal});
  }
  button(text:string,action:()=>void,size=23){const button=document.createElement('button');button.className='original-button';originalArt.label(button,text,size);button.addEventListener('click',action);return button;}
  show(mode:OriginalMenu['mode']){
    if(mode==='main'||mode==='pause')this.previous=mode;this.mode=mode;this.stage.dataset.mode=mode;this.actions.replaceChildren();
    this.stage.querySelector('.original-note')!.textContent='';
    const options=element('native-options');options.hidden=mode!=='options';
    if(mode==='splash'){
      const start=this.button('PRESS START',()=>this.show('main'),21);start.classList.add('press-start');this.actions.append(start);
    }else if(mode==='main'){
      const entries=[['NEW GAME',this.callbacks.newGame],['LOAD GAME',this.callbacks.load],['SCRAP BOOK',()=>this.show('cards')],['OPTIONS',()=>this.show('options')],['MINI GAME',()=>this.show('missions')],['RESUME GAME',this.callbacks.start]] as const;
      const row=document.createElement('div');row.className='original-carousel';
      for(const [direction,file] of [[-1,'larrow.png'],[1,'rarrow.png']] as const){const b=document.createElement('button');b.className='original-arrow';b.setAttribute('aria-label',direction<0?'Previous menu item':'Next menu item');b.innerHTML=`<img src="${source+file}" alt="">`;b.onclick=()=>{this.index=(this.index+direction+entries.length)%entries.length;this.show('main');};if(direction<0)row.append(b);else{row.append(this.button(entries[this.index][0],entries[this.index][1],28),b);}}
      this.actions.append(row);this.stage.querySelector('.original-note')!.textContent='← → CHOOSE     ENTER / CLICK SELECT';
    }else if(mode==='pause'){
      const entries:[string,string,()=>void][]=[['CONTINUE','Continue',this.callbacks.start],['MISSION SELECT','MissionSelect',()=>this.show('missions')],['LEVEL PROGRESS','LevelProgress',()=>this.show('progress')],['VIEW CARDS','ViewCards',()=>this.show('cards')],['OPTIONS','Options',()=>this.show('options')],['SAVE GAME','SaveGame',this.callbacks.save],['QUIT GAME','QuitGame',()=>{this.callbacks.main();this.show('main');}]];
      for(const [label,name,action] of entries){
        const layout=originalArt.layouts['ingame/PauseSunday.pag'].find(row=>row.name===name);const button=this.button(label,action,16);originalArt.label(button,label,16,layout.width,layout.height);
        button.style.cssText=`position:absolute;left:${layout.x/640*100}%;top:${(480-layout.y-layout.height)/480*100}%;width:${layout.width/640*100}%;height:${layout.height/480*100}%;min-height:0`;
        this.actions.append(button);
      }
    }else if(mode==='options'){
      this.actions.append(this.button('OPTIONS',()=>{},28));
      this.stage.append(options);for(const label of options.querySelectorAll<HTMLElement>('.native-label'))originalArt.label(label,label.dataset.text??'',16);
      for(const button of options.querySelectorAll<HTMLElement>('button'))originalArt.label(button,button.getAttribute('aria-label')??button.textContent??'',15);
    }else if(mode==='cards'){
      this.actions.append(this.button('COLLECTOR CARDS',()=>{},27));const gallery=document.createElement('div');gallery.className='original-card-gallery';
      for(let i=0;i<7;i++){const img=document.createElement('img');img.src=`${source}card${String(i).padStart(2,'0')}.png`;img.alt=`Original collector card ${i+1}`;gallery.append(img);}
      this.actions.append(gallery);this.stage.querySelector('.original-note')!.textContent='ORIGINAL CARD ART FROM THE DISC';
    }else if(mode==='progress'){
      this.actions.append(this.button('LEVEL PROGRESS',()=>{},27),this.button(`COINS: ${element('coin-count').textContent??'0'}`,()=>{},21));
      this.stage.querySelector('.original-note')!.textContent='Coin progress is saved in this browser.';
    }else{
      this.actions.append(this.button('MISSION SELECT',()=>{},27));const list=document.createElement('div');list.className='campaign-actions';
      for(const mission of this.callbacks.missions()){const button=this.button(mission.title,mission.select,17);button.disabled=!mission.enabled;list.append(button);}
      list.append(this.button('SPRINGFIELD RUN',this.callbacks.run,18));this.actions.append(list);
      this.stage.querySelector('.original-note')!.textContent='Choose an unlocked mission to replay.';
    }
    this.stage.querySelector<HTMLButtonElement>('.original-back')!.hidden=mode==='splash'||mode==='main';
    this.actions.querySelector<HTMLButtonElement>('.original-button')?.focus();
  }
  dispose(){this.controller.abort();this.stage.remove();}
  back(){if(this.mode==='pause')this.callbacks.start();else this.show(this.previous);}
  notice(message:string){this.stage.querySelector('.original-note')!.textContent=message;}
}
