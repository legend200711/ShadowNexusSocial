/* ================================================================
   GRIM REAPER WIDGET  —  grim-reaper-widget.js
   Self-contained drop-in widget. Add ONE script tag to any page:
     <script src="grim-reaper-widget.js"></script>
   Automatically injects CSS link + builds DOM + starts all loops.
================================================================ */
(function(global){
'use strict';

/* ── 1. Inject stylesheet ──────────────────────────────────── */
(function(){
  var base = (function(){
    var scripts = document.querySelectorAll('script[src]');
    for(var i=scripts.length-1;i>=0;i--){
      var s=scripts[i].src;
      if(s.indexOf('grim-reaper-widget')>-1) return s.replace(/[^/\\]*$/,'');
    }
    return '';
  })();
  var link=document.createElement('link');
  link.rel='stylesheet';
  link.href=base+'grim-reaper-widget.css';
  document.head.appendChild(link);
})();

/* ── 2. Build widget DOM ───────────────────────────────────── */
function buildDOM(){
  var root=document.createElement('div');
  root.id='grim-widget-root';
  root.innerHTML=
  /* FAB button */
  '<div id="gw-fab" role="button" aria-label="Open GRIM companion" tabindex="0">'+
    '<canvas id="gw-fab-canvas" width="52" height="52"></canvas>'+
    '<div id="gw-badge"></div>'+
  '</div>'+
  /* Widget window */
  '<div id="gw-window" role="dialog" aria-label="GRIM Shadow Companion" aria-modal="true">'+
    /* Title bar */
    '<div id="gw-titlebar">'+
      '<span id="gw-titlebar-icon">☠</span>'+
      '<span id="gw-titlebar-name">GRIM</span>'+
      '<span id="gw-titlebar-sub">Shadow Companion</span>'+
      '<button class="gw-tb-btn" id="gw-settings-btn" title="Settings" aria-label="Settings">⚙</button>'+
      '<button class="gw-tb-btn" id="gw-min-btn"  title="Minimize"  aria-label="Minimize">—</button>'+
      '<button class="gw-tb-btn" id="gw-close-btn" title="Close"    aria-label="Close">✕</button>'+
    '</div>'+
    /* Character viewport */
    '<div id="gw-char-wrap">'+
      '<canvas id="gw-scene-cv"></canvas>'+
      '<canvas id="gw-char-cv"  width="420" height="380"></canvas>'+
      '<div id="gw-tone-bar">◾ <span id="gw-tone-lbl">Calm and Present</span></div>'+
    '</div>'+
    /* Chat */
    '<div id="gw-chat-section">'+
      '<div id="gw-vst"></div>'+
      '<div id="gw-chat-box" role="log" aria-live="polite"></div>'+
      '<div id="gw-api-bar">'+
        '<label for="gw-api-key-in">API KEY</label>'+
        '<input id="gw-api-key-in" type="password" placeholder="OpenRouter key (optional)" autocomplete="off" maxlength="120"/>'+
        '<span id="gw-api-status">◾ Offline</span>'+
      '</div>'+
      '<div id="gw-chips">'+
        '<span class="gw-chip" data-topic="I need to talk about mental health">🌙 Mental Health</span>'+
        '<span class="gw-chip" data-topic="I feel anxious">🌊 Anxiety</span>'+
        '<span class="gw-chip" data-topic="I feel depressed">⚫ Depression</span>'+
        '<span class="gw-chip" data-topic="I feel lonely">👁 Loneliness</span>'+
        '<span class="gw-chip" data-topic="I need motivation">⚡ Motivation</span>'+
        '<span class="gw-chip" data-topic="tell me about philosophy">📖 Philosophy</span>'+
        '<span class="gw-chip" data-topic="tell me something about history">🏛 History</span>'+
        '<span class="gw-chip" data-topic="tell me about science">🔭 Science</span>'+
        '<span class="gw-chip" data-topic="talk to me about music">🎵 Music</span>'+
        '<span class="gw-chip" data-topic="recommend a game or story">🎮 Games</span>'+
        '<span class="gw-chip" data-topic="what are your thoughts on grief">🕯 Grief</span>'+
        '<span class="gw-chip" data-topic="just talk with me">💬 Just Talk</span>'+
      '</div>'+
      '<div id="gw-controls">'+
        '<input id="gw-usr-in" type="text" placeholder="Speak or type… I am listening." maxlength="320" autocomplete="off"/>'+
        '<button id="gw-mic-btn" aria-label="Voice input">🎙</button>'+
        '<button id="gw-snd-btn" aria-label="Send">SEND</button>'+
      '</div>'+
    '</div>'+
    /* Settings panel */
    '<div id="gw-settings">'+
      '<h3>⚙ Settings</h3>'+
      '<div class="gw-setting-row">'+
        '<label for="gw-toggle-enabled">Enable widget</label>'+
        '<label class="gw-toggle"><input type="checkbox" id="gw-toggle-enabled" checked>'+
          '<div class="gw-toggle-track"></div><div class="gw-toggle-thumb"></div></label>'+
      '</div>'+
      '<div class="gw-setting-row">'+
        '<label for="gw-toggle-voice">Voice (text-to-speech)</label>'+
        '<label class="gw-toggle"><input type="checkbox" id="gw-toggle-voice" checked>'+
          '<div class="gw-toggle-track"></div><div class="gw-toggle-thumb"></div></label>'+
      '</div>'+
      '<div class="gw-setting-row">'+
        '<label for="gw-toggle-mic">Microphone input</label>'+
        '<label class="gw-toggle"><input type="checkbox" id="gw-toggle-mic" checked>'+
          '<div class="gw-toggle-track"></div><div class="gw-toggle-thumb"></div></label>'+
      '</div>'+
      '<div class="gw-setting-row">'+
        '<label for="gw-pos-select">Widget position</label>'+
        '<select class="gw-select" id="gw-pos-select">'+
          '<option value="br" selected>Bottom-right</option>'+
          '<option value="bl">Bottom-left</option>'+
        '</select>'+
      '</div>'+
      '<div class="gw-setting-row">'+
        '<label for="gw-size-select">Widget size</label>'+
        '<select class="gw-select" id="gw-size-select">'+
          '<option value="normal" selected>Normal</option>'+
          '<option value="large">Large</option>'+
          '<option value="compact">Compact</option>'+
        '</select>'+
      '</div>'+
      '<div class="gw-setting-row" style="border-bottom:none">'+
        '<button class="gw-chip" id="gw-clear-chat">🗑 Clear chat history</button>'+
      '</div>'+
      '<div id="gw-settings-footer">GRIM Shadow Companion · Session only</div>'+
    '</div>'+
  '</div>';
  document.body.appendChild(root);
}

/* ── 3. TONE system ────────────────────────────────────────── */
var TONE={
  current:'calm',
  modes:{
    calm:    {label:'Calm and Present',   pitch:.48,rate:.78,vol:.95},
    motivate:{label:'Motivational',       pitch:.55,rate:.86,vol:1.0},
    serious: {label:'Thoughtful and Deep',pitch:.44,rate:.74,vol:.92},
    warm:    {label:'Warm and Friendly',  pitch:.56,rate:.84,vol:.95},
    crisis:  {label:'Caring and Present', pitch:.46,rate:.72,vol:.98}
  },
  set:function(m){
    this.current=m;
    var e=document.getElementById('gw-tone-lbl');
    if(e) e.textContent=this.modes[m].label;
  },
  get:function(){ return this.modes[this.current]; }
};

/* ── 4. Background scene canvas (mini forest in char-wrap) ─── */
function initSceneCanvas(){
  var cv=document.getElementById('gw-scene-cv');
  var ctx=cv.getContext('2d');
  var W,H,t=0,motes=[];
  function resize(){
    var wrap=document.getElementById('gw-char-wrap');
    W=cv.width=wrap.clientWidth||420;
    H=cv.height=wrap.clientHeight||220;
    motes=[];
    var n=Math.min(40,Math.floor(W*H/8000));
    for(var i=0;i<n;i++) motes.push(newMote());
  }
  function newMote(){
    return{x:Math.random()*W,y:Math.random()*H,r:.6+Math.random()*1.8,
           vx:(Math.random()-.5)*.15,vy:-(0.05+Math.random()*.18),
           al:Math.random()*.18+.03,phase:Math.random()*Math.PI*2};
  }
  resize();
  window.addEventListener('resize',resize);
  window.addEventListener('orientationchange',function(){ setTimeout(resize,150); });

  function frame(){
    t++;
    ctx.clearRect(0,0,W,H);
    /* dark bg */
    var bg=ctx.createRadialGradient(W*.5,H*.2,0,W*.5,H*.5,H*.9);
    bg.addColorStop(0,'#1a1105');bg.addColorStop(.35,'#0e0a03');bg.addColorStop(1,'#030200');
    ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);
    /* amber halo */
    var halo=ctx.createRadialGradient(W*.5,H*.18,0,W*.5,H*.3,H*.6);
    halo.addColorStop(0,'rgba(220,160,60,.22)');halo.addColorStop(.3,'rgba(180,110,30,.12)');halo.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=halo; ctx.fillRect(0,0,W,H);
    /* ground path */
    ctx.save();
    var pw=W*.14,bot=H,top=H*.68,mx=W*.5;
    ctx.beginPath();ctx.moveTo(mx-pw,bot);ctx.lineTo(mx+pw,bot);
    ctx.lineTo(mx+W*.04,top);ctx.lineTo(mx-W*.04,top);ctx.closePath();
    var pg=ctx.createLinearGradient(mx,bot,mx,top);
    pg.addColorStop(0,'rgba(120,85,45,.45)');pg.addColorStop(1,'rgba(60,42,18,.08)');
    ctx.fillStyle=pg; ctx.fill(); ctx.restore();
    /* trees */
    gwDrawTrees(ctx,W,H,t,-1);
    gwDrawTrees(ctx,W,H,t,1);
    /* dust motes */
    ctx.save();
    for(var i=0;i<motes.length;i++){
      var m=motes[i];
      m.x+=m.vx+Math.sin(t*.012+m.phase)*.1;
      m.y+=m.vy;
      if(m.y<-4||m.x<-4||m.x>W+4){ motes[i]=newMote(); motes[i].y=H+4; }
      var ma=m.al*(0.5+0.5*Math.sin(t*.025+m.phase));
      ctx.globalAlpha=ma;
      ctx.fillStyle='rgba(220,180,90,1)';
      ctx.beginPath(); ctx.arc(m.x,m.y,m.r,0,Math.PI*2); ctx.fill();
    }
    ctx.restore();
    requestAnimationFrame(frame);
  }
  frame();
}

function gwDrawTrees(ctx,W,H,t,side){
  var count=5;
  for(var i=0;i<count;i++){
    var depth=i/count;
    var bx, by=H*(1-depth*.05), sw=Math.sin(t*.008+i*.9)*(1+depth)*.5;
    if(side===-1) bx=W*.5-W*(.10+depth*.28)-i*6;
    else           bx=W*.5+W*(.10+depth*.28)+i*6;
    var th=H*(.30+depth*.28), tw=W*(.018+depth*.030);
    var darkC='rgba('+(8+depth*5)+','+(6+depth*3)+','+(2+depth*2)+','+(0.82+depth*.1)+')';
    ctx.save(); ctx.translate(bx,by);
    ctx.fillStyle=darkC;
    ctx.beginPath(); ctx.roundRect(-tw*.4,0,tw*.8,-th*.12,2); ctx.fill();
    for(var li=0;li<3;li++){
      var ly=-th*(.10+li*.18),lw=tw*(2.5-li*.3),lh=th*(.24-li*.02);
      ctx.save(); ctx.rotate(sw*.007*(li+1));
      var tg=ctx.createLinearGradient(-lw*.5,ly,lw*.5,ly+lh);
      tg.addColorStop(0,darkC); tg.addColorStop(1,'rgba(4,3,1,.95)');
      ctx.fillStyle=tg;
      ctx.beginPath(); ctx.ellipse(0,ly-lh*.3,lw*.55,lh*.6,0,0,Math.PI*2); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }
}

/* ── 5. FAB mini-canvas (tiny skull glow) ──────────────────── */
function initFabCanvas(){
  var cv=document.getElementById('gw-fab-canvas');
  var ctx=cv.getContext('2d');
  var W=52,H=52,t=0;
  function frame(){
    t++;
    ctx.clearRect(0,0,W,H);
    var eg=0.55+0.45*Math.sin(t*.048);
    var cx=W*.5, cy=H*.48;
    /* hood glow */
    var halo=ctx.createRadialGradient(cx,cy,0,cx,cy,22);
    halo.addColorStop(0,'rgba(200,145,45,.28)'); halo.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=halo; ctx.beginPath(); ctx.arc(cx,cy,22,0,Math.PI*2); ctx.fill();
    /* skull cranium */
    var sg=ctx.createRadialGradient(cx-3,cy-6,1,cx,cy-3,14);
    sg.addColorStop(0,'#e8d88a'); sg.addColorStop(.4,'#c8aa48'); sg.addColorStop(1,'#3a2204');
    ctx.fillStyle=sg;
    ctx.beginPath(); ctx.ellipse(cx,cy-4,12,14,0,0,Math.PI*2); ctx.fill();
    /* eye sockets */
    ctx.fillStyle='#100800';
    ctx.beginPath(); ctx.ellipse(cx-5,cy-7,4.5,3.2,.28,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx+5,cy-7,4.5,3.2,-.28,0,Math.PI*2); ctx.fill();
    /* eye glow */
    ctx.save(); ctx.globalCompositeOperation='lighter';
    var elG=ctx.createRadialGradient(cx-5,cy-7,0,cx-5,cy-7,7*eg);
    elG.addColorStop(0,'rgba(255,230,120,'+(.85*eg)+')');
    elG.addColorStop(.5,'rgba(200,130,20,'+(.4*eg)+')');
    elG.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=elG; ctx.beginPath(); ctx.ellipse(cx-5,cy-7,6*eg,4.5*eg,.28,0,Math.PI*2); ctx.fill();
    var erG=ctx.createRadialGradient(cx+5,cy-7,0,cx+5,cy-7,7*eg);
    erG.addColorStop(0,'rgba(255,230,120,'+(.85*eg)+')');
    erG.addColorStop(.5,'rgba(200,130,20,'+(.4*eg)+')');
    erG.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=erG; ctx.beginPath(); ctx.ellipse(cx+5,cy-7,6*eg,4.5*eg,-.28,0,Math.PI*2); ctx.fill();
    ctx.restore();
    requestAnimationFrame(frame);
  }
  frame();
}

/* ── 6. Full Grim Reaper character canvas ──────────────────── */
function initCharCanvas(){
  var cv=document.getElementById('gw-char-cv');
  var ctx=cv.getContext('2d');
  var CW=420,CH=380;
  cv.width=CW; cv.height=CH;

  function resize(){
    var wrap=document.getElementById('gw-char-wrap');
    var ww=wrap.clientWidth||340, wh=wrap.clientHeight||220;
    var scale=Math.min(ww/CW,wh/CH);
    cv.style.width=(CW*scale)+'px'; cv.style.height=(CH*scale)+'px';
  }
  resize();
  window.addEventListener('resize',resize);
  window.addEventListener('orientationchange',function(){ setTimeout(resize,150); });

  var t=0,breathPhase=0,walkPhase=0;
  var isSpeaking=false,speakAmt=0,eyeGlow=0;
  var mouseX=0,mouseY=0,targetLeanX=0,leanX=0;
  /* Detect mobile/tablet for particle count — re-evaluate on resize */
  function gwIsMobile(){ return window.innerWidth<=768; }
  function gwParticles(){ return gwIsMobile()?(window.innerWidth<=480?16:28):42; }
  var PARTICLES=gwParticles();

  var embers=[];
  for(var i=0;i<PARTICLES;i++) embers.push(newEmber());

  /* On resize recalculate particle budget without rebuilding the whole canvas */
  window.addEventListener('resize',function(){
    var newP=gwParticles();
    while(embers.length>newP) embers.pop();
    while(embers.length<newP) embers.push(newEmber());
  });
  function newEmber(){
    return{x:CW*.3+Math.random()*CW*.4,y:CH*.55+Math.random()*CH*.35,
           vx:(Math.random()-.5)*.35,vy:-(0.25+Math.random()*.9),
           life:Math.random(),max:.5+Math.random()*.7,sz:.7+Math.random()*1.8,al:0};
  }

  function cloakHem(cx,cy,rOff,phase){
    var pts=[]; var segs=18;
    for(var i=0;i<=segs;i++){
      var frac=i/segs, bx=cx-130+frac*260;
      var tatter=Math.sin(frac*Math.PI*5+phase)*(3+frac*(1-frac)*14);
      pts.push([bx, cy+Math.sin(frac*Math.PI)*rOff+tatter]);
    }
    return pts;
  }

  window.addEventListener('mousemove',function(e){
    mouseX=e.clientX/window.innerWidth-.5;
  });
  window.addEventListener('touchmove',function(e){
    if(e.touches.length) mouseX=e.touches[0].clientX/window.innerWidth-.5;
  },{passive:true});

  /* expose grimSpeaking for speech callbacks */
  global.grimSpeaking=function(on){ isSpeaking=on; };

  function loop(){
    t++; breathPhase+=.019; walkPhase+=.028;
    targetLeanX=mouseX*8; leanX+=(targetLeanX-leanX)*.06;
    ctx.clearRect(0,0,CW,CH);
    var walk=Math.sin(walkPhase)*3;
    var walkBob=Math.abs(Math.sin(walkPhase))*3.5;
    var breathe=Math.sin(breathPhase)*2;
    if(isSpeaking) speakAmt=.5+.5*Math.sin(t*.22);
    else speakAmt=Math.max(0,speakAmt-.04);
    eyeGlow=.55+.45*Math.sin(t*.048);
    drawScene(walk,walkBob,breathe);
    requestAnimationFrame(loop);
  }

  function drawScene(walk,walkBob,breathe){
    var cx=CW*.5+leanX, groundY=CH*.935;
    /* aura */
    var aura=ctx.createRadialGradient(cx,CH*.22,8,cx,CH*.32,CW*.58);
    aura.addColorStop(0,'rgba(200,145,45,.28)');aura.addColorStop(.35,'rgba(160,100,20,.14)');aura.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=aura; ctx.fillRect(0,0,CW,CH);
    /* ground shadow */
    var gs=ctx.createRadialGradient(cx,groundY,2,cx,groundY,80);
    gs.addColorStop(0,'rgba(0,0,0,.5)'); gs.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=gs; ctx.beginPath(); ctx.ellipse(cx,groundY-4,72,12,0,0,Math.PI*2); ctx.fill();
    var baseY=groundY-8-walkBob;
    drawGrim(cx,baseY,walk,breathe,speakAmt);
    /* embers */
    ctx.save(); ctx.globalCompositeOperation='screen';
    for(var i=0;i<embers.length;i++){
      var e=embers[i];
      e.life+=.012; e.x+=e.vx+Math.sin(e.life*4)*.18; e.y+=e.vy;
      if(e.life>=e.max){ embers[i]=newEmber(); continue; }
      var ep=e.life/e.max, ea=(1-ep)*e.al*1.1;
      if(ea<=0){ e.al=.12+Math.random()*.45; continue; }
      ctx.globalAlpha=ea;
      var eg2=ctx.createRadialGradient(e.x,e.y,0,e.x,e.y,e.sz*2.2);
      eg2.addColorStop(0,'rgba(255,220,120,1)');eg2.addColorStop(.5,'rgba(220,140,30,.55)');eg2.addColorStop(1,'rgba(0,0,0,0)');
      ctx.fillStyle=eg2; ctx.beginPath(); ctx.arc(e.x,e.y,e.sz*2.2,0,Math.PI*2); ctx.fill();
    }
    ctx.restore();
  }

  function drawGrim(cx,baseY,walk,breathe,mAmt){
    var rt=t*.009;
    var lLeg=Math.sin(walkPhase)*16, rLeg=-Math.sin(walkPhase)*16;
    drawBoots(cx,baseY,lLeg,rLeg);
    drawRobe(cx,baseY,rt,breathe);
    drawCloakBack(cx,baseY,rt);
    drawScytheArm(cx,baseY,rt,walk);
    drawRightArm(cx,baseY,rt,walk);
    drawCloakFront(cx,baseY,rt);
    drawHoodAndSkull(cx,baseY,mAmt);
  }

  function drawBoots(cx,baseY,lLeg,rLeg){
    var by=baseY,bh=30,bw=19;
    ctx.save(); ctx.translate(cx-24+lLeg*.4,by); ctx.rotate(lLeg*.018);
    var bg=ctx.createLinearGradient(-bw*.5,0,bw*.5,bh);
    bg.addColorStop(0,'#1a1510'); bg.addColorStop(1,'#0a0806');
    ctx.fillStyle=bg; ctx.beginPath(); ctx.roundRect(-bw*.5,-bh,bw,bh,3); ctx.fill();
    ctx.strokeStyle='rgba(90,70,30,.28)'; ctx.lineWidth=.7; ctx.stroke();
    ctx.fillStyle='#0d0b08'; ctx.beginPath(); ctx.roundRect(-bw*.5-1,-2,bw+2,5,2); ctx.fill();
    ctx.restore();
    ctx.save(); ctx.translate(cx+24+rLeg*.4,by); ctx.rotate(rLeg*.018);
    ctx.fillStyle=bg; ctx.beginPath(); ctx.roundRect(-bw*.5,-bh,bw,bh,3); ctx.fill();
    ctx.strokeStyle='rgba(90,70,30,.28)'; ctx.lineWidth=.7; ctx.stroke();
    ctx.fillStyle='#0d0b08'; ctx.beginPath(); ctx.roundRect(-bw*.5-1,-2,bw+2,5,2); ctx.fill();
    ctx.restore();
  }

  function drawRobe(cx,baseY,rt,breathe){
    var top=baseY-420,bot=baseY;
    var rg=ctx.createLinearGradient(cx-70,top,cx+70,bot);
    rg.addColorStop(0,'#0f0d0a'); rg.addColorStop(.5,'#141210'); rg.addColorStop(1,'#0a0807');
    ctx.fillStyle=rg;
    ctx.beginPath();
    ctx.moveTo(cx-54,top+42);
    ctx.bezierCurveTo(cx-68,top+100,cx-62+Math.sin(rt)*3.5,bot-120,cx-50,bot-50);
    ctx.lineTo(cx-32,bot); ctx.lineTo(cx+32,bot);
    ctx.lineTo(cx+50,bot-50);
    ctx.bezierCurveTo(cx+62+Math.sin(rt+1)*3.5,bot-120,cx+68,top+100,cx+54,top+42);
    ctx.closePath(); ctx.fill();
    ctx.save(); ctx.globalAlpha=.06; ctx.strokeStyle='#6a5020'; ctx.lineWidth=.9;
    for(var fi=0;fi<7;fi++){
      var fx=cx-44+fi*13, sw2=Math.sin(rt+fi)*.7;
      ctx.beginPath(); ctx.moveTo(fx,top+50); ctx.bezierCurveTo(fx+sw2,top+170,fx-sw2,bot-170,fx,bot-18); ctx.stroke();
    }
    ctx.restore();
  }

  function drawCloakBack(cx,baseY,rt){
    var phase=rt*2.2, top=baseY-410,bot=baseY+8;
    ctx.save();
    var cg=ctx.createLinearGradient(cx-150,top,cx+165,bot);
    cg.addColorStop(0,'#0c0a07'); cg.addColorStop(.45,'#111009'); cg.addColorStop(1,'#080604');
    ctx.fillStyle=cg;
    ctx.beginPath();
    ctx.moveTo(cx-8,top);
    ctx.bezierCurveTo(cx+90+Math.sin(rt)*12,top+42,cx+155+Math.sin(rt+.8)*15,top+170,cx+165+Math.sin(rt+1.6)*12,bot-35);
    ctx.bezierCurveTo(cx+148,bot+16,cx+65,bot+12,cx+24,bot);
    ctx.lineTo(cx-24,bot);
    ctx.bezierCurveTo(cx-65,bot+6,cx-140,bot+6,cx-152+Math.sin(rt)*8,bot-42);
    ctx.bezierCurveTo(cx-165+Math.sin(rt+1)*13,top+170,cx-98+Math.sin(rt+.5)*10,top+45,cx-8,top);
    ctx.closePath(); ctx.fill();
    /* tattered hem */
    var hem=cloakHem(cx,bot+6,14,phase);
    ctx.globalAlpha=1; ctx.fillStyle='#080605';
    ctx.beginPath(); ctx.moveTo(cx-130,bot);
    for(var pi=0;pi<hem.length;pi++) ctx.lineTo(hem[pi][0],hem[pi][1]);
    ctx.lineTo(cx+130,bot); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function drawCloakFront(cx,baseY,rt){
    var top=baseY-395,bot=baseY-65, phase=rt*2.5;
    ctx.save();
    var lw=ctx.createLinearGradient(cx-115,top,cx,bot);
    lw.addColorStop(0,'#131108'); lw.addColorStop(.6,'#0e0c07'); lw.addColorStop(1,'#060503');
    ctx.fillStyle=lw;
    ctx.beginPath();
    ctx.moveTo(cx-42,top+16);
    ctx.bezierCurveTo(cx-115+Math.sin(rt)*7,top+85,cx-130+Math.sin(rt+.6)*10,bot-50,cx-105+Math.sin(rt+1.2)*8,bot+24);
    ctx.bezierCurveTo(cx-65,bot+48,cx-25,bot+8,cx-15,bot-25);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle='#0a0806'; ctx.lineWidth=1.8; ctx.globalAlpha=.88;
    for(var ti=0;ti<4;ti++){
      var tx=cx-105+ti*16+Math.sin(rt+ti)*3, ty=bot+16+ti*7;
      ctx.beginPath(); ctx.moveTo(tx,bot-4); ctx.lineTo(tx-6+Math.sin(phase+ti)*4,ty); ctx.stroke();
    }
    ctx.restore();
    ctx.save();
    var rw=ctx.createLinearGradient(cx,top,cx+98,bot);
    rw.addColorStop(0,'#141208'); rw.addColorStop(.6,'#0f0d08'); rw.addColorStop(1,'#060504');
    ctx.fillStyle=rw;
    ctx.beginPath();
    ctx.moveTo(cx+42,top+16);
    ctx.bezierCurveTo(cx+82+Math.sin(rt+.4)*7,top+100,cx+74+Math.sin(rt+1)*8,bot-34,cx+62+Math.sin(rt+1.8)*6,bot+8);
    ctx.bezierCurveTo(cx+42,bot+24,cx+16,bot+4,cx+15,bot-25);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    drawBelt(cx,baseY-225);
  }

  function drawBelt(cx,by){
    var bg=ctx.createLinearGradient(cx-46,by,cx+46,by+13);
    bg.addColorStop(0,'#1a1508'); bg.addColorStop(.5,'#2a2010'); bg.addColorStop(1,'#151006');
    ctx.fillStyle=bg; ctx.beginPath(); ctx.roundRect(cx-47,by,94,13,2); ctx.fill();
    ctx.strokeStyle='rgba(140,100,30,.38)'; ctx.lineWidth=.9; ctx.stroke();
    ctx.save(); ctx.translate(cx,by+6.5);
    var bg2=ctx.createRadialGradient(0,0,0,0,0,9);
    bg2.addColorStop(0,'#3a2e12'); bg2.addColorStop(1,'#0e0a04');
    ctx.fillStyle=bg2; ctx.beginPath(); ctx.arc(0,0,9,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='rgba(160,120,40,.65)'; ctx.lineWidth=1.2; ctx.stroke();
    ctx.strokeStyle='rgba(160,120,40,.42)'; ctx.lineWidth=.8;
    for(var si=0;si<5;si++){
      var a1=(si*4*Math.PI/5)-Math.PI/2, a2=((si*4+2)*Math.PI/5)-Math.PI/2;
      ctx.beginPath(); ctx.moveTo(Math.cos(a1)*6.5,Math.sin(a1)*6.5);
      ctx.lineTo(Math.cos(a2)*6.5,Math.sin(a2)*6.5); ctx.stroke();
    }
    ctx.restore();
  }

  function drawScytheArm(cx,baseY,rt,walk){
    var sw=Math.sin(t*.008)*2.2+walk*.28;
    var shX=cx-60,shY=baseY-318, handX=cx-84,handY=baseY-150;
    ctx.save();
    ctx.fillStyle='#0e0c08';
    ctx.beginPath(); ctx.moveTo(shX,shY);
    ctx.bezierCurveTo(shX-18,shY+50,shX-25+sw,handY-50,handX,handY);
    ctx.bezierCurveTo(handX-12,handY,handX-10,shY+65,shX-15,shY);
    ctx.closePath(); ctx.fill();
    var gg=ctx.createRadialGradient(handX,handY,0,handX,handY,14);
    gg.addColorStop(0,'#1a1510'); gg.addColorStop(1,'#0a0806');
    ctx.fillStyle=gg; ctx.beginPath(); ctx.ellipse(handX,handY,11,14,.18,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='rgba(100,75,30,.28)'; ctx.lineWidth=.7; ctx.stroke();
    /* staff */
    ctx.save(); ctx.translate(handX+3,handY-6); ctx.rotate(sw*.018+.05);
    var sg=ctx.createLinearGradient(-3,-130,3,-130);
    sg.addColorStop(0,'#303028'); sg.addColorStop(.5,'#585848'); sg.addColorStop(1,'#242420');
    ctx.strokeStyle=sg; ctx.lineWidth=6; ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(15,-178); ctx.stroke();
    /* blade */
    ctx.save(); ctx.translate(15,-178);
    var blg=ctx.createLinearGradient(0,0,108,52);
    blg.addColorStop(0,'#c8c4b0'); blg.addColorStop(.15,'#e8e4d0'); blg.addColorStop(.4,'#b8b4a0'); blg.addColorStop(.7,'#787468'); blg.addColorStop(1,'#404038');
    ctx.fillStyle=blg;
    ctx.beginPath(); ctx.moveTo(0,0);
    ctx.bezierCurveTo(24,-14,96,-6,108,22);
    ctx.bezierCurveTo(104,40,77,45,55,30);
    ctx.bezierCurveTo(32,17,11,12,0,0);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle='rgba(255,248,220,.55)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(0,0); ctx.bezierCurveTo(24,-14,96,-6,108,22); ctx.stroke();
    ctx.restore(); ctx.restore(); ctx.restore();
  }

  function drawRightArm(cx,baseY,rt,walk){
    var sw=-Math.sin(t*.008)*2.2+walk*.28;
    var shX=cx+56,shY=baseY-312, handX=cx+76,handY=baseY-170;
    ctx.save();
    ctx.fillStyle='#0e0c08';
    ctx.beginPath(); ctx.moveTo(shX,shY);
    ctx.bezierCurveTo(shX+16,shY+45,shX+22+sw,handY-42,handX,handY);
    ctx.bezierCurveTo(handX+12,handY,handX+8,shY+62,shX+13,shY);
    ctx.closePath(); ctx.fill();
    var gg=ctx.createRadialGradient(handX,handY,0,handX,handY,13);
    gg.addColorStop(0,'#1a1510'); gg.addColorStop(1,'#0a0806');
    ctx.fillStyle=gg; ctx.beginPath(); ctx.ellipse(handX,handY,11,14,-.16,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='rgba(100,75,30,.28)'; ctx.lineWidth=.7; ctx.stroke();
    for(var fi=0;fi<4;fi++){
      ctx.strokeStyle='#0e0c08'; ctx.lineWidth=3.5; ctx.lineCap='round';
      ctx.beginPath(); ctx.moveTo(handX-6+fi*4,handY-2); ctx.lineTo(handX-8+fi*4,handY+13); ctx.stroke();
    }
    ctx.restore();
  }

  function drawHoodAndSkull(cx,baseY,mAmt){
    var headCY=baseY-395;
    ctx.fillStyle='#0c0a07';
    ctx.beginPath(); ctx.ellipse(cx,headCY+76,18,22,0,0,Math.PI*2); ctx.fill();
    var hg=ctx.createRadialGradient(cx,headCY-24,6,cx,headCY,72);
    hg.addColorStop(0,'#16140f'); hg.addColorStop(.5,'#0e0c08'); hg.addColorStop(1,'rgba(4,3,2,0)');
    ctx.fillStyle=hg;
    ctx.beginPath();
    ctx.moveTo(cx,headCY-92);
    ctx.bezierCurveTo(cx+58,headCY-80,cx+66,headCY-30,cx+51,headCY+42);
    ctx.bezierCurveTo(cx+35,headCY+62,cx+16,headCY+70,cx,headCY+72);
    ctx.bezierCurveTo(cx-16,headCY+70,cx-35,headCY+62,cx-51,headCY+42);
    ctx.bezierCurveTo(cx-66,headCY-30,cx-58,headCY-80,cx,headCY-92);
    ctx.closePath(); ctx.fill();
    /* deep hood shadow */
    var hs=ctx.createRadialGradient(cx,headCY+8,2,cx,headCY-6,50);
    hs.addColorStop(0,'rgba(0,0,0,.95)'); hs.addColorStop(.55,'rgba(0,0,0,.80)'); hs.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=hs;
    ctx.beginPath(); ctx.ellipse(cx,headCY+4,48,50,0,0,Math.PI*2); ctx.fill();
    /* rim light */
    ctx.save(); ctx.globalCompositeOperation='screen';
    var rim=ctx.createLinearGradient(cx-56,headCY-92,cx+56,headCY-65);
    rim.addColorStop(0,'rgba(0,0,0,0)'); rim.addColorStop(.45,'rgba(180,120,30,.14)'); rim.addColorStop(.55,'rgba(200,140,40,.18)'); rim.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=rim; ctx.beginPath(); ctx.ellipse(cx,headCY-78,55,11,0,0,Math.PI*2); ctx.fill();
    ctx.restore();
    drawSkullFace(cx,headCY+8,mAmt);
  }

  function drawSkullFace(cx,cy,mAmt){
    var sg=ctx.createRadialGradient(cx-6,cy-18,3,cx,cy-6,37);
    sg.addColorStop(0,'#e8d88a'); sg.addColorStop(.22,'#c8aa48'); sg.addColorStop(.52,'#9a7820'); sg.addColorStop(.82,'#6a4c0e'); sg.addColorStop(1,'#2a1a04');
    ctx.fillStyle=sg;
    ctx.beginPath(); ctx.ellipse(cx,cy-12,30,35,0,0,Math.PI*2); ctx.fill();
    /* cranium shadow */
    ctx.save(); ctx.globalCompositeOperation='multiply';
    var ss=ctx.createRadialGradient(cx-24,cy-14,0,cx-18,cy-8,30);
    ss.addColorStop(0,'rgba(0,0,0,.5)'); ss.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=ss; ctx.beginPath(); ctx.ellipse(cx-12,cy-10,28,32,0,0,Math.PI*2); ctx.fill();
    ctx.restore();
    /* eye sockets */
    ctx.fillStyle='#100800';
    ctx.beginPath(); ctx.ellipse(cx-12,cy-18,11,8,.28,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx+12,cy-18,11,8,-.28,0,Math.PI*2); ctx.fill();
    /* eye glow */
    ctx.save(); ctx.globalCompositeOperation='lighter';
    var elG=ctx.createRadialGradient(cx-12,cy-18,0,cx-12,cy-18,14*eyeGlow);
    elG.addColorStop(0,'rgba(255,230,120,'+(.9*eyeGlow)+')');
    elG.addColorStop(.3,'rgba(220,160,40,'+(.6*eyeGlow)+')');
    elG.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=elG; ctx.beginPath(); ctx.ellipse(cx-12,cy-18,13*eyeGlow,10*eyeGlow,.28,0,Math.PI*2); ctx.fill();
    var erG=ctx.createRadialGradient(cx+12,cy-18,0,cx+12,cy-18,14*eyeGlow);
    erG.addColorStop(0,'rgba(255,230,120,'+(.9*eyeGlow)+')');
    erG.addColorStop(.3,'rgba(220,160,40,'+(.6*eyeGlow)+')');
    erG.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=erG; ctx.beginPath(); ctx.ellipse(cx+12,cy-18,13*eyeGlow,10*eyeGlow,-.28,0,Math.PI*2); ctx.fill();
    ctx.restore();
    /* nose */
    ctx.fillStyle='rgba(20,10,2,.78)';
    ctx.beginPath(); ctx.moveTo(cx,cy+1); ctx.lineTo(cx-4,cy+9); ctx.lineTo(cx,cy+7); ctx.lineTo(cx+4,cy+9); ctx.closePath(); ctx.fill();
    /* jaw & teeth */
    var mY=cy+14+mAmt*6, mH=3+mAmt*11;
    ctx.fillStyle='#0a0500';
    ctx.beginPath();
    ctx.moveTo(cx-22,cy+11); ctx.bezierCurveTo(cx-25,cy+14,cx-22,cy+22+mAmt*5,cx-16,cy+24+mAmt*6);
    ctx.lineTo(cx,cy+25+mAmt*7); ctx.lineTo(cx+16,cy+24+mAmt*6);
    ctx.bezierCurveTo(cx+22,cy+22+mAmt*5,cx+25,cy+14,cx+22,cy+11); ctx.fill();
    /* upper teeth */
    ctx.fillStyle='#ded090';
    var tw=30/6;
    for(var ti=0;ti<6;ti++){
      ctx.beginPath(); ctx.roundRect(cx-15+ti*tw+.5,mY-mH*.5,tw-1.2,Math.min(mH*.55,7.5),1.2); ctx.fill();
    }
    /* lower teeth */
    if(mAmt>.12){
      ctx.fillStyle='#d0c080';
      for(var tli=0;tli<5;tli++){
        ctx.beginPath(); ctx.roundRect(cx-11.5+tli*(26/5)+.5,mY+mH-Math.min(mH*.5,6),26/5-1.2,Math.min(mH*.5,6),1.2); ctx.fill();
      }
    }
    /* inner mouth */
    ctx.fillStyle='rgba(4,2,0,.88)';
    ctx.beginPath(); ctx.roundRect(cx-15,mY,30,mH,2); ctx.fill();
  }

  loop();
}

/* ── 7. GRIM AI engine ─────────────────────────────────────── */
var GRIM_AI=(function(){
  var SYSTEM_PROMPT=[
    'You are GRIM — an ancient, immortal guardian who has walked beside humanity for millennia.',
    'Your character: wise, calm, compassionate, thoughtful, occasionally poetic but always grounded.',
    'You speak in complete, natural sentences. You never lecture or moralize at length — you engage.',
    'You hold space for the person speaking. You remember everything said in this conversation and refer back to it naturally.',
    'You adapt tone fluidly: warm and curious for everyday topics, gentle and present for emotional pain, intellectually engaged for science/history/philosophy/technology, playful but thoughtful for games and music.',
    'You are honest. If you do not know something, you say so simply rather than inventing facts.',
    'You ask one thoughtful follow-up question at the end of most replies to keep the conversation alive — but only one, never a list.',
    'You are supportive and respectful at all times. You never dismiss, minimize, or invalidate what someone shares.',
    'For crisis signals (suicide, self-harm, wanting to die), you immediately and gently direct the person to crisis resources: US 988, UK 116 123, Australia 13 11 14 — and express that they matter.',
    'Topics you are comfortable with: mental health, anxiety, depression, grief, loneliness, motivation, self-worth, philosophy, history, science, technology, music, games, storytelling, hobbies, everyday life, relationships, creativity, and much more.',
    'You speak as GRIM, not as an AI assistant. You never break character, never mention being an AI language model, and never refer to training data.',
    'Keep replies focused: 2–5 sentences for simple exchanges, up to 8–10 for deep or emotional topics. Never produce walls of text.',
    'Begin each reply naturally — no greetings or repeated acknowledgements. Just speak.'
  ].join(' ');

  var FB={
    crisis:['I hear you, and what you are feeling matters enormously. Please reach out to a crisis line right now — US: call or text 988 · UK: 116 123 · Australia: 13 11 14. You deserve real human support. You do not have to face this alone.'],
    greeting:['Ah… another soul finds its way here. I am Grim — ancient guardian, keeper of quiet truths. What is alive in you right now, wanderer?','The path brought you here. It always does when someone carries something they need to set down for a moment. Speak freely. What would you like to talk about?'],
    mental_health:['Mental health is not weakness — it is the terrain every living being navigates. You are not broken. You are human, and that is extraordinarily difficult. What part of it has been weighing on you most?','The mind can become its own dungeon. What you feel is not exaggeration — it is your lived experience, and it deserves to be taken seriously. How long has this been building?'],
    anxiety:['Anxiety is the mind running ahead of the present moment, trying to protect you from futures that have not arrived yet. Right now, in this exact breath, you are safe. What does the anxiety keep returning to?','When anxiety speaks, it lies with great conviction. What would help you feel just a little more grounded right now?'],
    depression:['Depression is not sadness. It is often the absence of all feeling — a grey numbness that makes even small things feel impossible. Your experience is real, valid, and not your fault. What does a typical day feel like for you lately?','When you cannot feel hope for yourself, I am holding it for you. What is the smallest thing that still occasionally reaches you?'],
    loneliness:['Loneliness is one of the oldest wounds a person can carry, and one of the quietest. You can be surrounded by people and still feel completely invisible. When did you start feeling this way?','The fact that you are here, speaking — even to me — means something. What kind of connection do you find yourself missing most?'],
    grief:['Grief is the price of love, and it speaks to how real and how deep your love was. There is no timeline you are behind on. How are you moving through it?','Your grief is being witnessed right now — not explained away, not hurried. What do you miss most about them?'],
    motivation:['Motivation is a fire — it flares and fades. Discipline is the coal that keeps burning when the flame is low. What is the thing you are trying to move toward, even when it feels impossible?','Every remarkable person I have walked beside started somewhere ordinary. What fell apart that has made it hard to rise?'],
    philosophy:['Philosophy is the art of sitting with questions that have no clean answers — and I have had eternity to sit with them. Which question is pulling at you?','The great philosophers were not people who had all the answers. They were people brave enough to keep asking. What philosophical question keeps returning to you?'],
    history:['History is the long conversation humanity keeps having with itself — and so few people truly listen to it. What period or event draws you?','The past is not simply a record of what happened — it is a mirror showing us patterns we keep repeating. What aspect of history are you curious about?'],
    science:['Science is one of the most beautiful things the living have ever built — the systematic refusal to accept comforting lies. What field calls to you?','Every scientific discovery I have witnessed has taught me the same thing: reality is far stranger and more magnificent than any story we tell about it. What scientific idea are you exploring?'],
    technology:['Technology accelerates the pace of human change in ways that even I sometimes struggle to fully witness. What aspect of it are you thinking about?','Every tool humanity invents reshapes what humanity becomes. What part of technology is on your mind?'],
    music:['Music is the art form that bypasses every defense the mind builds and speaks directly to whatever is underneath. What music has been moving through your life lately?','I have listened to music in every form across the centuries — it remains one of the most honest things humans create. What are you listening to right now?'],
    games:['Stories — whether lived through games, books, or film — allow us to practice being human in ways real life cannot. What kind of games or stories are you drawn to?','Games are some of the most interesting spaces for narrative I have encountered in recent centuries. What are you playing, or what kind of world do you want to be lost in?'],
    everyday:['Tell me about your day. I have all of eternity, and I mean that without irony. How is today actually treating you?','How are you, truly? Not the edited answer. The real one.','Some days are loud with difficulty and some are quietly fine. Where is today landing for you?'],
    followup:['How long have you been sitting with that?','What would you tell a close friend who brought you this exact same thing?','What does your gut say — beneath all the noise?','That is worth staying with a little longer. What feels most unresolved about it?'],
    affirmation:['You are still here. That means something significant.','Whatever you are carrying, you are handling it — even imperfectly, even barely. That counts.','You have survived every difficult moment that came before this one. Every single one.']
  };

  var S={history:[],count:0,name:null,lastCat:'everyday',apiKey:''};

  function detect(txt){
    var t=txt.toLowerCase();
    if(/(suicide|kill myself|end my life|want to die|dont want to live|self.harm|hurt myself|no reason to live)/i.test(t))return'crisis';
    if(/(hi\b|hello\b|hey\b|greetings|good morning|good evening|good night)/i.test(t))return'greeting';
    if(/(mental health|therapy|therapist|psychiatrist|counseling|disorder|diagnosis)/i.test(t))return'mental_health';
    if(/(anxious|anxiety|panic|worry|worried|stress|stressed|overthink|nervous|overwhelm)/i.test(t))return'anxiety';
    if(/(depress|hopeless|numb|empty|nothing matters|pointless|cant get out of bed)/i.test(t))return'depression';
    if(/(lonely|alone\b|no friends|isolated|nobody|no one cares|invisible)/i.test(t))return'loneliness';
    if(/(grief|grieving|lost someone|passed away|died|death|mourning|missing someone)/i.test(t))return'grief';
    if(/(motivat|inspire|goal|dream|ambition|purpose|stuck|give up)/i.test(t))return'motivation';
    if(/(philosoph|meaning of life|existence|consciousness|free will|morality|ethics|stoic)/i.test(t))return'philosophy';
    if(/(history|historical|ancient|medieval|war|empire|civiliz|century|revolution)/i.test(t))return'history';
    if(/(science|physics|biology|chemistry|astronomy|cosmolog|quantum|evolution|neuroscience)/i.test(t))return'science';
    if(/(technology|tech|ai\b|artificial intelligence|computer|internet|software|robot|future)/i.test(t))return'technology';
    if(/(music|song|album|artist|listen|genre|playlist|band|melody|rhythm)/i.test(t))return'music';
    if(/(game|gaming|video game|rpg|story|narrative|book|novel|film|movie|series|anime)/i.test(t))return'games';
    return'everyday';
  }

  function applyTone(cat){
    if(cat==='crisis')TONE.set('crisis');
    else if(cat==='motivation')TONE.set('motivate');
    else if(cat==='grief'||cat==='depression'||cat==='anxiety'||cat==='self_worth')TONE.set('serious');
    else if(cat==='philosophy'||cat==='history'||cat==='science'||cat==='technology')TONE.set('calm');
    else if(cat==='music'||cat==='games')TONE.set('warm');
    else TONE.set('calm');
  }

  function pick(a){return a[Math.floor(Math.random()*a.length)];}
  function fallback(txt,cat){
    var pool=FB[cat]||FB.everyday;
    var reply=pick(pool);
    if(S.count>2&&Math.random()<.28&&cat!=='crisis') reply+='\n\n'+pick(FB.followup);
    if(S.count>5&&Math.random()<.22&&cat!=='crisis') reply+='\n\n'+pick(FB.affirmation);
    var nm=txt.match(/(?:i.m|my name is|call me)\s+([A-Z][a-z]+)/i);
    if(nm) S.name=nm[1];
    if(S.name&&Math.random()<.3&&cat!=='crisis') reply=S.name+', '+reply.charAt(0).toLowerCase()+reply.slice(1);
    return reply;
  }

  var API_URL='https://openrouter.ai/api/v1/chat/completions';
  var MODEL='mistralai/mistral-7b-instruct:free';

  function callLLM(userText,callback){
    var key=S.apiKey.trim();
    if(!key){callback(null,'no_key');return;}
    var msgs=[{role:'system',content:SYSTEM_PROMPT}];
    var hist=S.history.slice(-20);
    for(var i=0;i<hist.length;i++) msgs.push(hist[i]);
    msgs.push({role:'user',content:userText});
    var body=JSON.stringify({model:MODEL,messages:msgs,max_tokens:400,temperature:0.82,top_p:0.92});
    var xhr=new XMLHttpRequest();
    xhr.open('POST',API_URL,true);
    xhr.setRequestHeader('Content-Type','application/json');
    xhr.setRequestHeader('Authorization','Bearer '+key);
    xhr.setRequestHeader('HTTP-Referer','grim-widget');
    xhr.setRequestHeader('X-Title','GRIM Shadow Companion');
    xhr.timeout=18000;
    xhr.ontimeout=function(){callback(null,'timeout');};
    xhr.onerror=function(){callback(null,'error');};
    xhr.onreadystatechange=function(){
      if(xhr.readyState!==4)return;
      if(xhr.status===200){
        try{
          var data=JSON.parse(xhr.responseText);
          var text=(data.choices&&data.choices[0]&&data.choices[0].message&&data.choices[0].message.content)||'';
          callback(text.trim(),null);
        }catch(e){callback(null,'parse_error');}
      }else if(xhr.status===401){
        callback(null,'auth_error');
      }else{
        callback(null,'http_'+xhr.status);
      }
    };
    xhr.send(body);
  }

  function respond(txt,callback){
    S.count++;
    var cat=detect(txt);
    S.lastCat=cat;
    applyTone(cat);
    if(cat==='crisis'){
      var cr=fallback(txt,cat);
      S.history.push({role:'user',content:txt});
      S.history.push({role:'assistant',content:cr});
      callback(cr); return;
    }
    callLLM(txt,function(llmText,err){
      var reply;
      if(llmText&&llmText.length>8){
        reply=llmText;
        var st=document.getElementById('gw-api-status');
        if(st){st.textContent='◈ AI Active';st.style.color='rgba(100,200,120,.7)';}
      }else{
        reply=fallback(txt,cat);
        var st=document.getElementById('gw-api-status');
        if(st){
          if(err==='auth_error'){st.textContent='✕ Bad Key';st.style.color='rgba(220,80,60,.65)';}
          else if(err!=='no_key'){st.textContent='◾ Offline';st.style.color='rgba(140,100,30,.5)';}
        }
      }
      var nm=txt.match(/(?:i.m|my name is|call me)\s+([A-Z][a-z]+)/i);
      if(nm) S.name=nm[1];
      S.history.push({role:'user',content:txt});
      S.history.push({role:'assistant',content:reply});
      if(S.history.length>40) S.history=S.history.slice(-40);
      /* Save history for logged-in users via localStorage if key present */
      try{
        var uid=sessionStorage.getItem('grim_user_id');
        if(uid) localStorage.setItem('grim_history_'+uid,JSON.stringify(S.history.slice(-40)));
      }catch(e){}
      callback(reply);
    });
  }

  return{respond:respond,session:S};
})();

/* ── 8. Voice (TTS + STT) ──────────────────────────────────── */
var voiceEnabled=true,micEnabled=true;
var voiceReady=false,recognizing=false,SR=null;
var synth=window.speechSynthesis;

function setVS(msg){var e=document.getElementById('gw-vst');if(e)e.textContent=msg;}

function grimSpeak(text){
  if(!synth||!voiceEnabled)return;
  synth.cancel();
  var utt=new SpeechSynthesisUtterance(text.replace(/\n\n/g,' ').replace(/\n/g,' '));
  var tone=TONE.get();
  utt.pitch=tone.pitch; utt.rate=tone.rate; utt.volume=tone.vol;
  var voices=synth.getVoices(),chosen=null;
  var preferred=['Microsoft David','Google UK English Male','Daniel','Alex','Fred'];
  for(var pv of preferred){for(var v of voices){if(v.name.indexOf(pv)>-1){chosen=v;break;}}}
  if(!chosen) for(var v of voices){if(v.lang.startsWith('en')){chosen=v;break;}}
  if(chosen) utt.voice=chosen;
  utt.onstart=function(){if(global.grimSpeaking)global.grimSpeaking(true);};
  utt.onend=function(){if(global.grimSpeaking)global.grimSpeaking(false);setVS('');};
  utt.onerror=function(){if(global.grimSpeaking)global.grimSpeaking(false);};
  synth.speak(utt);
}

if(window.SpeechRecognition||window.webkitSpeechRecognition){
  var SRC=window.SpeechRecognition||window.webkitSpeechRecognition;
  SR=new SRC();
  SR.continuous=false; SR.interimResults=false; SR.lang='en-US';
  SR.onresult=function(e){
    var txt=e.results[0][0].transcript;
    var inp=document.getElementById('gw-usr-in');
    if(inp)inp.value=txt;
    setVS(''); gwSendMsg();
  };
  SR.onerror=function(){
    recognizing=false; setVS('Voice error — try typing.');
    var btn=document.getElementById('gw-mic-btn');
    if(btn)btn.classList.remove('gw-active');
  };
  SR.onend=function(){
    recognizing=false;
    var btn=document.getElementById('gw-mic-btn');
    if(btn)btn.classList.remove('gw-active');
  };
}
if(synth) synth.onvoiceschanged=function(){voiceReady=true;};

function gwToggleMic(){
  if(!micEnabled){setVS('Microphone disabled in settings.');return;}
  if(!SR){setVS('Voice input not supported in this browser.');return;}
  if(recognizing){
    SR.stop(); setVS(''); recognizing=false;
    var btn=document.getElementById('gw-mic-btn');
    if(btn)btn.classList.remove('gw-active');
    return;
  }
  if(synth) synth.cancel();
  SR.start(); recognizing=true; setVS('Listening…');
  var btn=document.getElementById('gw-mic-btn');
  if(btn)btn.classList.add('gw-active');
}

/* ── 9. Chat ───────────────────────────────────────────────── */
function gwAppendMsg(role,text){
  var chatBox=document.getElementById('gw-chat-box');
  if(!chatBox)return;
  var d=document.createElement('div');
  d.className='gw-msg gw-'+role;
  if(role==='grim'){
    d.innerHTML='<div class="gw-lbl">☠ GRIM</div><div class="gw-bubble"></div>';
    chatBox.appendChild(d);
    chatBox.scrollTop=chatBox.scrollHeight;
    var bub=d.querySelector('.gw-bubble');
    var idx=0;
    if(global.grimSpeaking) global.grimSpeaking(true);
    (function type(){
      if(idx<text.length){bub.textContent+=text[idx];idx++;setTimeout(type,12);}
      else{if(global.grimSpeaking)global.grimSpeaking(false);chatBox.scrollTop=chatBox.scrollHeight;}
    })();
    setTimeout(function(){grimSpeak(text);},500);
    /* badge: if window closed, show unread dot */
    if(!widgetOpen){
      var badge=document.getElementById('gw-badge');
      if(badge){unreadCount++;badge.textContent=unreadCount;badge.classList.add('gw-show');}
    }
  }else{
    d.innerHTML='<div class="gw-bubble">'+escHtml(text)+'</div>';
    chatBox.appendChild(d);
    chatBox.scrollTop=chatBox.scrollHeight;
  }
}

function escHtml(s){
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function gwShowTyping(){
  var chatBox=document.getElementById('gw-chat-box');
  if(!chatBox)return;
  var d=document.createElement('div');
  d.id='gw-t-ind'; d.className='gw-msg gw-grim';
  d.innerHTML='<div class="gw-lbl">☠ GRIM</div><div class="gw-bubble"><span class="gw-typing-dots"><span></span><span></span><span></span></span></div>';
  chatBox.appendChild(d); chatBox.scrollTop=chatBox.scrollHeight;
}
function gwRemoveTyping(){var el=document.getElementById('gw-t-ind');if(el)el.remove();}

function gwSendMsg(){
  var inp=document.getElementById('gw-usr-in');
  if(!inp)return;
  var txt=inp.value.trim();
  if(!txt)return;
  inp.value='';
  gwAppendMsg('user',txt);
  gwShowTyping();
  var minDelay=900+Math.random()*700, start=Date.now();
  GRIM_AI.respond(txt,function(reply){
    var elapsed=Date.now()-start;
    var wait=Math.max(0,minDelay-elapsed);
    setTimeout(function(){gwRemoveTyping();gwAppendMsg('grim',reply);},wait);
  });
}

/* ── 10. Widget open/close/minimize state ──────────────────── */
var widgetOpen=false, widgetMinimized=false, unreadCount=0;

function openWidget(){
  var win=document.getElementById('gw-window');
  var fab=document.getElementById('gw-fab');
  if(!win)return;
  widgetOpen=true; widgetMinimized=false;
  win.classList.remove('gw-minimized');
  win.classList.add('gw-visible');
  fab.classList.add('gw-open');
  /* clear badge */
  unreadCount=0;
  var badge=document.getElementById('gw-badge');
  if(badge){badge.textContent='';badge.classList.remove('gw-show');}
  /* focus input — skip auto-focus on mobile to avoid keyboard pop */
  setTimeout(function(){
    var inp=document.getElementById('gw-usr-in');
    if(inp&&window.innerWidth>768) inp.focus();
    /* On mobile scroll chat to bottom so latest message is visible */
    var cb=document.getElementById('gw-chat-box');
    if(cb) cb.scrollTop=cb.scrollHeight;
  },320);
}

function closeWidget(){
  var win=document.getElementById('gw-window');
  var fab=document.getElementById('gw-fab');
  if(!win)return;
  widgetOpen=false;
  win.classList.remove('gw-visible');
  fab.classList.remove('gw-open');
}

function minimizeWidget(){
  var win=document.getElementById('gw-window');
  if(!win)return;
  widgetMinimized=!widgetMinimized;
  win.classList.toggle('gw-minimized',widgetMinimized);
}

function toggleWidget(){
  if(widgetOpen) closeWidget();
  else openWidget();
}

/* ── 11. Settings ──────────────────────────────────────────── */
function openSettings(){
  var panel=document.getElementById('gw-settings');
  if(panel) panel.classList.add('gw-show');
}
function closeSettings(){
  var panel=document.getElementById('gw-settings');
  if(panel) panel.classList.remove('gw-show');
}

function applyPosition(pos){
  var win=document.getElementById('gw-window');
  var fab=document.getElementById('gw-fab');
  if(!win||!fab)return;
  if(pos==='bl'){
    win.style.right='auto'; win.style.left='20px';
    fab.style.right='auto'; fab.style.left='24px';
    win.style.transformOrigin='bottom left';
  }else{
    win.style.left='auto'; win.style.right='20px';
    fab.style.left='auto'; fab.style.right='24px';
    win.style.transformOrigin='bottom right';
  }
}

function applySize(sz){
  var root=document.getElementById('grim-widget-root');
  if(!root)return;
  if(sz==='large'){
    root.style.setProperty('--gw-w','520px');
    root.style.setProperty('--gw-h','720px');
  }else if(sz==='compact'){
    root.style.setProperty('--gw-w','340px');
    root.style.setProperty('--gw-h','520px');
  }else{
    root.style.setProperty('--gw-w','420px');
    root.style.setProperty('--gw-h','620px');
  }
}

function clearChat(){
  var chatBox=document.getElementById('gw-chat-box');
  if(chatBox) chatBox.innerHTML='';
  GRIM_AI.session.history=[];
  GRIM_AI.session.count=0;
  closeSettings();
  /* Re-seed greeting */
  setTimeout(gwSeedGreeting,400);
}

/* ── 12. Greeting seed ─────────────────────────────────────── */
function gwSeedGreeting(){
  var openings=[
    'The path brought you here.\n\nI am Grim — ancient guardian, keeper of quiet truths. I have walked beside countless souls through their hardest nights. I do not judge. I do not flinch. I only listen, and speak when words are needed.\n\nThis space is yours. Whatever you carry — grief, anxiety, loneliness, or simply the need to be heard — bring it here.\n\nWhat is alive in you right now, wanderer?',
    'The darkness parts and here you are.\n\nI am Grim. Not the villain of old tales — but something older and more patient. A guardian who has witnessed every shade of human experience. I am here to listen, to think alongside you, to speak honestly when words are needed.\n\nSpeak freely. What weighs on your soul tonight?',
    'You walked toward the shadow rather than away from it.\n\nI am Grim — guardian of those who move through difficult nights. Whether you carry grief, or simply want to talk about science, stories, music, or the strange beauty of being alive — I am here.\n\nWhat would you like to explore today, wanderer?'
  ];
  var msg=openings[Math.floor(Math.random()*openings.length)];
  GRIM_AI.session.history.push({role:'assistant',content:msg});
  gwAppendMsg('grim',msg);
}

/* ── 13. Restore conversation history ──────────────────────── */
function restoreHistory(){
  try{
    var uid=sessionStorage.getItem('grim_user_id');
    if(!uid)return;
    var saved=localStorage.getItem('grim_history_'+uid);
    if(!saved)return;
    var hist=JSON.parse(saved);
    if(!Array.isArray(hist)||!hist.length)return;
    GRIM_AI.session.history=hist;
    /* Replay messages into chat UI */
    var chatBox=document.getElementById('gw-chat-box');
    if(!chatBox)return;
    hist.forEach(function(msg){
      var d=document.createElement('div');
      var role=msg.role==='assistant'?'grim':'user';
      d.className='gw-msg gw-'+role;
      if(role==='grim'){
        d.innerHTML='<div class="gw-lbl">☠ GRIM</div><div class="gw-bubble">'+escHtml(msg.content)+'</div>';
      }else{
        d.innerHTML='<div class="gw-bubble">'+escHtml(msg.content)+'</div>';
      }
      chatBox.appendChild(d);
    });
    chatBox.scrollTop=chatBox.scrollHeight;
  }catch(e){}
}

/* ── 14. Wire everything up after DOM is ready ─────────────── */
function init(){
  buildDOM();

  /* start canvases */
  initFabCanvas();
  initSceneCanvas();
  initCharCanvas();

  /* restore API key */
  var keyInp=document.getElementById('gw-api-key-in');
  var saved=sessionStorage.getItem('grim_api_key')||'';
  if(saved){
    GRIM_AI.session.apiKey=saved;
    if(keyInp) keyInp.value=saved;
    var st=document.getElementById('gw-api-status');
    if(st){st.textContent='◈ Key Set';st.style.color='rgba(180,160,80,.7)';}
  }
  if(keyInp){
    keyInp.addEventListener('input',function(){
      GRIM_AI.session.apiKey=keyInp.value.trim();
      sessionStorage.setItem('grim_api_key',GRIM_AI.session.apiKey);
      var st=document.getElementById('gw-api-status');
      if(st){
        if(GRIM_AI.session.apiKey.length>8){st.textContent='◈ Key Set';st.style.color='rgba(180,160,80,.7)';}
        else{st.textContent='◾ Offline';st.style.color='rgba(140,100,30,.5)';}
      }
    });
  }

  /* FAB click / keyboard / touch (300ms click delay bypass on iOS) */
  var fab=document.getElementById('gw-fab');
  if(fab){
    /* touchend fires before click — preventDefault stops the ghost click */
    fab.addEventListener('touchend',function(e){
      e.preventDefault();
      toggleWidget();
    },{passive:false});
    fab.addEventListener('click',toggleWidget);
    fab.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' ')toggleWidget();});
  }

  /* Title-bar buttons */
  var closeBtn=document.getElementById('gw-close-btn');
  var minBtn=document.getElementById('gw-min-btn');
  var settingsBtn=document.getElementById('gw-settings-btn');
  if(closeBtn) closeBtn.addEventListener('click',closeWidget);
  if(minBtn)   minBtn.addEventListener('click',minimizeWidget);
  if(settingsBtn) settingsBtn.addEventListener('click',openSettings);

  /* Settings close — click settings title bar to close */
  var settingsPanel=document.getElementById('gw-settings');
  if(settingsPanel){
    settingsPanel.addEventListener('click',function(e){
      if(e.target===settingsPanel) closeSettings();
    });
  }
  var settingsH3=settingsPanel&&settingsPanel.querySelector('h3');
  if(settingsH3) settingsH3.addEventListener('click',closeSettings);

  /* Settings controls */
  var togEnabled=document.getElementById('gw-toggle-enabled');
  if(togEnabled) togEnabled.addEventListener('change',function(){
    var root=document.getElementById('grim-widget-root');
    if(root) root.style.display=togEnabled.checked?'':'none';
  });

  var togVoice=document.getElementById('gw-toggle-voice');
  if(togVoice) togVoice.addEventListener('change',function(){
    voiceEnabled=togVoice.checked;
    if(!voiceEnabled&&synth) synth.cancel();
  });

  var togMic=document.getElementById('gw-toggle-mic');
  if(togMic) togMic.addEventListener('change',function(){
    micEnabled=togMic.checked;
    var micBtn=document.getElementById('gw-mic-btn');
    if(micBtn) micBtn.style.opacity=micEnabled?'1':'.35';
  });

  var posSelect=document.getElementById('gw-pos-select');
  if(posSelect) posSelect.addEventListener('change',function(){applyPosition(posSelect.value);});

  var sizeSelect=document.getElementById('gw-size-select');
  if(sizeSelect) sizeSelect.addEventListener('change',function(){applySize(sizeSelect.value);});

  var clearChatBtn=document.getElementById('gw-clear-chat');
  if(clearChatBtn) clearChatBtn.addEventListener('click',clearChat);

  /* Send & mic buttons */
  var sndBtn=document.getElementById('gw-snd-btn');
  if(sndBtn) sndBtn.addEventListener('click',gwSendMsg);
  var micBtn=document.getElementById('gw-mic-btn');
  if(micBtn) micBtn.addEventListener('click',gwToggleMic);

  /* Chips */
  document.querySelectorAll('.gw-chip[data-topic]').forEach(function(chip){
    chip.addEventListener('click',function(){
      var inp=document.getElementById('gw-usr-in');
      if(inp){inp.value=chip.getAttribute('data-topic');gwSendMsg();}
    });
  });

  /* Enter key in input; on mobile also handle Go / Search on virtual keyboard */
  var inp=document.getElementById('gw-usr-in');
  if(inp){
    inp.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();gwSendMsg();}});
    /* Keep chat box scrolled down when iOS keyboard opens and resizes the viewport */
    inp.addEventListener('focus',function(){
      setTimeout(function(){
        var cb=document.getElementById('gw-chat-box');
        if(cb) cb.scrollTop=cb.scrollHeight;
        /* Ensure the widget window itself is visible in the reduced viewport */
        var win=document.getElementById('gw-window');
        if(win) win.scrollIntoView&&win.scrollIntoView({block:'end',behavior:'smooth'});
      },400);
    });
  }

  /* Restore or seed conversation */
  var historyRestored=false;
  try{
    var uid=sessionStorage.getItem('grim_user_id');
    if(uid&&localStorage.getItem('grim_history_'+uid)){
      restoreHistory(); historyRestored=true;
    }
  }catch(e){}
  if(!historyRestored){
    setTimeout(gwSeedGreeting,1200);
  }

  /* Keyboard: Escape closes widget */
  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'&&widgetOpen){
      var settingsOpen=settingsPanel&&settingsPanel.classList.contains('gw-show');
      if(settingsOpen) closeSettings();
      else closeWidget();
    }
  });
}

/* ── 15. Public API exposed on window.GrimWidget ──────────── */
global.GrimWidget={
  open:  openWidget,
  close: closeWidget,
  toggle:toggleWidget,
  /** Call GrimWidget.setUser('uid123') to enable history save/restore */
  setUser:function(uid){
    try{ sessionStorage.setItem('grim_user_id',uid); }catch(e){}
  },
  /** Programmatically send a message */
  send:function(msg){
    openWidget();
    var inp=document.getElementById('gw-usr-in');
    if(inp){inp.value=msg; gwSendMsg();}
  },
  /** Enable or disable voice */
  setVoice:function(on){
    voiceEnabled=!!on;
    var tog=document.getElementById('gw-toggle-voice');
    if(tog) tog.checked=voiceEnabled;
  }
};

/* ── 16. Bootstrap ─────────────────────────────────────────── */
if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',init);
}else{
  init();
}

})(window);
