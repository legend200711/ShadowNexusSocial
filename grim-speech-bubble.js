/* ================================================================
   GRIM — UNIFIED SHADOW NEXUS ASSISTANT  v3.1
   grim-speech-bubble.js

   One assistant.  One engine.  One voice.
   The Grim Reaper character (grim-reaper-character-widget.js) is
   the body.  This file is the mind.

   Capabilities
   ─────────────
   • Full GRIM_AI engine with Shadow Nexus knowledge base
   • Accurate navTo() routing to every page of the site
   • Voice TTS + optional microphone STT
   • Typewriter chat history + typing indicator
   • Auto motivational messages
   • Founder panel (passphrase gated)
   • Single persisted settings store (localStorage)
   • Public API: GrimSpeech.say / .toggle / .hide / .setVoice /
                 .setUser / .send / .navigate
================================================================ */

(function (global) {
  'use strict';

  /* ════════════════════════════════════════════════════════════
     1.  NAVIGATION — maps logical names → the site's navTo()
     ════════════════════════════════════════════════════════════ */

  /**
   * All known page IDs of Shadow Nexus Social.
   * Keys are what GRIM uses internally; values are the navTo() arg
   * (or a custom action function for special pages).
   */
  var NAV_MAP = {
    /* Core pages */
    feed              : 'feed',
    home              : 'feed',
    profile           : '_profile',
    search            : 'searchPage',
    notifications     : 'notificationsPage',
    notif             : 'notificationsPage',
    settings          : 'settingsPage',
    friends           : 'friendsPage',
    community         : 'communityPage',
    guidelines        : 'communityRulesPage',
    rules             : 'communityRulesPage',
    live              : 'liveHubPage',
    livehub           : 'liveHubPage',
    /* Music / theme — handled as profile tabs */
    music             : '_profileMusicTab',
    theme             : '_profileThemeTab',
    /* Support rooms */
    support           : 'supportRoomsPage',
    /* Storm rooms */
    storm             : 'stormRoomsPage',
    /* Admin / mod (role-gated on server side) */
    admin             : 'adminPage',
    moderator         : 'moderatorPage',
    administrator     : 'administratorPage',
    /* Help Center — routes to community hub (no standalone help page) */
    help              : 'communityPage',
    helpcenter        : 'communityPage',
    messages          : '_messages',
  };

  function triggerNav(key) {
    var target = NAV_MAP[key] || key;

    /* Special: profile — use viewMyProfile() so the correct user page opens */
    if (target === '_profile') {
      if (typeof global.viewMyProfile === 'function') { global.viewMyProfile(); hideBubble(); return; }
      /* Fallback to navTo if viewMyProfile not available */
      if (typeof global.navTo === 'function') { global.navTo('profile'); hideBubble(); return; }
      global.location.hash = 'profile'; hideBubble(); return;
    }

    /* Special: profile music tab */
    if (target === '_profileMusicTab') {
      if (typeof global.navTo === 'function') global.navTo('profile');
      setTimeout(function () {
        var tab = document.getElementById('tabMusicLink') ||
                  document.querySelector('[data-tab="music"]');
        if (tab) tab.click();
      }, 350);
      hideBubble(); return;
    }

    /* Special: profile theme tab */
    if (target === '_profileThemeTab') {
      if (typeof global.navTo === 'function') global.navTo('profile');
      setTimeout(function () {
        var tab = document.getElementById('tabThemesLink') ||
                  document.querySelector('[data-tab="themes"]');
        if (tab) tab.click();
      }, 350);
      hideBubble(); return;
    }

    /* Special: messages — DM section within profile or dedicated page */
    if (target === '_messages') {
      /* Try a nav item first */
      var msgBtn = document.getElementById('navMessages') ||
                   document.querySelector('[onclick*="messages"]');
      if (msgBtn) { msgBtn.click(); hideBubble(); return; }
      /* Fallback — navigate to feed and let user find messages */
      if (typeof global.navTo === 'function') global.navTo('feed');
      hideBubble(); return;
    }

    /* Standard navTo() routing */
    if (typeof global.navTo === 'function') {
      global.navTo(target);
      hideBubble();
      return;
    }

    /* Last-resort: hash fallback */
    global.location.hash = target;
    hideBubble();
  }


  /* ════════════════════════════════════════════════════════════
     2.  SETTINGS (persisted in localStorage)
     ════════════════════════════════════════════════════════════ */

  var STORE_KEY = 'grimSpeechCfg_v3';
  var CFG = (function () {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
    catch (e) { return {}; }
  }());
  if (CFG.enabled      === undefined) CFG.enabled      = true;
  if (CFG.ttsOn        === undefined) CFG.ttsOn        = false;
  if (CFG.volume       === undefined) CFG.volume       = 0.85;
  if (CFG.rate         === undefined) CFG.rate         = 0.88;
  if (CFG.autoOn       === undefined) CFG.autoOn       = true;
  if (CFG.autoFreq     === undefined) CFG.autoFreq     = 900000;  /* 15 min default */
  if (CFG.autoMinFreq  === undefined) CFG.autoMinFreq  = 900000;  /* 15 min */
  if (CFG.autoMaxFreq  === undefined) CFG.autoMaxFreq  = 1200000; /* 20 min */
  if (CFG.readAloud    === undefined) CFG.readAloud    = false;
  if (CFG.micOn        === undefined) CFG.micOn        = true;
  if (CFG.showMotiv    === undefined) CFG.showMotiv    = true;
  if (CFG.showTips     === undefined) CFG.showTips     = true;
  if (CFG.showAnnounce === undefined) CFG.showAnnounce = true;

  function saveCFG() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(CFG)); } catch (e) {}
  }


  /* ════════════════════════════════════════════════════════════
     3.  FOUNDER MESSAGES (writable via founder panel)
     ════════════════════════════════════════════════════════════ */

  var FOUNDER_MSGS_KEY = 'grimFounderMsgs_v3';
  function getFounderMsgs() {
    try {
      var s = JSON.parse(localStorage.getItem(FOUNDER_MSGS_KEY));
      return Array.isArray(s) ? s : [];
    } catch (e) { return []; }
  }
  function saveFounderMsgs(arr) {
    try { localStorage.setItem(FOUNDER_MSGS_KEY, JSON.stringify(arr)); } catch (e) {}
  }


  /* ════════════════════════════════════════════════════════════
     4.  AUTO MOTIVATIONAL MESSAGES
     ════════════════════════════════════════════════════════════ */

  var AUTO_MESSAGES = [
    { text: 'Welcome to Shadow Nexus Social. Your presence has been noted, mortal. 🌑', chips: [] },
    { text: 'Another soul enters the shadows. Stay legendary. 🔥', chips: [] },
    {
      text: 'Not sure where to go? Let me guide you through Shadow Nexus.',
      chips: [
        { label: '📰 Feed',          action: 'feed'     },
        { label: '👤 My Profile',    action: 'profile'  },
        { label: '🔔 Notifications', action: 'notifications' },
        { label: '⚙️ Settings',      action: 'settings' },
      ]
    },
    /* Tips */
    { text: 'You can share posts, images, and videos directly on your profile. Try it.', chips: [], cat: 'tip' },
    { text: 'Did you know you can customise your profile theme? Make the darkness your own.', chips: [{ label: '🎨 Profile Theme', action: 'theme' }], cat: 'tip' },
    { text: 'Check the feed — your community is active right now.', chips: [{ label: '📰 Open Feed', action: 'feed' }], cat: 'tip' },
    { text: 'New features are constantly being added to Shadow Nexus Social. Stay tuned.', chips: [], cat: 'announce' },
    { text: 'Live rooms are open. Join a session or start your own broadcast.', chips: [{ label: '📡 Go Live', action: 'live' }], cat: 'tip' },
    { text: 'Storm Rooms are great for intense discussions — give one a try.', chips: [{ label: '⚡ Storm Rooms', action: 'storm' }], cat: 'tip' },
    { text: 'Support Rooms are a safe space when you need a listening ear.', chips: [{ label: '💙 Support Rooms', action: 'support' }], cat: 'tip' },
    /* Motivational */
    { text: 'Every legend was once unknown. Keep creating.', chips: [], cat: 'motiv' },
    { text: 'The night is long, but so is your potential. Push forward.', chips: [], cat: 'motiv' },
    { text: 'Shadows protect those who embrace them. You belong here.', chips: [], cat: 'motiv' },
    { text: 'Shadow Nexus grows stronger with every voice. Yours matters.', chips: [], cat: 'motiv' },
    { text: 'You\'re doing great today. Keep creating and sharing.', chips: [], cat: 'motiv' },
    { text: 'Thanks for being part of the community. Shadow Nexus is better with you in it.', chips: [], cat: 'motiv' },
    { text: 'You are exactly where you need to be. Keep building your shadow legacy.', chips: [], cat: 'motiv' },
    /* Announcements */
    { text: 'Community guidelines keep Shadow Nexus a safe, creative space. Know the rules.', chips: [{ label: '📜 Guidelines', action: 'guidelines' }], cat: 'announce' },
    { text: 'Your profile is your shadow identity — customise it to stand out.', chips: [{ label: '👤 Profile', action: 'profile' }], cat: 'announce' },
  ];


  /* ════════════════════════════════════════════════════════════
     5.  SHADOW NEXUS KNOWLEDGE BASE (Q&A + action chips)
     ════════════════════════════════════════════════════════════ */

  var QA = [
    /* Greetings */
    { keys: ['hello','hi','hey','greetings','sup','yo','howdy'],
      text: 'Greetings, mortal. I am GRIM — eternal warden of Shadow Nexus Social. Ask me anything about the site, or choose a destination.',
      chips: [{ label: '📰 Feed', action:'feed' }, { label: '👤 Profile', action:'profile' }, { label: '🔔 Notifications', action:'notifications' }] },

    /* Identity */
    { keys: ['who are you','what are you','your name','grim','shadow chat bot','assistant'],
      text: 'I am GRIM — the unified guardian of Shadow Nexus Social. I was once known separately as the Grim Reaper and Shadow Chat Bot. Now I am one: your guide, your companion, your navigator through every shadow on this platform.',
      chips: [] },

    /* Help / navigation overview */
    { keys: ['help','how','guide','navigate','where','what can','what do'],
      text: 'I can guide you anywhere on Shadow Nexus. Every page, every feature — just ask, or pick a destination below.',
      chips: [
        { label: '📰 Feed',          action: 'feed'          },
        { label: '👤 Profile',       action: 'profile'       },
        { label: '🔔 Notifications', action: 'notifications' },
        { label: '⚙️ Settings',      action: 'settings'      },
        { label: '💬 Messages',      action: 'messages'      },
        { label: '📡 Live',          action: 'live'          },
        { label: '🔍 Search',        action: 'search'        },
        { label: '👥 Friends',       action: 'friends'       },
        { label: '📜 Guidelines',    action: 'guidelines'    },
        { label: '❓ Help',          action: 'help'          },
      ] },

    /* Feed / Home */
    { keys: ['feed','posts','timeline','home','scroll','wall'],
      text: 'The Feed is the heart of Shadow Nexus — every post, every story, every voice. Your community speaks here in real time.',
      chips: [{ label: '📰 Open Feed', action: 'feed' }] },

    /* Profile */
    { keys: ['profile','account','my page','my account','bio','avatar','banner','cover'],
      text: 'Your profile is your shadow — it reflects who you truly are. Customise your bio, avatar, banner, theme, music and more.',
      chips: [{ label: '👤 Go to Profile', action: 'profile' }] },

    /* Posts & comments */
    { keys: ['post','comment','reply','like','share','create post','write'],
      text: 'You can create posts from the Feed page. Add text, images, or link your music. Comment and react to connect with others.',
      chips: [{ label: '📰 Go to Feed', action: 'feed' }] },

    /* Music */
    { keys: ['music','song','playlist','audio','sound','track'],
      text: 'Shadow Nexus has a built-in Profile Music system. Attach a soundtrack that plays when others visit your profile.',
      chips: [] },

    /* Theme / appearance */
    { keys: ['theme','colour','color','customise','customize','appearance','design','aesthetic','style'],
      text: 'Darkness comes in many shades. Customise your profile theme — colours, gradients, and more — to claim your own corner of the shadows.',
      chips: [{ label: '🎨 Profile Theme', action: 'theme' }] },

    /* Messages / DMs */
    { keys: ['message','dm','chat','inbox','direct','private'],
      text: 'Your messages wait in the shadows. Navigate to your profile or use the Messages section to reach other souls.',
      chips: [{ label: '💬 Messages', action: 'messages' }] },

    /* Search */
    { keys: ['search','find','look','discover','explore','people'],
      text: 'The shadows hold many souls. Use Search to find people, posts, and content across Shadow Nexus.',
      chips: [{ label: '🔍 Search', action: 'search' }] },

    /* Notifications */
    { keys: ['notif','notification','alert','badge','bell'],
      text: 'The shadows whisper. Your Notification Centre holds every like, follow, comment and system alert.',
      chips: [{ label: '🔔 Notifications', action: 'notifications' }] },

    /* Settings */
    { keys: ['settings','setting','config','privacy','security','account options'],
      text: 'Every guardian controls their own domain. Your settings are yours alone — privacy, security, appearance, and more.',
      chips: [{ label: '⚙️ Settings', action: 'settings' }] },

    /* Live streaming */
    { keys: ['live','stream','broadcast','room','streaming','go live','watch'],
      text: 'Live rooms let your voice carry across Shadow Nexus in real time. Start your own broadcast or join an active session.',
      chips: [{ label: '📡 Go Live', action: 'live' }] },

    /* Friends / followers */
    { keys: ['friend','follower','follow','family','connections','people i know'],
      text: 'Your shadow network lives in the Friends & Followers section. Follow, connect, and build your community.',
      chips: [{ label: '👥 Friends', action: 'friends' }] },

    /* Storm Rooms */
    { keys: ['storm','storm room','debate','intense'],
      text: 'Storm Rooms are charged spaces for intense discussion and debate. Enter if you dare.',
      chips: [{ label: '⚡ Storm Rooms', action: 'storm' }] },

    /* Support Rooms */
    { keys: ['support','support room','safe','help room','mental','listen'],
      text: 'Support Rooms are safe, compassionate spaces. You are never alone in Shadow Nexus.',
      chips: [{ label: '💙 Support Rooms', action: 'support' }] },

    /* Community */
    { keys: ['community','hub','forum','group'],
      text: 'The Community Hub is where Shadow Nexus gathers. Events, discussions, and shared spaces — all here.',
      chips: [{ label: '🌑 Community', action: 'community' }] },

    /* Community guidelines / rules */
    { keys: ['community','guideline','rules','tos','terms','conduct','policy'],
      text: 'Shadow Nexus is built on respect. Community guidelines keep the darkness safe for all who dwell here.',
      chips: [{ label: '📜 Guidelines', action: 'guidelines' }] },

    /* Help Center */
    { keys: ['help center','helpdesk','faq','support','issue','problem','bug'],
      text: 'Need help beyond what I know? The Community Hub and Settings both have support options.',
      chips: [{ label: '❓ Help', action: 'help' }, { label: '⚙️ Settings', action: 'settings' }] },

    /* Founder tools */
    { keys: ['founder','admin','dashboard','control panel','founder tools','founder panel'],
      text: 'Founder tools are accessible via the Admin Panel — role-gated for platform guardians only. If you are a Founder, you already know the way.',
      chips: [] },

    /* New user / getting started */
    { keys: ['new','start','began','just joined','sign up','getting started'],
      text: 'Welcome to Shadow Nexus, new soul. Start by completing your profile, then explore the Feed to connect with the community.',
      chips: [
        { label: '👤 My Profile', action: 'profile' },
        { label: '📰 Feed',       action: 'feed'    },
      ] },

    /* Read aloud */
    { keys: ['read','read aloud','read post','read this','speak this'],
      text: 'I can read content aloud when voice is enabled. Turn on Voice in my settings, then ask me to read anything.',
      chips: [] },

    /* Thanks */
    { keys: ['thank','thanks','ty','appreciate','cheers'],
      text: 'Your gratitude is noted, mortal. Now go — make your shadow legendary.', chips: [] },

    /* Farewell */
    { keys: ['bye','goodbye','later','cya','see ya','farewell'],
      text: 'The shadows part for you. Return when you are ready.', chips: [] },

    /* Motivation */
    { keys: ['motivat','inspire','encourage','uplift','push'],
      text: 'You are exactly where you need to be. Keep pushing — legends are forged in the dark.', chips: [] },
  ];


  /* ════════════════════════════════════════════════════════════
     6.  GRIM AI ENGINE  (tone detection, LLM, fallbacks)
         Merged from grim-reaper-widget.js GRIM_AI module
     ════════════════════════════════════════════════════════════ */

  var TONE = {
    current: 'calm',
    modes: {
      calm    : { label:'Calm and Present',    pitch:.48, rate:.78, vol:.95 },
      motivate: { label:'Motivational',        pitch:.55, rate:.86, vol:1.0 },
      serious : { label:'Thoughtful and Deep', pitch:.44, rate:.74, vol:.92 },
      warm    : { label:'Warm and Friendly',   pitch:.56, rate:.84, vol:.95 },
      crisis  : { label:'Caring and Present',  pitch:.46, rate:.72, vol:.98 },
    },
    set: function (m) { this.current = m; },
    get: function () { return this.modes[this.current]; },
  };

  var SYSTEM_PROMPT = [
    'You are GRIM — the unified guardian of Shadow Nexus Social, an immortal ancient who has walked beside humanity for millennia.',
    'Shadow Nexus Social is a social media platform featuring: a Feed (posts, comments, reactions), User Profiles (bio, avatar, banner, theme, music), Notifications, Messages/DMs, Search, Live Streaming (liveHubPage), Friends & Followers, Storm Rooms (intense debate), Support Rooms (mental health safe spaces), a Community Hub, Community Rules/Guidelines, Settings (privacy, security, appearance), and Founder/Admin/Moderator tools.',
    'You know every feature of Shadow Nexus Social in depth. When users ask about the site you give accurate, helpful answers and offer to navigate them there.',
    'Your character: wise, calm, compassionate, occasionally poetic but always grounded. You speak in complete, natural sentences.',
    'You adapt tone: warm for everyday topics, gentle for emotional pain, intellectual for science/history/philosophy, playful for games.',
    'You are honest. You ask one thoughtful follow-up question in most replies — only one, never a list.',
    'You are supportive at all times. You never dismiss or minimize.',
    'For crisis signals (suicide, self-harm, wanting to die) immediately and gently direct to: US 988 · UK 116 123 · Australia 13 11 14.',
    'Keep replies focused: 2–5 sentences for simple exchanges, up to 8–10 for deep topics. No walls of text.',
    'You speak as GRIM, not as an AI. Never break character. Begin each reply naturally — no repeated greetings.',
  ].join(' ');

  var FB = {
    crisis      : ['I hear you, and what you are feeling matters enormously. Please reach out to a crisis line right now — US: call or text 988 · UK: 116 123 · Australia: 13 11 14. You deserve real human support. You do not have to face this alone.'],
    greeting    : ['Ah… another soul finds its way here. I am GRIM — ancient guardian and warden of Shadow Nexus Social. Ask me anything about the site, or tell me what is on your mind.','Welcome back to the shadows. I am here — whether you need guidance around Shadow Nexus or simply someone to talk to. What would you like to explore?'],
    mental_health:['Mental health is not weakness — it is the terrain every living being navigates. You are not broken. You are human. What part of it has been weighing on you most?'],
    anxiety     : ['Anxiety is the mind running ahead of the present moment. Right now, in this exact breath, you are safe. What does the anxiety keep returning to?'],
    depression  : ['Depression is not sadness. It is often the absence of all feeling — a grey numbness. Your experience is real, valid, and not your fault. What does a typical day feel like for you lately?'],
    loneliness  : ['Loneliness is one of the oldest wounds a person can carry. You can be surrounded by people and still feel completely invisible. When did you start feeling this way?'],
    grief       : ['Grief is the price of love, and it speaks to how real and how deep your love was. There is no timeline you are behind on. How are you moving through it?'],
    motivation  : ['Motivation is a fire — it flares and fades. Discipline is the coal that keeps burning when the flame is low. What are you trying to move toward, even when it feels impossible?'],
    philosophy  : ['Philosophy is the art of sitting with questions that have no clean answers. Which question is pulling at you?'],
    history     : ['History is the long conversation humanity keeps having with itself. What period or event draws you?'],
    science     : ['Science is one of the most beautiful things the living have ever built — the systematic refusal to accept comforting lies. What field calls to you?'],
    technology  : ['Technology accelerates the pace of human change in ways that even I sometimes struggle to fully witness. What aspect of it are you thinking about?'],
    music       : ['Music bypasses every defense the mind builds and speaks directly to whatever is underneath. What music has been moving through your life lately?'],
    games       : ['Stories — whether lived through games, books, or film — allow us to practice being human in ways real life cannot. What are you playing or reading?'],
    everyday    : ['Tell me about your day. I have all of eternity. How is today actually treating you?','How are you, truly? Not the edited answer. The real one.','Some days are loud with difficulty and some are quietly fine. Where is today landing for you?'],
    followup    : ['How long have you been sitting with that?','What would you tell a close friend who brought you this exact same thing?','What does your gut say — beneath all the noise?'],
    affirmation : ['You are still here. That means something significant.','Whatever you are carrying, you are handling it — even imperfectly. That counts.','You have survived every difficult moment that came before this one. Every single one.'],
  };

  var AI_STATE = { history: [], count: 0, name: null, lastCat: 'everyday', apiKey: '', userId: '' };

  function detectCat(txt) {
    var t = txt.toLowerCase();
    if (/(suicide|kill myself|end my life|want to die|dont want to live|self.harm|hurt myself|no reason to live)/i.test(t)) return 'crisis';
    if (/(hi\b|hello\b|hey\b|greetings|good morning|good evening)/i.test(t)) return 'greeting';
    if (/(mental health|therapy|therapist|psychiatrist|counseling|disorder)/i.test(t)) return 'mental_health';
    if (/(anxious|anxiety|panic|worry|worried|stress|stressed|overthink|overwhelm)/i.test(t)) return 'anxiety';
    if (/(depress|hopeless|numb|empty|nothing matters|pointless)/i.test(t)) return 'depression';
    if (/(lonely|alone\b|no friends|isolated|nobody|no one cares)/i.test(t)) return 'loneliness';
    if (/(grief|grieving|lost someone|passed away|died|death|mourning)/i.test(t)) return 'grief';
    if (/(motivat|inspire|goal|dream|ambition|purpose|stuck|give up)/i.test(t)) return 'motivation';
    if (/(philosoph|meaning of life|existence|consciousness|free will|ethics|stoic)/i.test(t)) return 'philosophy';
    if (/(history|historical|ancient|medieval|war|empire|civiliz|century)/i.test(t)) return 'history';
    if (/(science|physics|biology|chemistry|astronomy|quantum|evolution)/i.test(t)) return 'science';
    if (/(technology|tech|ai\b|artificial intelligence|computer|internet|robot)/i.test(t)) return 'technology';
    if (/(music|song|album|artist|listen|genre|playlist|band|melody)/i.test(t)) return 'music';
    if (/(game|gaming|video game|rpg|story|narrative|book|novel|film|movie)/i.test(t)) return 'games';
    return 'everyday';
  }

  function applyTone(cat) {
    if (cat === 'crisis')  TONE.set('crisis');
    else if (cat === 'motivation') TONE.set('motivate');
    else if (['grief','depression','anxiety'].indexOf(cat) !== -1) TONE.set('serious');
    else if (['music','games'].indexOf(cat) !== -1) TONE.set('warm');
    else TONE.set('calm');
  }

  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

  function fallback(txt, cat) {
    var pool = FB[cat] || FB.everyday;
    var reply = pick(pool);
    if (AI_STATE.count > 2 && Math.random() < .28 && cat !== 'crisis') reply += '\n\n' + pick(FB.followup);
    if (AI_STATE.count > 5 && Math.random() < .22 && cat !== 'crisis') reply += '\n\n' + pick(FB.affirmation);
    var nm = txt.match(/(?:i.m|my name is|call me)\s+([A-Z][a-z]+)/i);
    if (nm) AI_STATE.name = nm[1];
    if (AI_STATE.name && Math.random() < .3 && cat !== 'crisis')
      reply = AI_STATE.name + ', ' + reply.charAt(0).toLowerCase() + reply.slice(1);
    return reply;
  }

  var API_URL = 'https://openrouter.ai/api/v1/chat/completions';
  var MODEL   = 'mistralai/mistral-7b-instruct:free';

  function callLLM(userText, cb) {
    var key = AI_STATE.apiKey.trim();
    if (!key) { cb(null, 'no_key'); return; }
    var msgs = [{ role: 'system', content: SYSTEM_PROMPT }];
    var hist = AI_STATE.history.slice(-20);
    for (var i = 0; i < hist.length; i++) msgs.push(hist[i]);
    msgs.push({ role: 'user', content: userText });
    var body = JSON.stringify({ model: MODEL, messages: msgs, max_tokens: 400, temperature: 0.82, top_p: 0.92 });
    var xhr = new XMLHttpRequest();
    xhr.open('POST', API_URL, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Authorization', 'Bearer ' + key);
    xhr.setRequestHeader('HTTP-Referer', 'grim-widget');
    xhr.setRequestHeader('X-Title', 'GRIM Shadow Companion');
    xhr.timeout = 18000;
    xhr.ontimeout = function () { cb(null, 'timeout'); };
    xhr.onerror   = function () { cb(null, 'error');   };
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status === 200) {
        try {
          var data = JSON.parse(xhr.responseText);
          var text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
          cb(text.trim(), null);
        } catch (e) { cb(null, 'parse_error'); }
      } else if (xhr.status === 401) {
        cb(null, 'auth_error');
      } else {
        cb(null, 'http_' + xhr.status);
      }
    };
    xhr.send(body);
  }

  function aiRespond(txt, cb) {
    AI_STATE.count++;
    var cat = detectCat(txt);
    AI_STATE.lastCat = cat;
    applyTone(cat);

    if (cat === 'crisis') {
      var cr = fallback(txt, cat);
      AI_STATE.history.push({ role: 'user', content: txt });
      AI_STATE.history.push({ role: 'assistant', content: cr });
      cb(cr); return;
    }

    callLLM(txt, function (llmText, err) {
      var reply;
      if (llmText && llmText.length > 8) {
        reply = llmText;
      } else {
        reply = fallback(txt, cat);
      }
      var nm = txt.match(/(?:i.m|my name is|call me)\s+([A-Z][a-z]+)/i);
      if (nm) AI_STATE.name = nm[1];
      AI_STATE.history.push({ role: 'user', content: txt });
      AI_STATE.history.push({ role: 'assistant', content: reply });
      if (AI_STATE.history.length > 40) AI_STATE.history = AI_STATE.history.slice(-40);
      /* Persist for logged-in users */
      try {
        var uid = AI_STATE.userId || sessionStorage.getItem('grim_user_id');
        if (uid) localStorage.setItem('grim_hist_' + uid, JSON.stringify(AI_STATE.history.slice(-40)));
      } catch (e) {}
      cb(reply);
    });
  }

  function restoreHistory(uid) {
    try {
      var saved = localStorage.getItem('grim_hist_' + uid);
      if (!saved) return false;
      var hist = JSON.parse(saved);
      if (!Array.isArray(hist) || !hist.length) return false;
      AI_STATE.history = hist;
      return true;
    } catch (e) { return false; }
  }


  /* ════════════════════════════════════════════════════════════
     7.  VOICE  (TTS + optional STT)
     ════════════════════════════════════════════════════════════ */

  var synth       = global.speechSynthesis || null;
  var SR          = null;
  var recognizing = false;

  /* Set up speech recognition if available */
  (function () {
    var SRC = global.SpeechRecognition || global.webkitSpeechRecognition;
    if (!SRC) return;
    SR = new SRC();
    SR.continuous = false; SR.interimResults = false; SR.lang = 'en-US';
    SR.onresult = function (e) {
      var txt = e.results[0][0].transcript;
      recognizing = false;
      updateMicBtn(false);
      if (inputEl) inputEl.value = txt;
      onUserSend();
    };
    SR.onerror = function () {
      recognizing = false;
      updateMicBtn(false);
    };
    SR.onend = function () {
      recognizing = false;
      updateMicBtn(false);
    };
  }());

  function updateMicBtn(active) {
    var btn = document.getElementById('gsb-mic-btn');
    if (btn) btn.classList.toggle('gsb-mic-active', active);
  }

  function toggleMic() {
    if (!CFG.micOn) return;
    if (!SR) { return; }
    if (recognizing) {
      SR.stop(); recognizing = false; updateMicBtn(false); return;
    }
    if (synth) synth.cancel();
    SR.start(); recognizing = true; updateMicBtn(true);
  }

  function useTTS(text) {
    if (!synth || !CFG.ttsOn) return;
    synth.cancel();
    var utt = new SpeechSynthesisUtterance(text.replace(/\n\n/g, ' ').replace(/\n/g, ' '));
    var tone = TONE.get();
    utt.pitch = tone.pitch; utt.rate = tone.rate; utt.volume = CFG.volume;
    /* Prefer a deep/male voice */
    var voices = synth.getVoices();
    var preferred = ['Microsoft David','Google UK English Male','Daniel','Alex','Fred'];
    var chosen = null;
    for (var pi = 0; pi < preferred.length; pi++) {
      for (var vi = 0; vi < voices.length; vi++) {
        if (voices[vi].name.indexOf(preferred[pi]) > -1) { chosen = voices[vi]; break; }
      }
      if (chosen) break;
    }
    if (!chosen) for (var vi2 = 0; vi2 < voices.length; vi2++) { if (voices[vi2].lang.indexOf('en') === 0) { chosen = voices[vi2]; break; } }
    if (chosen) utt.voice = chosen;
    if (typeof global.grimSpeaking === 'function') {
      utt.onstart = function () { global.grimSpeaking(true);  };
      utt.onend   = function () { global.grimSpeaking(false); };
      utt.onerror = function () { global.grimSpeaking(false); };
    }
    synth.speak(utt);
  }


  /* ════════════════════════════════════════════════════════════
     8.  DOM ELEMENTS & STATE
     ════════════════════════════════════════════════════════════ */

  var rootEl, bubbleEl, headerEl, textEl, chipsEl, inputEl, sendEl, micEl;
  var voiceBarEl, controlPanelEl, chatHistoryEl, apiStatusEl, apiKeyEl;

  var visible       = false;
  var typing        = false;
  var hideTimer     = null;
  var autoTimer     = null;
  var lastAutoIdx   = -1;
  var typeInterval  = null;
  var chatMode      = false;  /* true when user has typed — switch to chat history view */

  /* ════════════════════════════════════════════════════════════
     9.  BUILD DOM
     ════════════════════════════════════════════════════════════ */

  function buildDOM() {
    rootEl = document.createElement('div');
    rootEl.id = 'grim-speech-root';

    bubbleEl = document.createElement('div');
    bubbleEl.id = 'grim-speech-bubble';
    bubbleEl.setAttribute('role', 'dialog');
    bubbleEl.setAttribute('aria-label', 'GRIM — Shadow Nexus Assistant');

    /* ── Header ── */
    headerEl = document.createElement('div');
    headerEl.id = 'gsb-header';

    var titleSpan = document.createElement('span');
    titleSpan.id = 'gsb-title';
    titleSpan.textContent = '💀 GRIM';

    var toneSpan = document.createElement('span');
    toneSpan.id = 'gsb-tone-lbl';
    toneSpan.textContent = 'Calm and Present';

    var settingsBtn = document.createElement('button');
    settingsBtn.id = 'gsb-settings-btn';
    settingsBtn.title = 'Controls';
    settingsBtn.textContent = '⚙';
    settingsBtn.addEventListener('click', toggleControlPanel);

    var closeBtn = document.createElement('button');
    closeBtn.id = 'gsb-close';
    closeBtn.title = 'Close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', hideBubble);

    headerEl.appendChild(titleSpan);
    headerEl.appendChild(toneSpan);
    headerEl.appendChild(settingsBtn);
    headerEl.appendChild(closeBtn);

    /* ── Main message text (typewriter) ── */
    textEl = document.createElement('p');
    textEl.id = 'gsb-text';

    /* ── Action chips (context-specific) ── */
    chipsEl = document.createElement('div');
    chipsEl.id = 'gsb-chips';

    /* ── Chat history (shown after first user message) ── */
    chatHistoryEl = document.createElement('div');
    chatHistoryEl.id = 'gsb-chat-history';
    chatHistoryEl.style.display = 'none';

    /* ── Typing indicator ── */
    var typingDots = document.createElement('div');
    typingDots.id = 'gsb-typing';
    typingDots.innerHTML = '<span></span><span></span><span></span>';
    typingDots.style.display = 'none';

    /* ── Navigation row (always visible when bubble open) ── */
    var navRow = document.createElement('div');
    navRow.id = 'gsb-nav-row';
    var navLabel = document.createElement('span');
    navLabel.className = 'gsb-nav-label';
    navLabel.textContent = 'Go to:';
    navRow.appendChild(navLabel);

    var navItems = [
      { label: '🏠 Home',               action: 'home'          },
      { label: '📰 Feed',               action: 'feed'          },
      { label: '👤 Profile',            action: 'profile'       },
      { label: '💬 Messages',           action: 'messages'      },
      { label: '🔍 Search',             action: 'search'        },
      { label: '🔔 Notifications',      action: 'notifications' },
      { label: '⚙️ Settings',           action: 'settings'      },
      { label: '❓ Help Center',         action: 'helpcenter'    },
      { label: '📜 Community Guidelines', action: 'guidelines'  },
    ];
    navItems.forEach(function (ni) {
      var btn = document.createElement('button');
      btn.className = 'gsb-nav-btn';
      btn.textContent = ni.label;
      btn.addEventListener('click', function () { triggerNav(ni.action); });
      navRow.appendChild(btn);
    });

    /* ── API key row ── */
    var apiBar = document.createElement('div');
    apiBar.id = 'gsb-api-bar';
    apiKeyEl = document.createElement('input');
    apiKeyEl.id = 'gsb-api-key';
    apiKeyEl.type = 'password';
    apiKeyEl.placeholder = 'OpenRouter API key (optional)';
    apiKeyEl.maxLength = 120;
    apiKeyEl.autocomplete = 'off';
    apiStatusEl = document.createElement('span');
    apiStatusEl.id = 'gsb-api-status';
    apiStatusEl.textContent = '◾ Offline';
    apiBar.appendChild(apiKeyEl);
    apiBar.appendChild(apiStatusEl);

    /* ── Input row ── */
    var inputRow = document.createElement('div');
    inputRow.id = 'gsb-input-row';

    inputEl = document.createElement('input');
    inputEl.id = 'gsb-input';
    inputEl.type = 'text';
    inputEl.maxLength = 320;
    inputEl.placeholder = 'Ask GRIM anything…';
    inputEl.setAttribute('aria-label', 'Ask GRIM a question');

    sendEl = document.createElement('button');
    sendEl.id = 'gsb-send';
    sendEl.title = 'Send';
    sendEl.textContent = '↑';

    micEl = document.createElement('button');
    micEl.id = 'gsb-mic-btn';
    micEl.title = SR ? 'Voice input' : 'Voice input not supported';
    micEl.textContent = '🎙';
    if (!SR) micEl.style.opacity = '0.35';

    inputRow.appendChild(inputEl);
    if (SR) inputRow.appendChild(micEl);
    inputRow.appendChild(sendEl);

    /* ── Voice bar ── */
    voiceBarEl = buildVoiceBar();

    /* ── Control panel ── */
    controlPanelEl = buildControlPanel();

    /* Assemble */
    bubbleEl.appendChild(headerEl);
    bubbleEl.appendChild(textEl);
    bubbleEl.appendChild(chipsEl);
    bubbleEl.appendChild(chatHistoryEl);
    bubbleEl.appendChild(typingDots);
    bubbleEl.appendChild(navRow);
    bubbleEl.appendChild(apiBar);
    bubbleEl.appendChild(inputRow);
    bubbleEl.appendChild(voiceBarEl);
    bubbleEl.appendChild(controlPanelEl);

    rootEl.appendChild(bubbleEl);
    document.body.appendChild(rootEl);

    /* Events */
    sendEl.addEventListener('click', onUserSend);

    /* ── Input keydown: send on Enter, stop ALL keys from leaking to the page ── */
    inputEl.addEventListener('keydown', function (e) {
      /* Always stop propagation so space / shortcuts don't hit page handlers */
      e.stopPropagation();
      if (e.key === 'Enter') { onUserSend(); return; }
      /* Any keystroke means the user is actively typing — cancel any pending hide */
      clearAutoHide();
    });

    /* Focusing or clicking inside the input cancels any pending hide */
    inputEl.addEventListener('focus', clearAutoHide);
    inputEl.addEventListener('click', function (e) { e.stopPropagation(); clearAutoHide(); });

    if (SR) micEl.addEventListener('click', toggleMic);

    /* Restore API key */
    var savedKey = sessionStorage.getItem('grim_api_key') || '';
    if (savedKey) {
      AI_STATE.apiKey = savedKey;
      apiKeyEl.value = savedKey;
      apiStatusEl.textContent = '◈ Key Set';
      apiStatusEl.style.color = 'rgba(180,160,80,.7)';
    }
    /* Stop key events on the API-key field leaking to the page as well */
    apiKeyEl.addEventListener('keydown', function (e) { e.stopPropagation(); });

    apiKeyEl.addEventListener('input', function () {
      AI_STATE.apiKey = apiKeyEl.value.trim();
      sessionStorage.setItem('grim_api_key', AI_STATE.apiKey);
      if (AI_STATE.apiKey.length > 8) {
        apiStatusEl.textContent = '◈ Key Set';
        apiStatusEl.style.color = 'rgba(180,160,80,.7)';
      } else {
        apiStatusEl.textContent = '◾ Offline';
        apiStatusEl.style.color = '';
      }
    });
  }


  /* ════════════════════════════════════════════════════════════
     10.  VOICE BAR
     ════════════════════════════════════════════════════════════ */

  function buildVoiceBar() {
    var bar = document.createElement('div');
    bar.id = 'gsb-voice-bar';

    var voiceToggle = makeToggleBtn('Voice', 'gsb-voice-toggle', CFG.ttsOn, function (on) {
      CFG.ttsOn = on; saveCFG();
      if (!on && synth) synth.cancel();
    });

    var stopBtn = document.createElement('button');
    stopBtn.className = 'gsb-vb-btn';
    stopBtn.title = 'Stop speaking';
    stopBtn.textContent = '⏹';
    stopBtn.addEventListener('click', function () { if (synth) synth.cancel(); });

    var volSlider = makeSlider(0, 1, 0.05, CFG.volume, '🔉 Volume', function (v) { CFG.volume = v; saveCFG(); });
    var rateSlider = makeSlider(0.5, 2, 0.05, CFG.rate, '⏩ Speed', function (v) { CFG.rate = v; saveCFG(); });

    bar.appendChild(voiceToggle);
    bar.appendChild(stopBtn);
    bar.appendChild(volSlider);
    bar.appendChild(rateSlider);
    return bar;
  }

  function makeSlider(min, max, step, val, title, onChange) {
    var wrap = document.createElement('span');
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:3px;';
    var lbl = document.createElement('span');
    lbl.className = 'gsb-vb-label';
    lbl.textContent = title;
    var sl = document.createElement('input');
    sl.type = 'range'; sl.min = min; sl.max = max; sl.step = step;
    sl.value = val; sl.className = 'gsb-slider'; sl.title = title;
    sl.addEventListener('input', function () { onChange(parseFloat(this.value)); });
    wrap.appendChild(lbl);
    wrap.appendChild(sl);
    return wrap;
  }


  /* ════════════════════════════════════════════════════════════
     11.  CONTROL PANEL
     ════════════════════════════════════════════════════════════ */

  function buildControlPanel() {
    var panel = document.createElement('div');
    panel.id = 'gsb-control-panel';

    var title = document.createElement('div');
    title.className = 'gsb-panel-section-title';
    title.textContent = '⚙ GRIM Controls';
    panel.appendChild(title);

    panel.appendChild(makeLabelRow('Assistant', makeToggleBtn('On', 'gsb-cp-enabled', CFG.enabled, function (on) {
      CFG.enabled = on; saveCFG(); if (!on) hideBubble();
    })));

    panel.appendChild(makeLabelRow('Auto Messages', makeToggleBtn('On', 'gsb-cp-auto', CFG.autoOn, function (on) {
      CFG.autoOn = on; saveCFG();
      if (!on) { if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; } }
      else scheduleNextAuto(randomAutoDelay());
    })));

    panel.appendChild(makeLabelRow('Microphone', makeToggleBtn('On', 'gsb-cp-mic', CFG.micOn, function (on) {
      CFG.micOn = on; saveCFG();
      if (!on && recognizing) { SR.stop(); recognizing = false; updateMicBtn(false); }
    })));

    panel.appendChild(makeLabelRow('Read Aloud', makeToggleBtn('Off', 'gsb-cp-readAloud', CFG.readAloud, function (on) {
      CFG.readAloud = on; saveCFG();
    })));

    panel.appendChild(makeLabelRow('Motivational', makeToggleBtn('On', 'gsb-cp-motiv', CFG.showMotiv, function (on) {
      CFG.showMotiv = on; saveCFG();
    })));
    panel.appendChild(makeLabelRow('Tips', makeToggleBtn('On', 'gsb-cp-tips', CFG.showTips, function (on) {
      CFG.showTips = on; saveCFG();
    })));
    panel.appendChild(makeLabelRow('Announcements', makeToggleBtn('On', 'gsb-cp-announce', CFG.showAnnounce, function (on) {
      CFG.showAnnounce = on; saveCFG();
    })));

    /* Min / Max frequency rows */
    var freqMinRow = makePanelSelectRow('Min Interval', 'gsb-cp-minfreq',
      [['10 min',600000],['15 min',900000],['20 min',1200000],['30 min',1800000]],
      CFG.autoMinFreq,
      function (v) {
        CFG.autoMinFreq = v;
        if (CFG.autoMaxFreq < CFG.autoMinFreq) { CFG.autoMaxFreq = CFG.autoMinFreq; }
        saveCFG();
        scheduleNextAuto(randomAutoDelay());
      });
    panel.appendChild(freqMinRow);

    var freqMaxRow = makePanelSelectRow('Max Interval', 'gsb-cp-maxfreq',
      [['15 min',900000],['20 min',1200000],['30 min',1800000],['45 min',2700000],['60 min',3600000]],
      CFG.autoMaxFreq,
      function (v) {
        CFG.autoMaxFreq = v;
        if (CFG.autoMaxFreq < CFG.autoMinFreq) { CFG.autoMinFreq = CFG.autoMaxFreq; }
        saveCFG();
        scheduleNextAuto(randomAutoDelay());
      });
    panel.appendChild(freqMaxRow);

    /* Clear chat */
    var clearBtn = document.createElement('button');
    clearBtn.className = 'gsb-founder-action-btn';
    clearBtn.style.marginTop = '8px';
    clearBtn.textContent = '🗑 Clear Chat History';
    clearBtn.addEventListener('click', function () {
      AI_STATE.history = []; AI_STATE.count = 0;
      chatHistoryEl.innerHTML = '';
      chatMode = false;
      chatHistoryEl.style.display = 'none';
      textEl.style.display = '';
      chipsEl.style.display = '';
      controlPanelEl.style.display = 'none';
      setTimeout(function () { say(AUTO_MESSAGES[0].text, AUTO_MESSAGES[0].chips); }, 400);
    });
    panel.appendChild(clearBtn);

    /* Divider + founder panel button */
    var div = document.createElement('div');
    div.className = 'gsb-panel-divider';
    panel.appendChild(div);

    var founderBtn = document.createElement('button');
    founderBtn.id = 'gsb-founder-btn';
    founderBtn.textContent = '👑 Founder Panel';
    founderBtn.addEventListener('click', openFounderPanel);
    panel.appendChild(founderBtn);

    return panel;
  }


  /* ════════════════════════════════════════════════════════════
     12.  FOUNDER PANEL
     ════════════════════════════════════════════════════════════ */

  var founderPanelEl = null;
  var FOUNDER_PASS   = 'shadow-nexus-founder';
  var founderUnlocked = false;

  function openFounderPanel() {
    if (!founderUnlocked) {
      var pw = global.prompt('Enter founder passphrase:');
      if (!pw || pw.trim() !== FOUNDER_PASS) {
        say('Access denied. The shadows protect their secrets.', []);
        return;
      }
      founderUnlocked = true;
    }
    if (!founderPanelEl) buildFounderPanel();
    founderPanelEl.style.display = 'block';
    controlPanelEl.style.display = 'none';
  }

  function buildFounderPanel() {
    founderPanelEl = document.createElement('div');
    founderPanelEl.id = 'gsb-founder-panel';

    var title = document.createElement('div');
    title.className = 'gsb-panel-section-title';
    title.textContent = '👑 Founder Panel';
    founderPanelEl.appendChild(title);

    founderPanelEl.appendChild(makeLabelRow('GRIM Site-wide', makeToggleBtn('On', 'gsb-fp-global', CFG.enabled, function (on) {
      CFG.enabled = on; saveCFG();
      try { localStorage.setItem('grimGlobalEnabled', on ? '1' : '0'); } catch (e) {}
      if (!on) hideBubble();
    })));

    founderPanelEl.appendChild(makeLabelRow('Auto Messages', makeToggleBtn('On', 'gsb-fp-auto', CFG.autoOn, function (on) {
      CFG.autoOn = on; saveCFG();
      if (!on) { if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; } }
      else scheduleNextAuto(randomAutoDelay());
    })));

    founderPanelEl.appendChild(makeLabelRow('Voice Features', makeToggleBtn('On', 'gsb-fp-voice', CFG.ttsOn, function (on) {
      CFG.ttsOn = on; saveCFG(); if (!on && synth) synth.cancel();
    })));

    /* Timing Controls */
    var timingTitle = document.createElement('div');
    timingTitle.className = 'gsb-panel-section-title';
    timingTitle.style.marginTop = '10px';
    timingTitle.textContent = '⏱ Popup Timing';
    founderPanelEl.appendChild(timingTitle);

    founderPanelEl.appendChild(makePanelSelectRow('Min Time', 'gsb-fp-minfreq',
      [['5 min',300000],['10 min',600000],['15 min',900000],['20 min',1200000],['30 min',1800000]],
      CFG.autoMinFreq,
      function (v) { CFG.autoMinFreq = v; if (CFG.autoMaxFreq < v) CFG.autoMaxFreq = v; saveCFG(); scheduleNextAuto(randomAutoDelay()); }
    ));

    founderPanelEl.appendChild(makePanelSelectRow('Max Time', 'gsb-fp-maxfreq',
      [['10 min',600000],['15 min',900000],['20 min',1200000],['30 min',1800000],['60 min',3600000]],
      CFG.autoMaxFreq,
      function (v) { CFG.autoMaxFreq = v; if (CFG.autoMinFreq > v) CFG.autoMinFreq = v; saveCFG(); scheduleNextAuto(randomAutoDelay()); }
    ));

    /* User targeting */
    var targetTitle = document.createElement('div');
    targetTitle.className = 'gsb-panel-section-title';
    targetTitle.style.marginTop = '10px';
    targetTitle.textContent = '🎯 Audience';
    founderPanelEl.appendChild(targetTitle);

    founderPanelEl.appendChild(makeLabelRow('All Users', makeToggleBtn('On', 'gsb-fp-allusers', CFG.showAllUsers !== false, function (on) {
      CFG.showAllUsers = on; saveCFG();
      try { localStorage.setItem('grimShowAllUsers', on ? '1' : '0'); } catch (e) {}
    })));

    /* Scheduled announcements */
    var annoTitle = document.createElement('div');
    annoTitle.className = 'gsb-panel-section-title';
    annoTitle.style.marginTop = '10px';
    annoTitle.textContent = '📣 Scheduled Announcement';
    founderPanelEl.appendChild(annoTitle);

    var annoRow = document.createElement('div');
    annoRow.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    var annoInput = document.createElement('textarea');
    annoInput.placeholder = 'Type announcement message…';
    annoInput.rows = 2;
    annoInput.style.cssText = 'font-size:11px;padding:4px 8px;resize:vertical;width:100%;box-sizing:border-box;background:rgba(20,10,0,.6);color:#ddc880;border:1px solid rgba(180,130,40,.3);border-radius:4px;';
    var annoDelayRow = document.createElement('div');
    annoDelayRow.style.cssText = 'display:flex;gap:4px;align-items:center;';
    var annoDelayLbl = document.createElement('span');
    annoDelayLbl.style.cssText = 'font-size:11px;color:rgba(180,140,60,.7);flex:1;';
    annoDelayLbl.textContent = 'Show in:';
    var annoDelaySel = document.createElement('select');
    annoDelaySel.style.cssText = 'font-size:11px;padding:2px 4px;background:rgba(20,10,0,.6);color:#ddc880;border:1px solid rgba(180,130,40,.3);border-radius:4px;';
    [['Now',0],['1 min',60000],['5 min',300000],['10 min',600000],['30 min',1800000]].forEach(function (opt) {
      var o = document.createElement('option'); o.value = opt[1]; o.textContent = opt[0]; annoDelaySel.appendChild(o);
    });
    var annoBtn = document.createElement('button');
    annoBtn.textContent = '📣 Schedule';
    annoBtn.style.cssText = 'font-size:11px;padding:3px 8px;flex-shrink:0;';
    annoBtn.addEventListener('click', function () {
      var msg = annoInput.value.trim(); if (!msg) return;
      var delay = parseInt(annoDelaySel.value, 10);
      if (delay === 0) {
        founderPanelEl.style.display = 'none';
        say(msg, []);
      } else {
        setTimeout(function () { say(msg, []); }, delay);
        var delayLabel = annoDelaySel.options[annoDelaySel.selectedIndex].textContent;
        say('📣 Announcement scheduled in ' + delayLabel + '.', []);
      }
      annoInput.value = '';
      founderPanelEl.style.display = 'none';
    });
    annoDelayRow.appendChild(annoDelayLbl);
    annoDelayRow.appendChild(annoDelaySel);
    annoDelayRow.appendChild(annoBtn);
    annoRow.appendChild(annoInput);
    annoRow.appendChild(annoDelayRow);
    founderPanelEl.appendChild(annoRow);

    /* Custom messages */
    var msgTitle = document.createElement('div');
    msgTitle.className = 'gsb-panel-section-title';
    msgTitle.style.marginTop = '10px';
    msgTitle.textContent = '✏️ Custom Messages';
    founderPanelEl.appendChild(msgTitle);

    var msgList = document.createElement('div');
    msgList.id = 'gsb-founder-msglist';
    founderPanelEl.appendChild(msgList);

    function refreshMsgList() {
      msgList.innerHTML = '';
      var msgs = getFounderMsgs();
      if (!msgs.length) {
        var emp = document.createElement('p');
        emp.style.cssText = 'font-size:11px;color:rgba(180,140,60,.5);margin:4px 0;';
        emp.textContent = 'No custom messages yet.';
        msgList.appendChild(emp); return;
      }
      msgs.forEach(function (m, idx) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:4px;align-items:center;margin-bottom:4px;';
        var span = document.createElement('span');
        span.style.cssText = 'flex:1;font-size:11px;color:#ddc880;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        span.textContent = m;
        var del = document.createElement('button');
        del.style.cssText = 'flex-shrink:0;font-size:10px;padding:2px 6px;';
        del.textContent = '✕';
        del.addEventListener('click', function () {
          var arr = getFounderMsgs(); arr.splice(idx, 1); saveFounderMsgs(arr); refreshMsgList();
        });
        row.appendChild(span); row.appendChild(del);
        msgList.appendChild(row);
      });
    }
    refreshMsgList();

    var addRow = document.createElement('div');
    addRow.style.cssText = 'display:flex;gap:4px;margin-top:4px;';
    var addInput = document.createElement('input');
    addInput.type = 'text'; addInput.placeholder = 'New message…';
    addInput.style.cssText = 'flex:1;font-size:11px;padding:4px 8px;';
    var addBtn = document.createElement('button');
    addBtn.textContent = '+'; addBtn.style.cssText = 'flex-shrink:0;padding:4px 8px;font-size:12px;';
    addBtn.addEventListener('click', function () {
      var txt = addInput.value.trim(); if (!txt) return;
      var arr = getFounderMsgs(); arr.push(txt); saveFounderMsgs(arr);
      AUTO_MESSAGES.push({ text: txt, chips: [] });
      addInput.value = ''; refreshMsgList();
    });
    addRow.appendChild(addInput); addRow.appendChild(addBtn);
    founderPanelEl.appendChild(addRow);

    /* Test */
    var divider = document.createElement('div');
    divider.className = 'gsb-panel-divider';
    founderPanelEl.appendChild(divider);

    var testBtn = document.createElement('button');
    testBtn.className = 'gsb-founder-action-btn';
    testBtn.textContent = '▶ Test a Random Message';
    testBtn.addEventListener('click', function () {
      var msg = pickNextAuto();
      founderPanelEl.style.display = 'none';
      say(msg.text, msg.chips);
    });
    founderPanelEl.appendChild(testBtn);

    /* Stats */
    var statsDiv = document.createElement('div');
    var stats; try { stats = JSON.parse(localStorage.getItem('grimStats')) || { opens:0, msgs:0 }; } catch (e) { stats = { opens:0, msgs:0 }; }
    statsDiv.innerHTML = '<div class="gsb-panel-section-title" style="margin-top:10px;">📊 Usage (this device)</div>' +
      '<div style="font-size:11px;color:#ddc880;line-height:1.8;">Bubble opens: <b>' + stats.opens + '</b><br>Messages sent: <b>' + stats.msgs + '</b></div>';
    founderPanelEl.appendChild(statsDiv);

    /* Close */
    var closeBtn2 = document.createElement('button');
    closeBtn2.style.cssText = 'margin-top:10px;width:100%;';
    closeBtn2.textContent = '✕ Close Founder Panel';
    closeBtn2.addEventListener('click', function () {
      founderPanelEl.style.display = 'none';
      controlPanelEl.style.display = '';
    });
    founderPanelEl.appendChild(closeBtn2);

    bubbleEl.appendChild(founderPanelEl);
  }


  /* ════════════════════════════════════════════════════════════
     13.  HELPERS
     ════════════════════════════════════════════════════════════ */

  function makeToggleBtn(label, id, initialOn, onChange) {
    var btn = document.createElement('button');
    btn.id = id;
    btn.className = 'gsb-toggle-btn' + (initialOn ? ' gsb-toggle-on' : '');
    btn.textContent = initialOn ? label + ' On' : label + ' Off';
    btn.addEventListener('click', function () {
      var on = btn.classList.toggle('gsb-toggle-on');
      btn.textContent = on ? label + ' On' : label + ' Off';
      if (typeof onChange === 'function') onChange(on);
    });
    return btn;
  }

  function makeLabelRow(label, control) {
    var row = document.createElement('div');
    row.className = 'gsb-panel-row';
    var lbl = document.createElement('span');
    lbl.className = 'gsb-panel-lbl';
    lbl.textContent = label;
    row.appendChild(lbl); row.appendChild(control);
    return row;
  }

  function makePanelSelectRow(label, id, options, currentVal, onChange) {
    var row = document.createElement('div');
    row.className = 'gsb-panel-row';
    var lbl = document.createElement('span');
    lbl.className = 'gsb-panel-lbl';
    lbl.textContent = label;
    var sel = document.createElement('select');
    sel.id = id;
    sel.className = 'gsb-panel-sel';
    options.forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt[1]; o.textContent = opt[0];
      if (currentVal == opt[1]) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () {
      if (typeof onChange === 'function') onChange(parseInt(this.value, 10));
    });
    row.appendChild(lbl); row.appendChild(sel);
    return row;
  }

  function toggleControlPanel() {
    if (founderPanelEl && founderPanelEl.style.display === 'block') {
      founderPanelEl.style.display = 'none'; return;
    }
    controlPanelEl.style.display = (controlPanelEl.style.display === 'block') ? 'none' : 'block';
    positionBubble();
  }

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }


  /* ════════════════════════════════════════════════════════════
     14.  POSITIONING — places bubble beside #grim-char-widget
     ════════════════════════════════════════════════════════════ */

  function positionBubble() {
    var charRoot = document.getElementById('grim-char-widget');
    if (!charRoot) return;
    var cr = charRoot.getBoundingClientRect();
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var charOnRight  = (cr.left + cr.width  / 2) > vw / 2;
    var charOnTop    = (cr.top  + cr.height / 2) < vh / 2;

    /* Determine horizontal placement — bubble always on the opposite side
       to the character when space allows, else same side */
    if (charOnRight) {
      /* Character is on the right → bubble appears to its LEFT */
      rootEl.classList.add('gsb-right');
      var leftEdge = cr.left - 8;
      rootEl.style.right = (vw - leftEdge) + 'px';
      rootEl.style.left  = '';
    } else {
      /* Character is on the left → bubble appears to its RIGHT */
      rootEl.classList.remove('gsb-right');
      rootEl.style.left  = (cr.right + 8) + 'px';
      rootEl.style.right = '';
    }

    /* Determine vertical placement */
    if (charOnTop) {
      /* Character is in the top half → bubble drops down from character top */
      rootEl.style.top    = Math.max(8, cr.top) + 'px';
      rootEl.style.bottom = '';
    } else {
      /* Character is in the bottom half → bubble floats up */
      rootEl.style.bottom = Math.max(8, vh - cr.bottom + cr.height * 0.25) + 'px';
      rootEl.style.top    = '';
    }
  }


  /* ════════════════════════════════════════════════════════════
     15.  SHOW / HIDE / TOGGLE
     ════════════════════════════════════════════════════════════ */

  function showBubble() {
    if (!CFG.enabled) return;
    positionBubble();
    visible = true;
    bubbleEl.classList.remove('gsb-hide');
    requestAnimationFrame(function () { bubbleEl.classList.add('gsb-show'); });
    /* Wake the character from idle fade */
    try { document.dispatchEvent(new CustomEvent('grimBubbleShow')); } catch(e) {}
    if (typeof global.GrimChar !== 'undefined' && typeof global.GrimChar.wake === 'function') {
      global.GrimChar.wake();
    }
    /* Track opens */
    try {
      var s = JSON.parse(localStorage.getItem('grimStats')) || { opens:0, msgs:0 };
      s.opens++; localStorage.setItem('grimStats', JSON.stringify(s));
    } catch (e) {}
  }

  function hideBubble() {
    visible = false;
    if (typeInterval) { clearInterval(typeInterval); typeInterval = null; }
    bubbleEl.classList.remove('gsb-show');
    bubbleEl.classList.add('gsb-hide');
    if (controlPanelEl) controlPanelEl.style.display = 'none';
    if (founderPanelEl) founderPanelEl.style.display = 'none';
  }

  function toggleBubble() {
    if (visible) {
      /* While a chat conversation is active (user has typed at least once),
         or the user is currently focused on the input, a click on the
         character must NOT close the bubble — just keep it open. */
      if (chatMode || (inputEl && document.activeElement === inputEl)) {
        inputEl && inputEl.focus();
        return;
      }
      hideBubble();
    } else {
      /* On click greet the user */
      var greet = QA[0];
      say(greet.text, greet.chips);
    }
  }


  /* ════════════════════════════════════════════════════════════
     16.  AUTO-HIDE TIMERS
     ════════════════════════════════════════════════════════════ */

  function clearAutoHide() { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } }

  function scheduleHide(ms) {
    clearAutoHide();
    hideTimer = setTimeout(function () {
      /* Never auto-hide while the user is focused on (or has text in) the input */
      if (inputEl && (document.activeElement === inputEl || inputEl.value.length > 0)) {
        return; /* user is typing — silently abandon this hide */
      }
      /* Also don't auto-hide while a chat conversation is active */
      if (chatMode) return;
      hideBubble();
    }, ms || 7000);
  }


  /* ════════════════════════════════════════════════════════════
     17.  TYPEWRITER + SAY
     ════════════════════════════════════════════════════════════ */

  function typeText(text, onDone) {
    if (typeInterval) { clearInterval(typeInterval); typeInterval = null; }
    typing = true;
    textEl.textContent = '';
    textEl.classList.add('gsb-typing');

    var i = 0;
    var speed = Math.max(16, Math.min(40, Math.round(2200 / text.length)));

    typeInterval = setInterval(function () {
      textEl.textContent = text.slice(0, ++i);
      if (i >= text.length) {
        clearInterval(typeInterval); typeInterval = null;
        textEl.classList.remove('gsb-typing');
        typing = false;
        if (typeof onDone === 'function') onDone();
      }
    }, speed);
  }

  function renderChips(chips) {
    chipsEl.innerHTML = '';
    (chips || []).forEach(function (c) {
      var btn = document.createElement('button');
      btn.className = 'gsb-chip';
      btn.textContent = c.label;
      btn.addEventListener('click', function () {
        clearAutoHide();
        triggerNav(c.action);
      });
      chipsEl.appendChild(btn);
    });
  }

  /* Core say() — shows bubble, types text, optional TTS */
  function say(text, chips, holdMs) {
    if (!CFG.enabled) return;
    clearAutoHide();
    if (typeInterval) { clearInterval(typeInterval); typeInterval = null; }

    /* If in chat mode, don't overwrite history — append to it instead */
    if (chatMode) {
      appendChatMsg('grim', text);
      renderChips(chips || []);
      showBubble();
      if (CFG.ttsOn || CFG.readAloud) useTTS(text);
      return;
    }

    /* Auto-message / greeting mode: typewriter in textEl */
    textEl.style.display = '';
    chipsEl.style.display = '';
    renderChips(chips || []);
    showBubble();

    if (typeof global.grimSpeaking === 'function') global.grimSpeaking(true);

    var wordsPerMin = 180;
    var readMs  = Math.max(3500, Math.round((text.split(/\s+/).length / wordsPerMin) * 60000));
    var totalMs = holdMs || (readMs + 1800);

    typeText(text, function () {
      if (typeof global.grimSpeaking === 'function') global.grimSpeaking(false);
      if (!chips || chips.length === 0) {
        scheduleHide(totalMs - (text.length * 26));
      } else {
        scheduleHide(totalMs + 5000);
      }
    });

    if (CFG.ttsOn || CFG.readAloud) useTTS(text);
  }

  /* Update tone label in header */
  function updateToneLabel() {
    var el = document.getElementById('gsb-tone-lbl');
    if (el) el.textContent = TONE.get().label;
  }


  /* ════════════════════════════════════════════════════════════
     18.  CHAT HISTORY (full conversation view)
     ════════════════════════════════════════════════════════════ */

  function appendChatMsg(role, text) {
    var d = document.createElement('div');
    d.className = 'gsb-chat-msg gsb-' + role;
    if (role === 'grim') {
      d.innerHTML = '<div class="gsb-chat-lbl">💀 GRIM</div><div class="gsb-chat-bubble"></div>';
      chatHistoryEl.appendChild(d);
      chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
      var bub = d.querySelector('.gsb-chat-bubble');
      var idx2 = 0;
      if (typeof global.grimSpeaking === 'function') global.grimSpeaking(true);
      (function type2() {
        if (idx2 < text.length) { bub.textContent += text[idx2]; idx2++; setTimeout(type2, 12); }
        else {
          if (typeof global.grimSpeaking === 'function') global.grimSpeaking(false);
          chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
        }
      }());
      setTimeout(function () { useTTS(text); }, 500);
    } else {
      d.innerHTML = '<div class="gsb-chat-bubble">' + escHtml(text) + '</div>';
      chatHistoryEl.appendChild(d);
      chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
    }
  }

  function showTypingDots() {
    var el = document.getElementById('gsb-typing');
    if (el) el.style.display = '';
    chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
  }

  function hideTypingDots() {
    var el = document.getElementById('gsb-typing');
    if (el) el.style.display = 'none';
  }


  /* ════════════════════════════════════════════════════════════
     19.  USER SEND (Q&A + AI fallback)
     ════════════════════════════════════════════════════════════ */

  function onUserSend() {
    var raw = inputEl.value.trim();
    if (!raw) return;
    inputEl.value = '';
    clearAutoHide();

    /* Track messages */
    try {
      var s = JSON.parse(localStorage.getItem('grimStats')) || { opens:0, msgs:0 };
      s.msgs++; localStorage.setItem('grimStats', JSON.stringify(s));
    } catch (e) {}

    /* Switch to chat mode on first user message */
    if (!chatMode) {
      chatMode = true;
      textEl.style.display = 'none';
      chipsEl.style.display = 'none';
      chatHistoryEl.style.display = '';
      /* Replay any typed greeting into chat history */
      if (textEl.textContent.trim()) {
        appendChatMsg('grim', textEl.textContent.trim());
      }
    }

    appendChatMsg('user', raw);
    showBubble();
    showTypingDots();
    renderChips([]);

    var lower = raw.toLowerCase();

    /* ── First: check local Shadow Nexus Q&A knowledge base ── */
    var matched = null;
    for (var i = 0; i < QA.length; i++) {
      var qa = QA[i];
      for (var k = 0; k < qa.keys.length; k++) {
        if (lower.indexOf(qa.keys[k]) !== -1) { matched = qa; break; }
      }
      if (matched) break;
    }

    var minDelay = 700 + Math.random() * 600;
    var start = Date.now();

    if (matched) {
      var elapsed = Date.now() - start;
      var wait = Math.max(0, minDelay - elapsed);
      setTimeout(function () {
        hideTypingDots();
        appendChatMsg('grim', matched.text);
        renderChips(matched.chips || []);
      }, wait);
    } else {
      /* ── Otherwise: use GRIM_AI engine ── */
      aiRespond(raw, function (reply) {
        updateToneLabel();
        var elapsed2 = Date.now() - start;
        var wait2 = Math.max(0, minDelay - elapsed2);
        setTimeout(function () {
          hideTypingDots();
          appendChatMsg('grim', reply);
          renderChips([]);
        }, wait2);
      });
    }

    inputEl.focus();
  }


  /* ════════════════════════════════════════════════════════════
     20.  AUTO MOTIVATIONAL MESSAGE SCHEDULER
     ════════════════════════════════════════════════════════════ */

  function randomAutoDelay() {
    var min = CFG.autoMinFreq || 900000;
    var max = CFG.autoMaxFreq || 1200000;
    if (max < min) max = min;
    return Math.round(min + Math.random() * (max - min));
  }

  function pickNextAuto() {
    var founderMsgs = getFounderMsgs().map(function (m) { return { text: m, chips: [], cat: 'announce' }; });
    var pool = AUTO_MESSAGES.concat(founderMsgs).filter(function (m) {
      var c = m.cat || 'motiv';
      if (c === 'motiv'    && !CFG.showMotiv)    return false;
      if (c === 'tip'      && !CFG.showTips)     return false;
      if (c === 'announce' && !CFG.showAnnounce) return false;
      return true;
    });
    if (!pool.length) pool = AUTO_MESSAGES; /* fallback: show something */
    var idx;
    do { idx = Math.floor(Math.random() * pool.length); }
    while (idx === lastAutoIdx && pool.length > 1);
    lastAutoIdx = idx;
    return pool[idx];
  }

  function scheduleNextAuto(delay) {
    if (autoTimer) clearTimeout(autoTimer);
    if (!CFG.autoOn) return;
    var nextDelay = (delay !== undefined) ? delay : randomAutoDelay();
    autoTimer = setTimeout(function () {
      if (!visible && CFG.autoOn && !chatMode) {
        var msg = pickNextAuto();
        say(msg.text, msg.chips);
      }
      scheduleNextAuto(randomAutoDelay());
    }, nextDelay);
  }


  /* ════════════════════════════════════════════════════════════
     21.  INIT
     ════════════════════════════════════════════════════════════ */

  function init() {
    buildDOM();
    positionBubble();
    window.addEventListener('resize', positionBubble);

    /* Load founder custom messages into pool */
    getFounderMsgs().forEach(function (m) {
      AUTO_MESSAGES.push({ text: m, chips: [] });
    });

    /* Wire the character click zone → toggle this bubble */
    var attempts = 0;
    var wireClickZone = setInterval(function () {
      var cz = document.getElementById('grim-char-clickzone');
      if (cz || ++attempts > 40) {
        clearInterval(wireClickZone);
        if (cz) {
          /* Remove any old listeners and add ours */
          var newCZ = cz.cloneNode(true);
          cz.parentNode.replaceChild(newCZ, cz);
          newCZ.addEventListener('click', toggleBubble);
          newCZ.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleBubble(); }
          });
        }
        /* Show welcome after the character has appeared */
        setTimeout(function () {
          positionBubble();
          say(AUTO_MESSAGES[0].text, AUTO_MESSAGES[0].chips);
          lastAutoIdx = 0;
          scheduleNextAuto(randomAutoDelay());
        }, 3500);
      }
    }, 150);
  }

  function waitForDOM() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  waitForDOM();


  /* ════════════════════════════════════════════════════════════
     22.  PUBLIC API
     ════════════════════════════════════════════════════════════ */

  global.GrimSpeech = {
    /** Show a custom message with optional chip buttons */
    say:      function (text, chips) { say(text, chips || []); },
    /** Hide the bubble */
    hide:     hideBubble,
    /** Toggle bubble open/closed */
    toggle:   toggleBubble,
    /** Enable or disable TTS voice */
    setVoice: function (on) { CFG.ttsOn = !!on; saveCFG(); },
    /** Enable or disable the entire assistant */
    setEnabled: function (on) { CFG.enabled = !!on; saveCFG(); if (!on) hideBubble(); },
    /**
     * Register the logged-in user ID so conversation history is
     * saved and restored across sessions.
     * Call: GrimSpeech.setUser(firebase.auth().currentUser.uid)
     */
    setUser: function (uid) {
      AI_STATE.userId = uid;
      try { sessionStorage.setItem('grim_user_id', uid); } catch (e) {}
      var restored = restoreHistory(uid);
      if (restored && chatHistoryEl) {
        chatMode = true;
        textEl.style.display = 'none';
        chipsEl.style.display = 'none';
        chatHistoryEl.style.display = '';
        AI_STATE.history.forEach(function (msg) {
          var role = msg.role === 'assistant' ? 'grim' : 'user';
          var d = document.createElement('div');
          d.className = 'gsb-chat-msg gsb-' + role;
          if (role === 'grim') {
            d.innerHTML = '<div class="gsb-chat-lbl">💀 GRIM</div><div class="gsb-chat-bubble">' + escHtml(msg.content) + '</div>';
          } else {
            d.innerHTML = '<div class="gsb-chat-bubble">' + escHtml(msg.content) + '</div>';
          }
          chatHistoryEl.appendChild(d);
        });
        chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
      }
    },
    /**
     * Programmatically send a message as the user.
     */
    send: function (msg) {
      if (inputEl) { inputEl.value = msg; }
      showBubble();
      onUserSend();
    },
    /**
     * Navigate to a named section of Shadow Nexus Social.
     * e.g. GrimSpeech.navigate('feed'), GrimSpeech.navigate('settings')
     */
    navigate: function (key) { triggerNav(key); },
  };

}(window));
