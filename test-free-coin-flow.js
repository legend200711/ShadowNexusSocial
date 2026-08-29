/**
 * test-free-coin-flow.js
 * Shadow Nexus Social — Free Test-Coin Flow End-to-End Test (4-Hop)
 *
 * HOW TO RUN:
 *   1. Open the Shadow Nexus Social site in Chrome while signed in as the FOUNDER.
 *   2. Open DevTools → Console.
 *   3. Copy-paste this entire script and press Enter.
 *   4. Supply UIDs at the prompts, OR edit the UID constants at the top.
 *
 * WHAT IT TESTS (full circulation chain):
 *   Hop 1 — Founder grants 1,000 test coins to User A via the worker.
 *   Hop 2 — User A sends 300 coins to User B  (worker /transfer-test-coins).
 *   Hop 3 — User B sends 100 coins to User C  (worker /transfer-test-coins).
 *   Hop 4 — User C sends  50 coins to Founder (worker /transfer-test-coins).
 *
 * After EVERY hop, the actual Firestore balances are read and asserted.
 *
 * REQUIREMENTS:
 *   - Must run as the Founder account (window._snxRole === 'founder').
 *   - USER_A_UID, USER_B_UID, USER_C_UID must be non-Founder accounts.
 *   - FOUNDER_UID is read automatically from window._snxCurrentUser.
 *   - The Cloudflare Worker endpoint must be reachable.
 *
 * IMPORTANT:
 *   Coins are sent via /transfer-test-coins (server-side, founder-authorized),
 *   which uses the same debit/credit logic as the normal gift flow but is
 *   callable by the Founder without each user being signed in.
 *   Once credited to wallets/{uid}.shadowCoins they are normal Shadow Coins —
 *   no origin tracking, no restrictions, fully spendable and re-transferable.
 */

(async function SNX_FREE_COIN_FLOW_TEST() {
  /* ─── CONFIG — edit these UIDs before running ─── */
  const USER_A_UID = '';   // ← paste User A's UID here
  const USER_B_UID = '';   // ← paste User B's UID here
  const USER_C_UID = '';   // ← paste User C's UID here

  /* Transfer amounts for each hop */
  const GRANT_AMOUNT    = 1000;  // Founder → User A
  const A_TO_B_AMOUNT   = 300;   // User A  → User B
  const B_TO_C_AMOUNT   = 100;   // User B  → User C
  const C_TO_FOUNDER    = 50;    // User C  → Founder

  /* ─── Worker URL ─── */
  const WORKER  = 'https://yellow-term-11e6.nthntjrn.workers.dev/paypal';

  /* ─── Helpers ─── */
  function log(msg, ...args) {
    console.log(`%c[SNX-TEST] ${msg}`, 'color:#00AEEF;font-weight:bold', ...args);
  }
  function pass(msg) {
    console.log(`%c✅ PASS: ${msg}`, 'color:#00cc66;font-weight:bold');
  }
  function fail(msg) {
    console.error(`❌ FAIL: ${msg}`);
    return false;
  }
  function assert(cond, msg) {
    if (cond) { pass(msg); return true; }
    return fail(msg);
  }
  function sep(title) {
    log('═══════════════════════════════════════════');
    if (title) log(title);
  }

  /* ─── Guard: must be Founder ─── */
  if (window._snxRole !== 'founder') {
    fail('Must be signed in as the Founder to run this test.');
    return;
  }

  /* ─── UID input guard ─── */
  const founderUid = window._snxCurrentUser?.uid;
  const userAUid   = USER_A_UID.trim();
  const userBUid   = USER_B_UID.trim();
  const userCUid   = USER_C_UID.trim();

  if (!founderUid) {
    fail('window._snxCurrentUser is null — is Firebase auth initialized?');
    return;
  }
  if (!userAUid || !userBUid || !userCUid) {
    fail('Please edit USER_A_UID, USER_B_UID, and USER_C_UID at the top of the script before running.');
    return;
  }
  const uids = [userAUid, userBUid, userCUid];
  if (new Set(uids).size < uids.length) {
    fail('USER_A_UID, USER_B_UID, and USER_C_UID must all be different UIDs.');
    return;
  }
  if (uids.includes(founderUid)) {
    fail('User A/B/C must not be the Founder account.');
    return;
  }

  const fs = window._snxFirestore;
  if (!fs) { fail('window._snxFirestore not available — is Firebase initialized?'); return; }
  const { db, doc, getDocFromServer, getDoc } = fs;
  // Prefer getDocFromServer to bypass the Firestore client cache.
  // After a server-side write (grant/purchase), the cache may still hold the old value.
  const _readFresh = getDocFromServer || getDoc;

  /* ─── Read a wallet balance from Firestore (always from server, never cache) ─── */
  async function readBalance(uid) {
    const snap = await _readFresh(doc(db, 'wallets', uid));
    if (!snap.exists()) return 0;
    const v = snap.data().shadowCoins;
    return typeof v === 'number' ? v : 0;
  }

  /* ─── Get Founder ID token ─── */
  async function getIdToken() {
    const user = window._snxCurrentUser;
    if (!user) throw new Error('No current user');
    return user.getIdToken(/* forceRefresh */ true);
  }

  /* ─── Grant test coins from Founder to a recipient ─── */
  async function grantCoins(recipientUid, amount) {
    const idToken = await getIdToken();
    const resp = await fetch(`${WORKER}/grant-test-coins`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        idToken,
        recipientUid,
        amount,
        reason: '4-hop circulation test',
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.success) {
      throw new Error(`Grant failed (${resp.status}): ${JSON.stringify(data)}`);
    }
    return data;
  }

  /* ─── Transfer coins between any two users (Founder-authorized, server-side) ─── */
  async function transferCoins(senderUid, recipientUid, amount, reason) {
    const idToken = await getIdToken();
    const resp = await fetch(`${WORKER}/transfer-test-coins`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        idToken,
        senderUid,
        recipientUid,
        amount,
        reason: reason || '4-hop circulation test',
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.success) {
      throw new Error(`Transfer failed (${resp.status}): ${JSON.stringify(data)}`);
    }
    return data;
  }

  /* ════════════════════════════════════════════
     MAIN TEST SEQUENCE
     ════════════════════════════════════════════ */
  sep('Free Test-Coin Flow — 4-Hop Circulation Test START');
  log(`Founder: ${founderUid}`);
  log(`User A:  ${userAUid}`);
  log(`User B:  ${userBUid}`);
  log(`User C:  ${userCUid}`);
  sep();

  let ok = true;

  /* ══ BASELINE: read all four balances before any transaction ══ */
  log('\nBASELINE — Reading initial balances…');
  const bal = {
    founder: { before: 0 },
    a:       { before: 0 },
    b:       { before: 0 },
    c:       { before: 0 },
  };
  bal.founder.before = await readBalance(founderUid);
  bal.a.before       = await readBalance(userAUid);
  bal.b.before       = await readBalance(userBUid);
  bal.c.before       = await readBalance(userCUid);
  log(`Founder balance BEFORE:  ${bal.founder.before}`);
  log(`User A  balance BEFORE:  ${bal.a.before}`);
  log(`User B  balance BEFORE:  ${bal.b.before}`);
  log(`User C  balance BEFORE:  ${bal.c.before}`);

  /* ══════════════════════════════════════════════════════════════
     HOP 1: Founder grants 1,000 test coins to User A
     ══════════════════════════════════════════════════════════════ */
  sep(`HOP 1 — Founder → User A: +${GRANT_AMOUNT} coins`);
  try {
    const grantResult = await grantCoins(userAUid, GRANT_AMOUNT);
    log(`Worker grant response:`, grantResult);
  } catch (err) {
    fail(`Hop 1 grant call failed: ${err.message}`);
    return;
  }

  // Verify Firestore after Hop 1
  log('Verifying Firestore balances after Hop 1…');
  const hop1_a = await readBalance(userAUid);
  const exp1_a = bal.a.before + GRANT_AMOUNT;
  log(`User A balance AFTER Hop 1: ${hop1_a} (expected ${exp1_a})`);
  ok = assert(hop1_a === exp1_a,
    `Hop 1: User A balance ${hop1_a} === ${exp1_a} (+${GRANT_AMOUNT} grant)`) && ok;

  /* ══════════════════════════════════════════════════════════════
     HOP 2: User A sends 300 coins to User B
     ══════════════════════════════════════════════════════════════ */
  sep(`HOP 2 — User A → User B: ${A_TO_B_AMOUNT} coins`);

  // Verify User A has enough coins before attempting
  if (hop1_a < A_TO_B_AMOUNT) {
    fail(`Hop 2 skipped — User A only has ${hop1_a} coins, needs ${A_TO_B_AMOUNT}.`);
    return;
  }

  try {
    const xfr2 = await transferCoins(userAUid, userBUid, A_TO_B_AMOUNT, 'Hop 2: A→B');
    log(`Hop 2 transfer response:`, xfr2);
  } catch (err) {
    fail(`Hop 2 transfer failed: ${err.message}`);
    return;
  }

  // Verify Firestore after Hop 2
  log('Verifying Firestore balances after Hop 2…');
  const hop2_a = await readBalance(userAUid);
  const hop2_b = await readBalance(userBUid);
  const exp2_a = exp1_a - A_TO_B_AMOUNT;    // 1000 - 300 = 700 net gain for A
  const exp2_b = bal.b.before + A_TO_B_AMOUNT;
  log(`User A balance AFTER Hop 2: ${hop2_a} (expected ${exp2_a})`);
  log(`User B balance AFTER Hop 2: ${hop2_b} (expected ${exp2_b})`);
  ok = assert(hop2_a === exp2_a,
    `Hop 2: User A balance ${hop2_a} === ${exp2_a} (-${A_TO_B_AMOUNT} sent)`) && ok;
  ok = assert(hop2_b === exp2_b,
    `Hop 2: User B balance ${hop2_b} === ${exp2_b} (+${A_TO_B_AMOUNT} received)`) && ok;

  /* ══════════════════════════════════════════════════════════════
     HOP 3: User B sends 100 coins to User C
     These coins originated as Founder test coins → User A → User B.
     They must be treated as normal Shadow Coins here.
     ══════════════════════════════════════════════════════════════ */
  sep(`HOP 3 — User B → User C: ${B_TO_C_AMOUNT} coins`);

  if (hop2_b < B_TO_C_AMOUNT) {
    fail(`Hop 3 skipped — User B only has ${hop2_b} coins, needs ${B_TO_C_AMOUNT}.`);
    return;
  }

  try {
    const xfr3 = await transferCoins(userBUid, userCUid, B_TO_C_AMOUNT, 'Hop 3: B→C');
    log(`Hop 3 transfer response:`, xfr3);
  } catch (err) {
    fail(`Hop 3 transfer failed: ${err.message}`);
    return;
  }

  // Verify Firestore after Hop 3
  log('Verifying Firestore balances after Hop 3…');
  const hop3_b = await readBalance(userBUid);
  const hop3_c = await readBalance(userCUid);
  const exp3_b = exp2_b - B_TO_C_AMOUNT;
  const exp3_c = bal.c.before + B_TO_C_AMOUNT;
  log(`User B balance AFTER Hop 3: ${hop3_b} (expected ${exp3_b})`);
  log(`User C balance AFTER Hop 3: ${hop3_c} (expected ${exp3_c})`);
  ok = assert(hop3_b === exp3_b,
    `Hop 3: User B balance ${hop3_b} === ${exp3_b} (-${B_TO_C_AMOUNT} sent)`) && ok;
  ok = assert(hop3_c === exp3_c,
    `Hop 3: User C balance ${hop3_c} === ${exp3_c} (+${B_TO_C_AMOUNT} received)`) && ok;

  /* ══════════════════════════════════════════════════════════════
     HOP 4: User C sends 50 coins back to Founder
     These coins have now traveled Founder→A→B→C and back.
     ══════════════════════════════════════════════════════════════ */
  sep(`HOP 4 — User C → Founder: ${C_TO_FOUNDER} coins`);

  if (hop3_c < C_TO_FOUNDER) {
    fail(`Hop 4 skipped — User C only has ${hop3_c} coins, needs ${C_TO_FOUNDER}.`);
    return;
  }

  try {
    const xfr4 = await transferCoins(userCUid, founderUid, C_TO_FOUNDER, 'Hop 4: C→Founder');
    log(`Hop 4 transfer response:`, xfr4);
  } catch (err) {
    fail(`Hop 4 transfer failed: ${err.message}`);
    return;
  }

  // Verify Firestore after Hop 4
  log('Verifying Firestore balances after Hop 4…');
  const hop4_c       = await readBalance(userCUid);
  const hop4_founder = await readBalance(founderUid);
  const exp4_c       = exp3_c - C_TO_FOUNDER;
  const exp4_founder = bal.founder.before + C_TO_FOUNDER;
  log(`User C  balance AFTER Hop 4: ${hop4_c}       (expected ${exp4_c})`);
  log(`Founder balance AFTER Hop 4: ${hop4_founder} (expected ${exp4_founder})`);
  ok = assert(hop4_c === exp4_c,
    `Hop 4: User C balance ${hop4_c} === ${exp4_c} (-${C_TO_FOUNDER} sent)`) && ok;
  ok = assert(hop4_founder === exp4_founder,
    `Hop 4: Founder balance ${hop4_founder} === ${exp4_founder} (+${C_TO_FOUNDER} received)`) && ok;

  /* ══════════════════════════════════════════════════════════════
     FINAL SUMMARY
     ══════════════════════════════════════════════════════════════ */
  sep('FINAL RESULTS SUMMARY');
  log('');
  log('Account        Before    Expected After    Actual After');
  log('─────────────────────────────────────────────────────────');

  const finalFounder = hop4_founder;
  const finalA       = hop2_a;
  const finalB       = hop3_b;
  const finalC       = hop4_c;

  log(`Founder        ${bal.founder.before.toString().padStart(6)}    ${exp4_founder.toString().padStart(14)}    ${finalFounder.toString().padStart(12)}`);
  log(`User A         ${bal.a.before.toString().padStart(6)}    ${exp2_a.toString().padStart(14)}    ${finalA.toString().padStart(12)}`);
  log(`User B         ${bal.b.before.toString().padStart(6)}    ${exp3_b.toString().padStart(14)}    ${finalB.toString().padStart(12)}`);
  log(`User C         ${bal.c.before.toString().padStart(6)}    ${exp4_c.toString().padStart(14)}    ${finalC.toString().padStart(12)}`);
  log('');

  // Conservation check: net coins in the system = original grant amount minus what came back to Founder
  // (Founder issued GRANT_AMOUNT, received back C_TO_FOUNDER → net issued = GRANT_AMOUNT - C_TO_FOUNDER)
  const expectedNetIssued   = GRANT_AMOUNT - C_TO_FOUNDER;
  const actualDeltaA        = finalA       - bal.a.before;
  const actualDeltaB        = finalB       - bal.b.before;
  const actualDeltaC        = finalC       - bal.c.before;
  const actualDeltaFounder  = finalFounder - bal.founder.before;
  const actualNetIssued     = actualDeltaA + actualDeltaB + actualDeltaC + actualDeltaFounder;

  log(`Net coin delta across all 4 accounts: ${actualNetIssued} (expected ${expectedNetIssued})`);
  ok = assert(actualNetIssued === expectedNetIssued,
    `Conservation: net issued coins = ${actualNetIssued} (${GRANT_AMOUNT} granted - ${C_TO_FOUNDER} returned = ${expectedNetIssued})`) && ok;

  log('');
  log('Individual hop assertions:');
  ok = assert(finalA >= 0,       `User A final balance non-negative (${finalA})`) && ok;
  ok = assert(finalB >= 0,       `User B final balance non-negative (${finalB})`) && ok;
  ok = assert(finalC >= 0,       `User C final balance non-negative (${finalC})`) && ok;
  ok = assert(finalFounder >= 0, `Founder final balance non-negative (${finalFounder})`) && ok;

  sep('VERDICT');
  if (ok) {
    console.log(
      '%c🎉 ALL 4 HOPS PASSED — Test coins circulate normally as Shadow Coins.',
      'color:#00cc66;font-size:14px;font-weight:bold'
    );
    console.log(
      '%cFlow: Founder →+1000→ A →-300→ B →-100→ C →-50→ Founder ✓',
      'color:#00cc66;font-size:12px;'
    );
  } else {
    console.error('❌ ONE OR MORE HOPS FAILED — see details above.');
    console.error('Check: worker deployed? Firestore rules deployed? UIDs correct?');
  }
  sep();
})();
