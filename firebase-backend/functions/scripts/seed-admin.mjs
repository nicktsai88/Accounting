import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const projectId = process.env.FIREBASE_PROJECT_ID;
const password = process.env.ADMIN_PASSWORD;
if (!projectId) throw new Error('缺少 FIREBASE_PROJECT_ID。');
if (!password || password.length < 8) throw new Error('ADMIN_PASSWORD 必須至少 8 個字元。');

initializeApp({ credential: applicationDefault(), projectId });
const auth = getAuth();
const db = getFirestore();
const email = 'nick@xishihaircut.internal';

let user;
try {
  user = await auth.getUserByEmail(email);
  user = await auth.updateUser(user.uid, { password, displayName: 'Nick', disabled: false });
} catch (error) {
  if (error.code !== 'auth/user-not-found') throw error;
  user = await auth.createUser({ email, password, displayName: 'Nick', disabled: false });
}

await auth.setCustomUserClaims(user.uid, { admin: true, role: 'admin', profile: 'Nick' });
await db.collection('Accounting_users').doc('Nick').set({
  username: 'Nick',
  uid: user.uid,
  role: 'admin',
  firstUsePending: false,
  updatedAt: FieldValue.serverTimestamp(),
}, { merge: true });

for (const username of ['小雯', '彩屏']) {
  await db.collection('Accounting_users').doc(username).set({
    username,
    role: 'staff',
    firstUsePending: true,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

console.log('Nick 管理者與小雯／彩屏首次設定資料已建立。');

