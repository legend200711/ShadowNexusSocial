/* ================================================================
   GRIM REAPER CHARACTER WIDGET  —  grim-reaper-character-widget.js
   Pure visual floating widget. No chat, no UI chrome.

   USAGE — one line on any page:
     <script src="grim-reaper-character-widget.js"></script>

   CONFIG (optional, set before the script tag):
     window.GrimCharConfig = {
       position : 'bottom-right', // 'bottom-right'|'bottom-left'|'top-right'|'top-left'
       size     : 'medium',       // 'small'|'medium'|'large'
       offsetX  : 0,              // pixels nudge from chosen corner (X)
       offsetY  : 0               // pixels nudge from chosen corner (Y)
     };

   JS API (available after load):
     GrimChar.setPosition('bottom-left');
     GrimChar.setSize('large');         // 'small'|'medium'|'large'
     GrimChar.setOffset(20, 40);        // offsetX, offsetY in px
================================================================ */

(function (global) {
  'use strict';

  /* ── Default configuration ─────────────────────────────────── */
  var CFG = Object.assign({
    position : 'top-right',
    size     : 'auto',   /* 'auto' = responsive; or 'small'|'medium'|'large' */
    offsetX  : 0,
    offsetY  : 0
  }, global.GrimCharConfig || {});

  /* Size presets: [stageW, stageH] in px at 1× scale.
     The stage itself is then CSS-scaled to fit the screen. */
  var SIZES = {
    small  : [130, 155],   /* small phone  ≤ 480 px  */
    medium : [185, 220],   /* large phone  ≤ 768 px  */
    large  : [250, 298],   /* tablet       ≤ 1024 px */
    xlarge : [320, 381]    /* desktop      > 1024 px */
  };

  /* Responsive size: auto-select preset based on viewport width */
  function gcwResponsiveSize() {
    var w = window.innerWidth;
    if (w <= 480)  return 'small';
    if (w <= 768)  return 'medium';
    if (w <= 1024) return 'large';
    return 'xlarge';
  }

  /* Logical canvas dimensions — character is drawn in these units */
  var CW = 420, CH = 500;

  /* ── DOM ─────────────────────────────────────────────────────── */
  var root, stage, sceneCV, charCV, sctx, cctx;

  function buildDOM() {
    /* Inject scoped styles */
    var style = document.createElement('style');
    style.textContent = [
      '#grim-char-widget{',
        'position:fixed;',
        'pointer-events:none;',
        'z-index:999990;',
        'line-height:0;',
        /* smooth corner transitions AND idle-fade transition */
        'transition:bottom .35s ease,top .35s ease,left .35s ease,right .35s ease,opacity .8s ease;',
        'opacity:1;',
      '}',
      /* Idle-faded state — character becomes translucent when idle */
      '#grim-char-widget.gcw-idle{',
        'opacity:0.28;',
      '}',
      /* Wake back instantly on hover */
      '#grim-char-widget:hover{',
        'opacity:1 !important;',
        'transition-duration:.18s,0s,0s,0s,0s !important;',
      '}',
      '#grim-char-stage{',
        'position:relative;',
        'display:block;',
      '}',
      '#grim-char-stage canvas{',
        'position:absolute;',
        'top:0;left:0;',
        'display:block;',
      '}',
      '#grim-scene-cv{z-index:1;}',
      '#grim-char-cv {z-index:2;}',
      '#grim-char-clickzone{',
        'position:absolute;',
        'inset:0;',
        'z-index:3;',
        'cursor:pointer;',
        'pointer-events:all;',
        'border-radius:50% 50% 40% 40%;',
        '-webkit-tap-highlight-color:transparent;',
        'touch-action:manipulation;',
      '}',
      '#grim-char-clickzone:hover{',
        'filter:drop-shadow(0 0 18px rgba(200,140,40,.45));',
      '}'
    ].join('');
    document.head.appendChild(style);

    /* Root wrapper — fixed-positioned container */
    root = document.createElement('div');
    root.id = 'grim-char-widget';

    /* Inner stage — sized via applySize() */
    stage = document.createElement('div');
    stage.id = 'grim-char-stage';

    /* Scene canvas (background — trees, motes, halo) */
    sceneCV = document.createElement('canvas');
    sceneCV.id = 'grim-scene-cv';

    /* Character canvas */
    charCV = document.createElement('canvas');
    charCV.id = 'grim-char-cv';
    charCV.width  = CW;
    charCV.height = CH;

    /* Click-zone overlay — invisible but pointer-enabled */
    var clickZone = document.createElement('div');
    clickZone.id = 'grim-char-clickzone';
    clickZone.setAttribute('role', 'button');
    clickZone.setAttribute('aria-label', 'Talk to GRIM');
    clickZone.setAttribute('tabindex', '0');
    clickZone.addEventListener('click', function () {
      if (typeof global.GrimSpeech !== 'undefined' && typeof global.GrimSpeech.toggle === 'function') {
        global.GrimSpeech.toggle();
      }
    });
    clickZone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); clickZone.click(); }
    });

    stage.appendChild(sceneCV);
    stage.appendChild(charCV);
    stage.appendChild(clickZone);
    root.appendChild(stage);
    document.body.appendChild(root);

    sctx = sceneCV.getContext('2d');
    cctx = charCV.getContext('2d');
  }

  /* ── Position / size helpers ─────────────────────────────────── */
  function applyPosition(pos, offX, offY) {
    offX = offX || 0;
    offY = offY || 0;
    root.style.bottom = ''; root.style.top = '';
    root.style.left   = ''; root.style.right = '';

    var margin = 12; /* minimum gap from viewport edge */
    if (pos === 'bottom-right') {
      root.style.bottom = (margin + offY) + 'px';
      root.style.right  = (margin + offX) + 'px';
    } else if (pos === 'bottom-left') {
      root.style.bottom = (margin + offY) + 'px';
      root.style.left   = (margin + offX) + 'px';
    } else if (pos === 'top-right') {
      root.style.top   = (margin + offY) + 'px';
      root.style.right = (margin + offX) + 'px';
    } else if (pos === 'top-left') {
      root.style.top  = (margin + offY) + 'px';
      root.style.left = (margin + offX) + 'px';
    }
  }

  function applySize(sz) {
    var effective = (sz === 'auto') ? gcwResponsiveSize() : sz;
    var preset = SIZES[effective] || SIZES.large;
    var targetW = preset[0];
    var targetH = preset[1];

    /* Clamp so the character is never larger than 90 % of the
       shorter viewport dimension, keeping it fully visible */
    var vMin = Math.min(window.innerWidth, window.innerHeight) * 0.9;
    if (targetH > vMin) {
      var ratio = vMin / targetH;
      targetW = Math.round(targetW * ratio);
      targetH = Math.round(targetH * ratio);
    }

    /* Set stage pixel dimensions */
    stage.style.width  = targetW + 'px';
    stage.style.height = targetH + 'px';

    /* Scene canvas matches stage exactly */
    sceneCV.width  = targetW;
    sceneCV.height = targetH;
    sceneCV.style.width  = targetW + 'px';
    sceneCV.style.height = targetH + 'px';

    /* Character canvas keeps logical CW×CH, CSS-scaled to stage */
    charCV.style.width  = targetW + 'px';
    charCV.style.height = targetH + 'px';

    /* Re-seed scene dimensions */
    SW = targetW; SH = targetH;
    initMotes();
  }

  /* ── Scene canvas ─────────────────────────────────────────── */
  var SW = 240, SH = 286;
  var motes = [];
  var st = 0;

  function initMotes() {
    motes = [];
    var n = Math.min(50, Math.floor(SW * SH / 5000));
    for (var i = 0; i < n; i++) motes.push(newMote());
  }

  function newMote() {
    return {
      x: Math.random() * SW,
      y: Math.random() * SH,
      r: 0.6 + Math.random() * 1.8,
      vx: (Math.random() - 0.5) * 0.15,
      vy: -(0.05 + Math.random() * 0.18),
      al: Math.random() * 0.18 + 0.03,
      phase: Math.random() * Math.PI * 2
    };
  }

  function drawTrees(ctx, W, H, t, side) {
    var count = 5;
    for (var i = 0; i < count; i++) {
      var depth = i / count;
      var bx, by = H * (1 - depth * 0.05);
      var sw = Math.sin(t * 0.008 + i * 0.9) * (1 + depth) * 0.5;
      if (side === -1) bx = W * 0.5 - W * (0.10 + depth * 0.28) - i * 6;
      else             bx = W * 0.5 + W * (0.10 + depth * 0.28) + i * 6;
      var th = H * (0.30 + depth * 0.28);
      var tw = W * (0.018 + depth * 0.030);
      var darkC = 'rgba(' + (8 + depth*5|0) + ',' + (6 + depth*3|0) + ',' + (2 + depth*2|0) + ',' + (0.82 + depth*0.1) + ')';
      ctx.save(); ctx.translate(bx, by);
      ctx.fillStyle = darkC;
      ctx.beginPath(); ctx.roundRect(-tw*0.4, 0, tw*0.8, -th*0.12, 2); ctx.fill();
      for (var li = 0; li < 3; li++) {
        var ly = -th * (0.10 + li * 0.18);
        var lw = tw * (2.5 - li * 0.3);
        var lh = th * (0.24 - li * 0.02);
        ctx.save(); ctx.rotate(sw * 0.007 * (li + 1));
        var tg = ctx.createLinearGradient(-lw*0.5, ly, lw*0.5, ly + lh);
        tg.addColorStop(0, darkC); tg.addColorStop(1, 'rgba(4,3,1,.95)');
        ctx.fillStyle = tg;
        ctx.beginPath(); ctx.ellipse(0, ly - lh*0.3, lw*0.55, lh*0.6, 0, 0, Math.PI*2); ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    }
  }

  function drawScene() {
    /* Background removed — scene canvas stays fully transparent */
    sctx.clearRect(0, 0, SW, SH);
  }

  /* ── Character animation state ───────────────────────────────── */
  var t = 0, breathPhase = 0, walkPhase = 0;
  var eyeGlow = 0.8;
  var mouseX = 0, targetLeanX = 0, leanX = 0;
  function gcwIsMobile(){ return window.innerWidth <= 768; }
  function gcwParticles(){ return gcwIsMobile()?(window.innerWidth<=480?16:28):42; }
  var PARTICLES = gcwParticles();

  var embers = [];
  for (var ei = 0; ei < PARTICLES; ei++) embers.push(newEmber());
  window.addEventListener('resize', function(){
    var np = gcwParticles();
    while(embers.length > np) embers.pop();
    while(embers.length < np) embers.push(newEmber());
  });
  function newEmber() {
    return {
      x: CW*0.3 + Math.random()*CW*0.4,
      y: CH*0.65 + Math.random()*CH*0.25,
      vx: (Math.random()-0.5)*0.35,
      vy: -(0.25 + Math.random()*0.9),
      life: Math.random(), max: 0.5 + Math.random()*0.7,
      sz: 0.7 + Math.random()*1.8, al: 0
    };
  }

  function cloakHem(cx, cy, rOff, phase) {
    var pts = [], segs = 18;
    for (var i = 0; i <= segs; i++) {
      var frac = i / segs, bx = cx - 130 + frac * 260;
      var tatter = Math.sin(frac * Math.PI * 5 + phase) * (3 + frac * (1-frac) * 14);
      pts.push([bx, cy + Math.sin(frac * Math.PI) * rOff + tatter]);
    }
    return pts;
  }

  /* Track mouse/touch for lean effect */
  window.addEventListener('mousemove', function(e) {
    mouseX = e.clientX / window.innerWidth - 0.5;
  });
  window.addEventListener('touchmove', function(e) {
    if (e.touches.length) mouseX = e.touches[0].clientX / window.innerWidth - 0.5;
  }, { passive: true });

  /* ── Character draw functions (exact match to source) ─────────── */
  function drawBoots(cx, baseY, lLeg, rLeg) {
    var by = baseY, bh = 30, bw = 19;
    cctx.save(); cctx.translate(cx-24+lLeg*0.4, by); cctx.rotate(lLeg*0.018);
    var bg = cctx.createLinearGradient(-bw*0.5, 0, bw*0.5, bh);
    bg.addColorStop(0, '#1a1510'); bg.addColorStop(1, '#0a0806');
    cctx.fillStyle = bg; cctx.beginPath(); cctx.roundRect(-bw*0.5,-bh,bw,bh,3); cctx.fill();
    cctx.strokeStyle = 'rgba(90,70,30,.28)'; cctx.lineWidth = 0.7; cctx.stroke();
    cctx.fillStyle = '#0d0b08'; cctx.beginPath(); cctx.roundRect(-bw*0.5-1,-2,bw+2,5,2); cctx.fill();
    cctx.restore();
    cctx.save(); cctx.translate(cx+24+rLeg*0.4, by); cctx.rotate(rLeg*0.018);
    cctx.fillStyle = bg; cctx.beginPath(); cctx.roundRect(-bw*0.5,-bh,bw,bh,3); cctx.fill();
    cctx.strokeStyle = 'rgba(90,70,30,.28)'; cctx.lineWidth = 0.7; cctx.stroke();
    cctx.fillStyle = '#0d0b08'; cctx.beginPath(); cctx.roundRect(-bw*0.5-1,-2,bw+2,5,2); cctx.fill();
    cctx.restore();
  }

  function drawRobe(cx, baseY, rt) {
    var top = baseY-420, bot = baseY;
    var rg = cctx.createLinearGradient(cx-70,top,cx+70,bot);
    rg.addColorStop(0,'#0f0d0a'); rg.addColorStop(0.5,'#141210'); rg.addColorStop(1,'#0a0807');
    cctx.fillStyle = rg;
    cctx.beginPath();
    cctx.moveTo(cx-54, top+42);
    cctx.bezierCurveTo(cx-68,top+100,cx-62+Math.sin(rt)*3.5,bot-120,cx-50,bot-50);
    cctx.lineTo(cx-32,bot); cctx.lineTo(cx+32,bot);
    cctx.lineTo(cx+50,bot-50);
    cctx.bezierCurveTo(cx+62+Math.sin(rt+1)*3.5,bot-120,cx+68,top+100,cx+54,top+42);
    cctx.closePath(); cctx.fill();
    cctx.save(); cctx.globalAlpha = 0.06; cctx.strokeStyle='#6a5020'; cctx.lineWidth=0.9;
    for (var fi = 0; fi < 7; fi++) {
      var fx = cx-44+fi*13, sw2 = Math.sin(rt+fi)*0.7;
      cctx.beginPath(); cctx.moveTo(fx,top+50); cctx.bezierCurveTo(fx+sw2,top+170,fx-sw2,bot-170,fx,bot-18); cctx.stroke();
    }
    cctx.restore();
  }

  function drawCloakBack(cx, baseY, rt) {
    var phase = rt*2.2, top = baseY-410, bot = baseY+8;
    cctx.save();
    var cg = cctx.createLinearGradient(cx-150,top,cx+165,bot);
    cg.addColorStop(0,'#0c0a07'); cg.addColorStop(0.45,'#111009'); cg.addColorStop(1,'#080604');
    cctx.fillStyle = cg;
    cctx.beginPath();
    cctx.moveTo(cx-8,top);
    cctx.bezierCurveTo(cx+90+Math.sin(rt)*12,top+42,cx+155+Math.sin(rt+0.8)*15,top+170,cx+165+Math.sin(rt+1.6)*12,bot-35);
    cctx.bezierCurveTo(cx+148,bot+16,cx+65,bot+12,cx+24,bot);
    cctx.lineTo(cx-24,bot);
    cctx.bezierCurveTo(cx-65,bot+6,cx-140,bot+6,cx-152+Math.sin(rt)*8,bot-42);
    cctx.bezierCurveTo(cx-165+Math.sin(rt+1)*13,top+170,cx-98+Math.sin(rt+0.5)*10,top+45,cx-8,top);
    cctx.closePath(); cctx.fill();
    var hem = cloakHem(cx, bot+6, 14, phase);
    cctx.globalAlpha = 1; cctx.fillStyle = '#080605';
    cctx.beginPath(); cctx.moveTo(cx-130, bot);
    for (var pi = 0; pi < hem.length; pi++) cctx.lineTo(hem[pi][0], hem[pi][1]);
    cctx.lineTo(cx+130, bot); cctx.closePath(); cctx.fill();
    cctx.restore();
  }

  function drawBelt(cx, by) {
    var bg = cctx.createLinearGradient(cx-46,by,cx+46,by+13);
    bg.addColorStop(0,'#1a1508'); bg.addColorStop(0.5,'#2a2010'); bg.addColorStop(1,'#151006');
    cctx.fillStyle = bg; cctx.beginPath(); cctx.roundRect(cx-47,by,94,13,2); cctx.fill();
    cctx.strokeStyle = 'rgba(140,100,30,.38)'; cctx.lineWidth = 0.9; cctx.stroke();
    cctx.save(); cctx.translate(cx, by+6.5);
    var bg2 = cctx.createRadialGradient(0,0,0,0,0,9);
    bg2.addColorStop(0,'#3a2e12'); bg2.addColorStop(1,'#0e0a04');
    cctx.fillStyle = bg2; cctx.beginPath(); cctx.arc(0,0,9,0,Math.PI*2); cctx.fill();
    cctx.strokeStyle = 'rgba(160,120,40,.65)'; cctx.lineWidth = 1.2; cctx.stroke();
    cctx.strokeStyle = 'rgba(160,120,40,.42)'; cctx.lineWidth = 0.8;
    for (var si = 0; si < 5; si++) {
      var a1 = (si*4*Math.PI/5)-Math.PI/2, a2 = ((si*4+2)*Math.PI/5)-Math.PI/2;
      cctx.beginPath(); cctx.moveTo(Math.cos(a1)*6.5,Math.sin(a1)*6.5);
      cctx.lineTo(Math.cos(a2)*6.5,Math.sin(a2)*6.5); cctx.stroke();
    }
    cctx.restore();
  }

  function drawCloakFront(cx, baseY, rt) {
    var top = baseY-395, bot = baseY-65, phase = rt*2.5;
    cctx.save();
    var lw = cctx.createLinearGradient(cx-115,top,cx,bot);
    lw.addColorStop(0,'#131108'); lw.addColorStop(0.6,'#0e0c07'); lw.addColorStop(1,'#060503');
    cctx.fillStyle = lw;
    cctx.beginPath();
    cctx.moveTo(cx-42,top+16);
    cctx.bezierCurveTo(cx-115+Math.sin(rt)*7,top+85,cx-130+Math.sin(rt+0.6)*10,bot-50,cx-105+Math.sin(rt+1.2)*8,bot+24);
    cctx.bezierCurveTo(cx-65,bot+48,cx-25,bot+8,cx-15,bot-25);
    cctx.closePath(); cctx.fill();
    cctx.strokeStyle='#0a0806'; cctx.lineWidth=1.8; cctx.globalAlpha=0.88;
    for (var ti = 0; ti < 4; ti++) {
      var tx = cx-105+ti*16+Math.sin(rt+ti)*3, ty = bot+16+ti*7;
      cctx.beginPath(); cctx.moveTo(tx,bot-4); cctx.lineTo(tx-6+Math.sin(phase+ti)*4,ty); cctx.stroke();
    }
    cctx.restore();
    cctx.save();
    var rw = cctx.createLinearGradient(cx,top,cx+98,bot);
    rw.addColorStop(0,'#141208'); rw.addColorStop(0.6,'#0f0d08'); rw.addColorStop(1,'#060504');
    cctx.fillStyle = rw;
    cctx.beginPath();
    cctx.moveTo(cx+42,top+16);
    cctx.bezierCurveTo(cx+82+Math.sin(rt+0.4)*7,top+100,cx+74+Math.sin(rt+1)*8,bot-34,cx+62+Math.sin(rt+1.8)*6,bot+8);
    cctx.bezierCurveTo(cx+42,bot+24,cx+16,bot+4,cx+15,bot-25);
    cctx.closePath(); cctx.fill();
    cctx.restore();
    drawBelt(cx, baseY-225);
  }

  function drawScytheArm(cx, baseY, rt, walk) {
    var sw = Math.sin(t*0.008)*2.2 + walk*0.28;
    var shX=cx-60, shY=baseY-318, handX=cx-84, handY=baseY-150;
    cctx.save();
    cctx.fillStyle = '#0e0c08';
    cctx.beginPath(); cctx.moveTo(shX,shY);
    cctx.bezierCurveTo(shX-18,shY+50,shX-25+sw,handY-50,handX,handY);
    cctx.bezierCurveTo(handX-12,handY,handX-10,shY+65,shX-15,shY);
    cctx.closePath(); cctx.fill();
    var gg = cctx.createRadialGradient(handX,handY,0,handX,handY,14);
    gg.addColorStop(0,'#1a1510'); gg.addColorStop(1,'#0a0806');
    cctx.fillStyle=gg; cctx.beginPath(); cctx.ellipse(handX,handY,11,14,0.18,0,Math.PI*2); cctx.fill();
    cctx.strokeStyle='rgba(100,75,30,.28)'; cctx.lineWidth=0.7; cctx.stroke();
    /* staff */
    cctx.save(); cctx.translate(handX+3,handY-6); cctx.rotate(sw*0.018+0.05);
    var sg = cctx.createLinearGradient(-3,-130,3,-130);
    sg.addColorStop(0,'#303028'); sg.addColorStop(0.5,'#585848'); sg.addColorStop(1,'#242420');
    cctx.strokeStyle=sg; cctx.lineWidth=6; cctx.lineCap='round';
    cctx.beginPath(); cctx.moveTo(0,0); cctx.lineTo(15,-178); cctx.stroke();
    /* blade */
    cctx.save(); cctx.translate(15,-178);
    var blg = cctx.createLinearGradient(0,0,108,52);
    blg.addColorStop(0,'#c8c4b0'); blg.addColorStop(0.15,'#e8e4d0');
    blg.addColorStop(0.4,'#b8b4a0'); blg.addColorStop(0.7,'#787468'); blg.addColorStop(1,'#404038');
    cctx.fillStyle = blg;
    cctx.beginPath(); cctx.moveTo(0,0);
    cctx.bezierCurveTo(24,-14,96,-6,108,22);
    cctx.bezierCurveTo(104,40,77,45,55,30);
    cctx.bezierCurveTo(32,17,11,12,0,0);
    cctx.closePath(); cctx.fill();
    cctx.strokeStyle='rgba(255,248,220,.55)'; cctx.lineWidth=1;
    cctx.beginPath(); cctx.moveTo(0,0); cctx.bezierCurveTo(24,-14,96,-6,108,22); cctx.stroke();
    cctx.restore(); cctx.restore(); cctx.restore();
  }

  function drawRightArm(cx, baseY, rt, walk) {
    var sw = -Math.sin(t*0.008)*2.2 + walk*0.28;
    var shX=cx+56, shY=baseY-312, handX=cx+76, handY=baseY-170;
    cctx.save();
    cctx.fillStyle='#0e0c08';
    cctx.beginPath(); cctx.moveTo(shX,shY);
    cctx.bezierCurveTo(shX+16,shY+45,shX+22+sw,handY-42,handX,handY);
    cctx.bezierCurveTo(handX+12,handY,handX+8,shY+62,shX+13,shY);
    cctx.closePath(); cctx.fill();
    var gg = cctx.createRadialGradient(handX,handY,0,handX,handY,13);
    gg.addColorStop(0,'#1a1510'); gg.addColorStop(1,'#0a0806');
    cctx.fillStyle=gg; cctx.beginPath(); cctx.ellipse(handX,handY,11,14,-0.16,0,Math.PI*2); cctx.fill();
    cctx.strokeStyle='rgba(100,75,30,.28)'; cctx.lineWidth=0.7; cctx.stroke();
    for (var fi = 0; fi < 4; fi++) {
      cctx.strokeStyle='#0e0c08'; cctx.lineWidth=3.5; cctx.lineCap='round';
      cctx.beginPath(); cctx.moveTo(handX-6+fi*4,handY-2); cctx.lineTo(handX-8+fi*4,handY+13); cctx.stroke();
    }
    cctx.restore();
  }

  function drawSkullFace(cx, cy, mAmt) {
    var sg = cctx.createRadialGradient(cx-6,cy-18,3,cx,cy-6,37);
    sg.addColorStop(0,'#e8d88a'); sg.addColorStop(0.22,'#c8aa48');
    sg.addColorStop(0.52,'#9a7820'); sg.addColorStop(0.82,'#6a4c0e'); sg.addColorStop(1,'#2a1a04');
    cctx.fillStyle=sg;
    cctx.beginPath(); cctx.ellipse(cx,cy-12,30,35,0,0,Math.PI*2); cctx.fill();
    /* cranium shadow */
    cctx.save(); cctx.globalCompositeOperation='multiply';
    var ss = cctx.createRadialGradient(cx-24,cy-14,0,cx-18,cy-8,30);
    ss.addColorStop(0,'rgba(0,0,0,.5)'); ss.addColorStop(1,'rgba(0,0,0,0)');
    cctx.fillStyle=ss; cctx.beginPath(); cctx.ellipse(cx-12,cy-10,28,32,0,0,Math.PI*2); cctx.fill();
    cctx.restore();
    /* eye sockets */
    cctx.fillStyle='#100800';
    cctx.beginPath(); cctx.ellipse(cx-12,cy-18,11,8,0.28,0,Math.PI*2); cctx.fill();
    cctx.beginPath(); cctx.ellipse(cx+12,cy-18,11,8,-0.28,0,Math.PI*2); cctx.fill();
    /* eye glow */
    cctx.save(); cctx.globalCompositeOperation='lighter';
    var elG = cctx.createRadialGradient(cx-12,cy-18,0,cx-12,cy-18,14*eyeGlow);
    elG.addColorStop(0,'rgba(255,230,120,'+(0.9*eyeGlow)+')');
    elG.addColorStop(0.3,'rgba(220,160,40,'+(0.6*eyeGlow)+')');
    elG.addColorStop(1,'rgba(0,0,0,0)');
    cctx.fillStyle=elG; cctx.beginPath(); cctx.ellipse(cx-12,cy-18,13*eyeGlow,10*eyeGlow,0.28,0,Math.PI*2); cctx.fill();
    var erG = cctx.createRadialGradient(cx+12,cy-18,0,cx+12,cy-18,14*eyeGlow);
    erG.addColorStop(0,'rgba(255,230,120,'+(0.9*eyeGlow)+')');
    erG.addColorStop(0.3,'rgba(220,160,40,'+(0.6*eyeGlow)+')');
    erG.addColorStop(1,'rgba(0,0,0,0)');
    cctx.fillStyle=erG; cctx.beginPath(); cctx.ellipse(cx+12,cy-18,13*eyeGlow,10*eyeGlow,-0.28,0,Math.PI*2); cctx.fill();
    cctx.restore();
    /* nose */
    cctx.fillStyle='rgba(20,10,2,.78)';
    cctx.beginPath(); cctx.moveTo(cx,cy+1); cctx.lineTo(cx-4,cy+9); cctx.lineTo(cx,cy+7); cctx.lineTo(cx+4,cy+9); cctx.closePath(); cctx.fill();
    /* jaw & teeth */
    var mY = cy+14+mAmt*6, mH = 3+mAmt*11;
    cctx.fillStyle='#0a0500';
    cctx.beginPath();
    cctx.moveTo(cx-22,cy+11); cctx.bezierCurveTo(cx-25,cy+14,cx-22,cy+22+mAmt*5,cx-16,cy+24+mAmt*6);
    cctx.lineTo(cx,cy+25+mAmt*7); cctx.lineTo(cx+16,cy+24+mAmt*6);
    cctx.bezierCurveTo(cx+22,cy+22+mAmt*5,cx+25,cy+14,cx+22,cy+11); cctx.fill();
    /* upper teeth */
    cctx.fillStyle='#ded090';
    var tw = 30/6;
    for (var ti = 0; ti < 6; ti++) {
      cctx.beginPath(); cctx.roundRect(cx-15+ti*tw+0.5,mY-mH*0.5,tw-1.2,Math.min(mH*0.55,7.5),1.2); cctx.fill();
    }
    if (mAmt > 0.12) {
      cctx.fillStyle='#d0c080';
      for (var tli = 0; tli < 5; tli++) {
        cctx.beginPath(); cctx.roundRect(cx-11.5+tli*(26/5)+0.5,mY+mH-Math.min(mH*0.5,6),26/5-1.2,Math.min(mH*0.5,6),1.2); cctx.fill();
      }
    }
    cctx.fillStyle='rgba(4,2,0,.88)';
    cctx.beginPath(); cctx.roundRect(cx-15,mY,30,mH,2); cctx.fill();
  }

  function drawHoodAndSkull(cx, baseY, mAmt) {
    var headCY = baseY-395;
    cctx.fillStyle='#0c0a07';
    cctx.beginPath(); cctx.ellipse(cx,headCY+76,18,22,0,0,Math.PI*2); cctx.fill();
    var hg = cctx.createRadialGradient(cx,headCY-24,6,cx,headCY,72);
    hg.addColorStop(0,'#16140f'); hg.addColorStop(0.5,'#0e0c08'); hg.addColorStop(1,'rgba(4,3,2,0)');
    cctx.fillStyle=hg;
    cctx.beginPath();
    cctx.moveTo(cx,headCY-92);
    cctx.bezierCurveTo(cx+58,headCY-80,cx+66,headCY-30,cx+51,headCY+42);
    cctx.bezierCurveTo(cx+35,headCY+62,cx+16,headCY+70,cx,headCY+72);
    cctx.bezierCurveTo(cx-16,headCY+70,cx-35,headCY+62,cx-51,headCY+42);
    cctx.bezierCurveTo(cx-66,headCY-30,cx-58,headCY-80,cx,headCY-92);
    cctx.closePath(); cctx.fill();
    /* deep hood shadow */
    var hs = cctx.createRadialGradient(cx,headCY+8,2,cx,headCY-6,50);
    hs.addColorStop(0,'rgba(0,0,0,.95)'); hs.addColorStop(0.55,'rgba(0,0,0,.80)'); hs.addColorStop(1,'rgba(0,0,0,0)');
    cctx.fillStyle=hs;
    cctx.beginPath(); cctx.ellipse(cx,headCY+4,48,50,0,0,Math.PI*2); cctx.fill();
    /* rim light */
    cctx.save(); cctx.globalCompositeOperation='screen';
    var rim = cctx.createLinearGradient(cx-56,headCY-92,cx+56,headCY-65);
    rim.addColorStop(0,'rgba(0,0,0,0)'); rim.addColorStop(0.45,'rgba(180,120,30,.14)');
    rim.addColorStop(0.55,'rgba(200,140,40,.18)'); rim.addColorStop(1,'rgba(0,0,0,0)');
    cctx.fillStyle=rim; cctx.beginPath(); cctx.ellipse(cx,headCY-78,55,11,0,0,Math.PI*2); cctx.fill();
    cctx.restore();
    drawSkullFace(cx, headCY+8, mAmt);
  }

  function drawGrim(cx, baseY, walk, breathe, mAmt) {
    var rt = t * 0.009;
    var lLeg = Math.sin(walkPhase)*16, rLeg = -Math.sin(walkPhase)*16;
    drawBoots(cx, baseY, lLeg, rLeg);
    drawRobe(cx, baseY, rt, breathe);
    drawCloakBack(cx, baseY, rt);
    drawScytheArm(cx, baseY, rt, walk);
    drawRightArm(cx, baseY, rt, walk);
    drawCloakFront(cx, baseY, rt);
    drawHoodAndSkull(cx, baseY, mAmt);
  }

  /* ── Main character frame ─────────────────────────────────── */
  function drawChar() {
    t++; breathPhase += 0.019; walkPhase += 0.028;
    targetLeanX = mouseX * 8;
    leanX += (targetLeanX - leanX) * 0.06;
    eyeGlow = 0.55 + 0.45 * Math.sin(t * 0.048);

    cctx.clearRect(0, 0, CW, CH);

    var cx      = CW * 0.5 + leanX;
    var groundY = CH * 0.92;
    var walk    = Math.sin(walkPhase) * 3;
    var walkBob = Math.abs(Math.sin(walkPhase)) * 3.5;
    var breathe = Math.sin(breathPhase) * 2;
    var baseY   = groundY - 8 - walkBob;

    /* Aura */
    var aura = cctx.createRadialGradient(cx,CH*0.18,8,cx,CH*0.28,CW*0.58);
    aura.addColorStop(0,'rgba(200,145,45,.28)');
    aura.addColorStop(0.35,'rgba(160,100,20,.14)');
    aura.addColorStop(1,'rgba(0,0,0,0)');
    cctx.fillStyle=aura; cctx.fillRect(0,0,CW,CH);

    /* Ground shadow */
    var gs = cctx.createRadialGradient(cx,groundY,2,cx,groundY,80);
    gs.addColorStop(0,'rgba(0,0,0,.5)'); gs.addColorStop(1,'rgba(0,0,0,0)');
    cctx.fillStyle=gs; cctx.beginPath(); cctx.ellipse(cx,groundY-4,72,12,0,0,Math.PI*2); cctx.fill();

    drawGrim(cx, baseY, walk, breathe, 0);

    /* Embers */
    cctx.save(); cctx.globalCompositeOperation='screen';
    for (var i = 0; i < embers.length; i++) {
      var e = embers[i];
      e.life += 0.012; e.x += e.vx + Math.sin(e.life*4)*0.18; e.y += e.vy;
      if (e.life >= e.max) { embers[i] = newEmber(); continue; }
      var ep = e.life/e.max, ea = (1-ep)*e.al*1.1;
      if (ea <= 0) { e.al = 0.12+Math.random()*0.45; continue; }
      cctx.globalAlpha = ea;
      var eg2 = cctx.createRadialGradient(e.x,e.y,0,e.x,e.y,e.sz*2.2);
      eg2.addColorStop(0,'rgba(255,220,120,1)'); eg2.addColorStop(0.5,'rgba(220,140,30,.55)'); eg2.addColorStop(1,'rgba(0,0,0,0)');
      cctx.fillStyle=eg2; cctx.beginPath(); cctx.arc(e.x,e.y,e.sz*2.2,0,Math.PI*2); cctx.fill();
    }
    cctx.restore();
  }

  /* ── Main loop ─────────────────────────────────────────────── */
  function loop() {
    drawScene();
    drawChar();
    requestAnimationFrame(loop);
  }

  /* ── Lazy init via IntersectionObserver / requestIdleCallback ── */
  /* ── Idle-fade system ────────────────────────────────────────── */
  var idleTimer = null;
  var idleDelay = 6000; /* ms before fading */

  function gcwWake() {
    if (!root) return;
    root.classList.remove('gcw-idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(gcwGoIdle, idleDelay);
  }

  function gcwGoIdle() {
    if (!root) return;
    root.classList.add('gcw-idle');
  }

  function gcwInitIdleFade() {
    /* Wake on any pointer interaction with the character */
    root.addEventListener('mouseenter', gcwWake);
    root.addEventListener('touchstart', gcwWake, { passive: true });
    /* Wake when speech bubble opens — GrimSpeech dispatches a custom event */
    document.addEventListener('grimBubbleShow', gcwWake);
    /* Start idle countdown */
    gcwWake();
  }

  var ready = false;
  function start() {
    buildDOM();
    applyPosition(CFG.position, CFG.offsetX, CFG.offsetY);
    applySize(CFG.size);
    gcwInitIdleFade();
    ready = true;
    /* Responsive resize + orientation change (some Android only fires orientationchange) */
    function onViewportChange() { applySize(CFG.size); }
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', function() {
      setTimeout(onViewportChange, 150);
    });
    loop();
  }

  /* Use requestIdleCallback when available so the widget doesn't
     block the initial page render. Falls back to setTimeout 0. */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      if (global.requestIdleCallback) {
        global.requestIdleCallback(start, { timeout: 2000 });
      } else {
        setTimeout(start, 0);
      }
    });
  } else {
    if (global.requestIdleCallback) {
      global.requestIdleCallback(start, { timeout: 2000 });
    } else {
      setTimeout(start, 0);
    }
  }

  /* ── Public API ─────────────────────────────────────────────── */
  global.GrimChar = {
    setPosition: function(pos, offX, offY) {
      CFG.position = pos;
      if (offX !== undefined) CFG.offsetX = offX;
      if (offY !== undefined) CFG.offsetY = offY;
      if (ready) applyPosition(CFG.position, CFG.offsetX, CFG.offsetY);
    },
    setSize: function(sz) {
      CFG.size = sz;
      if (ready) applySize(sz);
    },
    setOffset: function(offX, offY) {
      CFG.offsetX = offX;
      CFG.offsetY = offY;
      if (ready) applyPosition(CFG.position, CFG.offsetX, CFG.offsetY);
    },
    /** Wake from idle immediately (call when opening conversation) */
    wake: gcwWake
  };

}(window));
