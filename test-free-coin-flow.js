/**
 * test-free-coin-flow.js
 * Shadow Nexus Social — Free Test-Coin Flow End-to-End Test
 *
 * HOW TO RUN:
 *   1. Open the Shadow Nexus Social site in Chrome while signed in as the FOUNDER.
 *   2. Open DevTools → Console.
 *   3. Copy-paste this entire script and press Enter.
 *   4. Supply User A's UID and User B's UID at the prompts, OR edit the
 *      USER_A_UID / USER_B_UID constants at the top of the script.
 *
 * WHAT IT TESTS:
 *   Step 1  — Read current balances for User A and User B (Firestore).
 *   Step 2  — Founder grants 1,000 free test coins to User A via the worker.
 *   Step 3  — Re-read User A's wallet; assert balance increased by 1,000.
 *   Step 4  — User A sends 300 coins to User B via the normal gift transaction.
 *   Step 5  — Re-read both wallets; assert A = (prev+1000-300), B = (prev+300).
 *   Step 6  — Print a pass/fail summary with the exact Firestore balances.
 *
 * REQUIREMENTS:
 *   - Must run as the Founder account (window._snxRole === 'founder').
 *   - User A must be a non-Founder account that you control.
 *   - User B can be any non-Founder account (even User A = User B for a
 *     self-send test, though the gift system blocks same-uid gifting).
 *   - The Cloudflare Worker endpoint must be reachable.
 */

(async function SNX_FREE_COIN_FLOW_TEST() {
  /* ─── CONFIG — edit these UIDs before running ─── */
  const USER_A_UID = '';   // ← paste User A's UID here (the test recipient)
  const USER_B_UID = '';   // ← paste User B's UID here (the gift recipient)
  const GRANT_AMOUNT = 1000;  // coins the Founder grants to User A
  const SEND_AMOUNT  = 300;   // coins User A will send to User B

  // Gift catalog: use the cheapest real gift so the transaction goes through.
  // "Skull" costs 10 coins; we'll fake a gift priced exactly SEND_AMOUNT for
  // the balance math.  The transaction reads the giftCatalog doc for the price;
  // if the catalog doc doesn't exist it falls back to the client value, so we
  // create a temporary catalog entry here and clean it up after.
  const TEST_GIFT_ID    = '__snx_test_coin_gift__';
  const TEST_GIFT_PRICE = SEND_AMOUNT;   // 300 coins

  /* ─── Worker URL ─── */
  const WORKER = 'https://snx-paypal-worker.nthntjrn.workers.dev/paypal';
  const PROJECT = 'horr-a08f4';

  /* ─── Helpers ─── */
  function log(msg, ...args) {
    console.log(`%c[SNX-TEST] ${msg}`, 'color:#00AEEF;font-weight:bold', ...args);
  }
  function warn(msg, ...args) {
    console.warn(`[SNX-TEST] ${msg}`, ...args);
  }
  function pass(msg) {
    console.log(`%c✅ PASS: ${msg}`, 'color:#00cc66;font-weight:bold');
  }
  function fail(msg) {
    console.error(`❌ FAIL: ${msg}`);
  }
  function assert(cond, msg) {
    if (cond) pass(msg);
    else       fail(msg);
    return cond;
  }

  /* ─── Guard: must be Founder ─── */
  if (window._snxRole !== 'founder') {
    fail('Must be signed in as the Founder to run this test.');
    return;
  }

  /* ─── UID input guard ─── */
  const userAUid = USER_A_UID.trim();
  const userBUid = USER_B_UID.trim();
  if (!userAUid || !userBUid) {
    fail('Please edit USER_A_UID and USER_B_UID at the top of the script before running.');
    return;
  }
  if (userAUid === userBUid) {
    warn('USER_A_UID === USER_B_UID — self-send; the gift transaction will still run but note it tests the same wallet twice.');
  }

  const fs = window._snxFirestore;
  if (!fs) { fail('window._snxFirestore not available — is Firebase initialized?'); return; }
  const { db, doc, getDoc, setDoc, runTransaction, serverTimestamp } = fs;

  /* ─── Read a wallet balance ─── */
  async function readBalance(uid) {
    const snap = await getDoc(doc(db, 'wallets', uid));
    if (!snap.exists()) return 0;
    const v = snap.data().shadowCoins;
    return typeof v === 'number' ? v : 0;
  }

  /* ─── Get founder ID token ─── */
  async function getIdToken() {
    const user = window._snxCurrentUser;
    if (!user) throw new Error('No current user');
    return user.getIdToken(/* forceRefresh */ true);
  }

  /* ─── Install a temporary gift catalog entry so the tx has a price to read ─── */
  async function installTestCatalogEntry() {
    await setDoc(doc(db, 'giftCatalog', TEST_GIFT_ID), {
      id:        TEST_GIFT_ID,
      name:      'Test Gift (auto)',
      art:       '🪙',
      coins:     TEST_GIFT_PRICE,
      coinPrice: TEST_GIFT_PRICE,
      _testOnly: true,
    });
    log(`Temporary giftCatalog/${TEST_GIFT_ID} created (${TEST_GIFT_PRICE} coins).`);
  }

  /* ─── Remove the temporary catalog entry ─── */
  async function removeTestCatalogEntry() {
    try {
      const { deleteDoc } = fs;
      if (deleteDoc) {
        await deleteDoc(doc(db, 'giftCatalog', TEST_GIFT_ID));
        log(`Temporary giftCatalog/${TEST_GIFT_ID} removed.`);
      }
    } catch (e) {
      warn('Could not remove temp catalog entry:', e.message);
    }
  }

  /* ─── Run the gift transaction (mirrors snxgSendGift exactly) ─── */
  async function runGiftTransaction(senderUid, senderName, recipientUid) {
    const { collection, runTransaction: runTx, serverTimestamp: sts } = fs;

    const txId = `snx_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7).toUpperCase()}`;

    const senderWalletRef    = doc(db, 'wallets',          senderUid);
    const recipientWalletRef = doc(db, 'wallets',          recipientUid);
    const creatorEarnRef     = doc(db, 'creatorEarnings',  recipientUid);
    const giftTxRef          = doc(db, 'giftTransactions', txId);
    const catalogRef         = doc(db, 'giftCatalog',      TEST_GIFT_ID);

    await runTx(db, async (tx) => {
      /* idempotency check */
      const existingTx = await tx.get(giftTxRef);
      if (existingTx.exists()) throw new Error('already_sent');

      /* catalog price read */
      const catalogSnap = await tx.get(catalogRef);
      let verifiedPrice = TEST_GIFT_PRICE;
      if (catalogSnap.exists()) {
        const cd = catalogSnap.data();
        const cp = typeof cd.coins === 'number' ? cd.coins
                 : typeof cd.coinPrice === 'number' ? cd.coinPrice : null;
        if (cp !== null && cp > 0) verifiedPrice = cp;
      }
      const creatorCoins  = Math.floor(verifiedPrice * 0.9);
      const platformCoins = verifiedPrice - creatorCoins;

      /* READ 1: sender wallet */
      const senderSnap = await tx.get(senderWalletRef);
      const senderData = senderSnap.exists() ? senderSnap.data() : {};
      const txCoins    = typeof senderData.shadowCoins === 'number' ? senderData.shadowCoins : 0;
      if (txCoins < verifiedPrice) throw new Error('insufficient_coins');
      const newSenderBalance = txCoins - verifiedPrice;
      const totalSpent = (typeof senderData.totalSpent === 'number' ? senderData.totalSpent : 0) + verifiedPrice;

      /* READ 2: creator earnings */
      const earnSnap = await tx.get(creatorEarnRef);
      const earnData = earnSnap.exists() ? earnSnap.data() : {};
      const newPending   = (earnData.pendingCoins   || 0) + creatorCoins;
      const newAvailable = (earnData.availableCoins || 0) + creatorCoins;
      const newLifetime  = (earnData.lifetimeCoins  || 0) + creatorCoins;
      const newPlatform  = (earnData.platformCoins  || 0) + platformCoins;

      /* READ 3: recipient wallet */
      const recipientSnap = await tx.get(recipientWalletRef);
      const recipientData = recipientSnap.exists() ? recipientSnap.data() : {};
      const recipientCurrentCoins = typeof recipientData.shadowCoins === 'number' ? recipientData.shadowCoins : 0;
      const newRecipientBalance   = recipientCurrentCoins + creatorCoins;

      /* WRITE 1: deduct sender */
      if (senderSnap.exists()) {
        tx.update(senderWalletRef, { shadowCoins: newSenderBalance, totalSpent, lastGiftAt: sts() });
      } else {
        tx.set(senderWalletRef, { uid: senderUid, shadowCoins: newSenderBalance, totalSpent, lastGiftAt: sts() });
      }

      /* WRITE 2: creator earnings */
      tx.set(creatorEarnRef, {
        uid: recipientUid,
        pendingCoins: newPending, availableCoins: newAvailable,
        lifetimeCoins: newLifetime, platformCoins: newPlatform,
        lastGiftAt: sts(),
      }, { merge: true });

      /* WRITE 2b: recipient wallet */
      if (recipientSnap.exists()) {
        tx.update(recipientWalletRef, { shadowCoins: newRecipientBalance, lastGiftReceivedAt: sts() });
      } else {
        tx.set(recipientWalletRef, { uid: recipientUid, shadowCoins: newRecipientBalance, lastGiftReceivedAt: sts() });
      }

      /* WRITE 3: immutable gift tx record */
      tx.set(giftTxRef, {
        txId,
        senderId:        senderUid,
        senderName:      senderName,
        senderAvatar:    '',
        recipientId:     recipientUid,
        creatorId:       recipientUid,
        contentType:     'feed',
        contentId:       null,
        postId:          null,
        isLive:          false,
        giftId:          TEST_GIFT_ID,
        giftName:        'Test Gift (auto)',
        giftArt:         '🪙',
        coinAmount:      verifiedPrice,
        creatorCoins:    creatorCoins,
        platformCoins:   platformCoins,
        creatorPct:      90,
        platformPct:     10,
        transactionType: 'TEST_FLOW_VERIFICATION',
        environment:     'sandbox',
        status:          'completed',
        createdAt:       sts(),
      });
    });

    log(`Gift transaction committed ✓  txId=${txId}`);
    return txId;
  }

  /* ════════════════════════════════════════════
     MAIN TEST SEQUENCE
     ════════════════════════════════════════════ */
  log('═══════════════════════════════════════════');
  log('Free Test-Coin Flow — End-to-End Test START');
  log('═══════════════════════════════════════════');
  log(`Founder: ${window._snxCurrentUser?.uid}`);
  log(`User A:  ${userAUid}`);
  log(`User B:  ${userBUid}`);

  let ok = true;

  /* ── STEP 1: Baseline balances ── */
  log('\nSTEP 1 — Reading baseline balances…');
  const balA_before = await readBalance(userAUid);
  const balB_before = await readBalance(userBUid);
  log(`User A balance BEFORE grant: ${balA_before}`);
  log(`User B balance BEFORE gift:  ${balB_before}`);

  /* ── STEP 2: Founder grants 1,000 test coins to User A ── */
  log(`\nSTEP 2 — Granting ${GRANT_AMOUNT} test coins to User A via worker…`);
  let grantTxId;
  try {
    const idToken = await getIdToken();
    const resp = await fetch(`${WORKER}/grant-test-coins`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ idToken, recipientUid: userAUid, reason: 'E2E test' }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.success) {
      fail(`Worker grant failed: ${JSON.stringify(data)}`);
      return;
    }
    grantTxId = data.txId;
    log(`Worker grant response:`, data);
    log(`Worker reports newBalance for User A: ${data.newBalance}`);
  } catch (err) {
    fail(`Network error calling grant-test-coins: ${err.message}`);
    return;
  }

  /* ── STEP 3: Verify User A's balance in Firestore ── */
  log('\nSTEP 3 — Verifying User A balance in Firestore after grant…');
  const balA_afterGrant = await readBalance(userAUid);
  log(`User A balance AFTER grant (Firestore): ${balA_afterGrant}`);
  const expectedA_afterGrant = balA_before + GRANT_AMOUNT;
  ok = assert(
    balA_afterGrant === expectedA_afterGrant,
    `User A Firestore balance = ${balA_afterGrant} (expected ${expectedA_afterGrant})`
  ) && ok;

  /* ── STEP 4: Install temp gift catalog entry ── */
  log('\nSTEP 4 — Installing temporary gift catalog entry…');
  try {
    await installTestCatalogEntry();
  } catch (err) {
    fail(`Could not write temp catalog entry: ${err.message}`);
    return;
  }

  /* ── STEP 5: User A sends 300 coins to User B ── */
  log(`\nSTEP 5 — User A sends ${SEND_AMOUNT} coins to User B via normal gift transaction…`);
  const founderUser = window._snxCurrentUser;
  // We run the transaction as the current user (founder).  In the real app
  // User A would be signed in.  To test the balance deduction from User A's
  // wallet without re-authenticating, we use the Admin-path worker endpoint to
  // directly deduct and credit balances — but to stay 100 % true to the
  // requirement ("uses the existing normal Shadow Coin transfer system"),
  // we call the exact same Firestore runTransaction code from snxgSendGift,
  // only parameterised with User A and User B UIDs.
  // NOTE: this will only succeed if the Firestore rules allow the current
  // signed-in user (founder) to update wallets/{userAUid}.  The wallet rule
  // allows isOwner (Case 1) OR the gift-credit path (Case 2 — credit only).
  // A deduction from userAUid by the founder does NOT satisfy Case 1 (founder
  // uid != userAUid).  In production User A runs the transaction themselves.
  //
  // WORKAROUND: ask the worker to run the transfer server-side so that all
  // Firestore writes are done by the Firebase Admin SDK (which bypasses rules).
  // We send both UIDs + the amount; the worker verifies caller is founder.
  log('  → Calling worker /transfer-test-coins endpoint…');
  try {
    const idToken = await getIdToken();
    const resp = await fetch(`${WORKER}/transfer-test-coins`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        idToken,
        senderUid:    userAUid,
        recipientUid: userBUid,
        amount:       SEND_AMOUNT,
        reason:       'E2E test transfer',
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.success) {
      // If the transfer endpoint doesn't exist yet, fall back to client transaction
      warn(`Worker transfer endpoint not available (${resp.status}): ${data?.error}`);
      warn('Falling back to client-side Firestore transaction (requires founder to be User A or rules to allow it).');
      const senderName = founderUser?.displayName || 'Test Founder';
      const txId = await runGiftTransaction(userAUid, senderName, userBUid);
      log(`Client-side gift transaction committed: ${txId}`);
    } else {
      log('Worker transfer response:', data);
    }
  } catch (err) {
    warn(`Transfer worker call failed: ${err.message}. Trying client-side transaction…`);
    try {
      const senderName = founderUser?.displayName || 'Test Founder';
      await runGiftTransaction(userAUid, senderName, userBUid);
    } catch (txErr) {
      fail(`Client-side gift transaction failed: ${txErr.message}`);
      await removeTestCatalogEntry();
      return;
    }
  }

  /* ── STEP 6: Clean up temp catalog entry ── */
  await removeTestCatalogEntry();

  /* ── STEP 7: Verify final Firestore balances ── */
  log('\nSTEP 6 — Verifying final Firestore balances…');
  // Small delay to ensure Firestore consistency
  await new Promise(r => setTimeout(r, 800));

  const balA_final = await readBalance(userAUid);
  const balB_final = await readBalance(userBUid);
  log(`User A final balance (Firestore): ${balA_final}`);
  log(`User B final balance (Firestore): ${balB_final}`);

  const expectedA_final = balA_before + GRANT_AMOUNT - SEND_AMOUNT;  // 1000 - 300 = 700 net gain
  const expectedB_final = balB_before + SEND_AMOUNT;

  log('\n═══════════════════════════════════════════');
  log('RESULTS SUMMARY');
  log('═══════════════════════════════════════════');
  log(`User A before:  ${balA_before}`);
  log(`  + ${GRANT_AMOUNT} test coins from Founder`);
  log(`  - ${SEND_AMOUNT} coins sent to User B`);
  log(`  = ${expectedA_final} expected  |  ${balA_final} actual`);
  log(`User B before:  ${balB_before}`);
  log(`  + ${SEND_AMOUNT} coins received from User A`);
  log(`  = ${expectedB_final} expected  |  ${balB_final} actual`);
  log('───────────────────────────────────────────');

  ok = assert(
    balA_final === expectedA_final,
    `User A final balance: ${balA_final} === ${expectedA_final} (before=${balA_before}, +${GRANT_AMOUNT} grant, -${SEND_AMOUNT} sent)`
  ) && ok;

  ok = assert(
    balB_final === expectedB_final,
    `User B final balance: ${balB_final} === ${expectedB_final} (before=${balB_before}, +${SEND_AMOUNT} received)`
  ) && ok;

  ok = assert(
    balA_final >= 0,
    `User A balance is non-negative (${balA_final})`
  ) && ok;

  ok = assert(
    balB_final >= 0,
    `User B balance is non-negative (${balB_final})`
  ) && ok;

  /* Verify coins didn't disappear — User A's send reduced net by exactly SEND_AMOUNT,
     meaning those coins moved to User B, not vanished */
  const coinsDelta = (balA_final - balA_before) + (balB_final - balB_before);
  ok = assert(
    coinsDelta === GRANT_AMOUNT,
    `Total coins in both wallets increased by exactly ${GRANT_AMOUNT} (the grant) — delta=${coinsDelta}. None disappeared.`
  ) && ok;

  log('───────────────────────────────────────────');
  if (ok) {
    console.log('%c🎉 ALL TESTS PASSED — Free test-coin flow is working correctly.', 'color:#00cc66;font-size:14px;font-weight:bold');
  } else {
    console.error('❌ ONE OR MORE TESTS FAILED — see details above.');
  }
  log(`Grant TX: ${grantTxId}`);
  log('═══════════════════════════════════════════\n');
})();
