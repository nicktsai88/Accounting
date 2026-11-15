const crypto = require('node:crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

initializeApp();

const auth = getAuth();
const db = getFirestore();
const REGION = 'us-central1';
const USERS_COLLECTION = 'Accounting_users';
const AUDIT_COLLECTION = 'Accounting_audit';
const ACCOUNT_EMAILS = {
  Nick: 'nick@xishihaircut.internal',
  '小雯': 'xiaowen@xishihaircut.internal',
  '彩屏': 'caiping@xishihaircut.internal',
};

function requireAdmin(request) {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError('permission-denied', '只有 Nick 管理者可以執行這項操作。');
  }
}

function requireKnownUser(username) {
  if (!Object.prototype.hasOwnProperty.call(ACCOUNT_EMAILS, username)) {
    throw new HttpsError('invalid-argument', '使用者不存在。');
  }
}

function requireStaff(username) {
  if (!['小雯', '彩屏'].includes(username)) {
    throw new HttpsError('invalid-argument', '此帳號不支援首次設定。');
  }
}

function requirePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new HttpsError('invalid-argument', '密碼長度必須為 8 至 128 個字元。');
  }
}

function hashCode(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

async function writeAudit(action, actorUid, target, details = {}) {
  await db.collection(AUDIT_COLLECTION).add({
    action,
    actorUid: actorUid || 'first-use',
    target,
    details,
    createdAt: FieldValue.serverTimestamp(),
  });
}

async function getAuthUser(username) {
  try {
    return await auth.getUserByEmail(ACCOUNT_EMAILS[username]);
  } catch (error) {
    if (error.code === 'auth/user-not-found') return null;
    throw error;
  }
}

exports.adminListUsers = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const users = await Promise.all(Object.keys(ACCOUNT_EMAILS).map(async (username) => {
    const [authUser, profileSnapshot] = await Promise.all([
      getAuthUser(username),
      db.collection(USERS_COLLECTION).doc(username).get(),
    ]);
    const profile = profileSnapshot.exists ? profileSnapshot.data() : {};
    return {
      username,
      uid: authUser?.uid || '',
      disabled: Boolean(authUser?.disabled),
      firstUsePending: username !== 'Nick' && (!authUser || profile.firstUsePending !== false),
      createdAt: authUser?.metadata?.creationTime || '',
      lastSignInTime: authUser?.metadata?.lastSignInTime || '',
      updatedAt: profile.updatedAt?.toDate?.().toISOString?.() || '',
    };
  }));
  return { users };
});

exports.adminIssueActivation = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const username = String(request.data?.username || '');
  requireStaff(username);
  if (await getAuthUser(username)) {
    throw new HttpsError('failed-precondition', '此帳號已完成首次設定。');
  }
  const activationCode = crypto.randomBytes(9).toString('base64url').toUpperCase();
  const expiresAt = Timestamp.fromMillis(Date.now() + 30 * 60 * 1000);
  await db.collection(USERS_COLLECTION).doc(username).set({
    username,
    role: 'staff',
    firstUsePending: true,
    activationCodeHash: hashCode(activationCode),
    activationExpiresAt: expiresAt,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  await writeAudit('issue-activation', request.auth.uid, username, { expiresAt: expiresAt.toDate().toISOString() });
  return { activationCode, expiresAt: expiresAt.toDate().toISOString() };
});

exports.claimFirstUse = onCall({ region: REGION }, async (request) => {
  if (request.auth) throw new HttpsError('failed-precondition', '請先登出其他帳號。');
  const username = String(request.data?.username || '');
  const activationCode = String(request.data?.activationCode || '').trim().toUpperCase();
  const password = request.data?.password;
  requireStaff(username);
  requirePassword(password);
  if (!activationCode) throw new HttpsError('invalid-argument', '請輸入首次啟用碼。');

  const userRef = db.collection(USERS_COLLECTION).doc(username);
  const snapshot = await userRef.get();
  const data = snapshot.exists ? snapshot.data() : {};
  const expiresAt = data.activationExpiresAt?.toMillis?.() || 0;
  if (!data.firstUsePending || !data.activationCodeHash || expiresAt < Date.now()) {
    throw new HttpsError('failed-precondition', '啟用碼不存在或已逾期，請聯絡 Nick 重新產生。');
  }
  const suppliedHash = hashCode(activationCode);
  const expected = Buffer.from(data.activationCodeHash, 'hex');
  const supplied = Buffer.from(suppliedHash, 'hex');
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    throw new HttpsError('permission-denied', '首次啟用碼不正確。');
  }
  if (await getAuthUser(username)) {
    throw new HttpsError('failed-precondition', '此帳號已完成首次設定，請直接登入。');
  }

  let createdUser = null;
  try {
    createdUser = await auth.createUser({
      email: ACCOUNT_EMAILS[username],
      password,
      displayName: username,
      disabled: false,
    });
    await auth.setCustomUserClaims(createdUser.uid, { role: 'staff', profile: username });
    await userRef.set({
      username,
      uid: createdUser.uid,
      role: 'staff',
      firstUsePending: false,
      activationCodeHash: FieldValue.delete(),
      activationExpiresAt: FieldValue.delete(),
      passwordUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await writeAudit('complete-first-use', createdUser.uid, username);
    return { success: true };
  } catch (error) {
    if (createdUser?.uid) await auth.deleteUser(createdUser.uid).catch(() => {});
    if (error instanceof HttpsError) throw error;
    throw new HttpsError('internal', '首次設定失敗，請聯絡 Nick。');
  }
});

exports.adminSetPassword = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const username = String(request.data?.username || '');
  const password = request.data?.password;
  requireKnownUser(username);
  requirePassword(password);
  const user = await getAuthUser(username);
  if (!user) throw new HttpsError('failed-precondition', '此帳號尚未完成首次設定。');
  await auth.updateUser(user.uid, { password });
  await auth.revokeRefreshTokens(user.uid);
  await db.collection(USERS_COLLECTION).doc(username).set({
    passwordUpdatedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  await writeAudit('set-password', request.auth.uid, username);
  return { success: true };
});

exports.adminSetDisabled = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const username = String(request.data?.username || '');
  const disabled = Boolean(request.data?.disabled);
  requireStaff(username);
  const user = await getAuthUser(username);
  if (!user) throw new HttpsError('failed-precondition', '此帳號尚未完成首次設定。');
  await auth.updateUser(user.uid, { disabled });
  if (disabled) await auth.revokeRefreshTokens(user.uid);
  await db.collection(USERS_COLLECTION).doc(username).set({ disabled, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await writeAudit(disabled ? 'disable-user' : 'enable-user', request.auth.uid, username);
  return { success: true };
});

