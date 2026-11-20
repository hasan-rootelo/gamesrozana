// Drama Roz: connection to Firebase (sign-in, questions, answers, leaderboard).
// The answers are NOT in this file or anywhere on the website. They live in Firebase
// and each one only unlocks after the player has locked in that question.
import {
  initializeApp, getAuth, signInAnonymously, onAuthStateChanged, GoogleAuthProvider,
  linkWithPopup, signInWithCredential, getFirestore, doc, getDoc, setDoc, updateDoc,
  writeBatch, collection, query, orderBy, limit, getDocs, where, getCount
} from './fb.js';

const firebaseConfig = {
  apiKey: 'AIzaSyD7tW5e8eaSLU8-lcWVWaF260L2lPeFIeM',
  authDomain: 'gamesrozana-b5b7c.firebaseapp.com',
  projectId: 'gamesrozana-b5b7c',
  storageBucket: 'gamesrozana-b5b7c.firebasestorage.app',
  messagingSenderId: '49406969713',
  appId: '1:49406969713:web:1c6ef55d46d47433fe58d0'
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
let user = null;

const info = () => ({ uid: user.uid, anon: user.isAnonymous, googleName: user.displayName || '' });

export function ready() {
  return new Promise((resolve, reject) => {
    const stop = onAuthStateChanged(auth, async u => {
      if (u) { user = u; stop(); resolve(info()); return; }
      try { await signInAnonymously(auth); } catch (e) { stop(); reject(e); }
    });
  });
}

export async function getDay(n) {
  try { const s = await getDoc(doc(db, 'days', String(n))); return s.exists() ? s.data() : null; }
  catch (e) { if (e.code === 'permission-denied') return null; throw e; }
}

export async function getPlay(n) {
  const s = await getDoc(doc(db, 'plays', user.uid + '_' + n));
  return s.exists() ? s.data() : null;
}

export async function getKey(n, q) {
  const s = await getDoc(doc(db, 'keys', n + '_' + q));
  return s.data(); // { a: index of right option, f: fact }
}

async function getPlayer() {
  const s = await getDoc(doc(db, 'players', user.uid));
  return s.exists() ? s.data() : null;
}

// Lock this account for today (used when today's quiz was already played on this device under another account).
export async function forfeitToday(n) {
  try { await setDoc(doc(db, 'plays', user.uid + '_' + n), { uid: user.uid, day: n, picks: [], scored: 0, pts: 0, star: 0, forfeit: true }); }
  catch (e) { /* already has a play today: nothing to lock */ }
  return getPlay(n);
}

// Lock in an answer, then score it. Returns the updated play and the key for that question.
export async function answer(n, play, pick) {
  const ref = doc(db, 'plays', user.uid + '_' + n);
  if (!play) {
    play = { uid: user.uid, day: n, picks: [pick], scored: 0, pts: 0, star: 0 };
    await setDoc(ref, play);
  } else if (play.picks.length === play.scored) {
    play = { ...play, picks: [...play.picks, pick] };
    await updateDoc(ref, { picks: play.picks });
  }
  return scorePending(n, play);
}

// Score any locked-in answer that hasn't been scored yet (also used after a dropped connection).
export async function scorePending(n, play) {
  let key = null;
  while (play.scored < play.picks.length) {
    const q = play.scored;
    key = await getKey(n, q);
    const right = play.picks[q] === key.a ? 1 : 0;
    const next = { ...play, scored: q + 1, pts: play.pts + (q < 3 ? right : 0), star: q === 3 ? right : play.star };
    const player = await getPlayer();
    const old = player || { pts: 0, stars: 0, days: 0, name: null };
    const totals = {
      pts: old.pts + (next.pts - play.pts),
      stars: old.stars + (next.star - play.star),
      days: old.days + (play.scored === 0 ? 1 : 0),
      ref: n,
      name: old.name ?? null
    };
    const b = writeBatch(db);
    b.update(doc(db, 'plays', user.uid + '_' + n), { scored: next.scored, pts: next.pts, star: next.star });
    b.set(doc(db, 'players', user.uid), totals);
    if (totals.name) b.set(doc(db, 'board', user.uid), { name: totals.name, pts: totals.pts, stars: totals.stars, days: totals.days });
    await b.commit();
    play = next;
  }
  return { play, key };
}

// ---------- leaderboard ----------
export async function me() {
  const p = await getPlayer();
  return p ? { ...p, joined: !!p.name && !user.isAnonymous } : { pts: 0, stars: 0, days: 0, name: null, joined: false };
}

export async function joinWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await linkWithPopup(auth.currentUser, provider);
  } catch (e) {
    if (e.code === 'auth/credential-already-in-use') {
      // This Google account already plays on another device: switch to it.
      const cred = GoogleAuthProvider.credentialFromError(e);
      await signInWithCredential(auth, cred);
    } else throw e;
  }
  user = auth.currentUser;
  await user.getIdToken(true); // refresh so the database sees the Google email
  return info();
}

export async function setName(name) {
  const p = await getPlayer();
  const b = writeBatch(db);
  const t = p ? { ...p, name } : { pts: 0, stars: 0, days: 0, ref: 0, name };
  if (p) b.update(doc(db, 'players', user.uid), { name }); else b.set(doc(db, 'players', user.uid), t);
  b.set(doc(db, 'board', user.uid), { name, pts: t.pts, stars: t.stars, days: t.days });
  await b.commit();
}

export async function leaderboard(n = 20) {
  const s = await getDocs(query(collection(db, 'board'), orderBy('pts', 'desc'), limit(n)));
  return s.docs.map(d => ({ uid: d.id, ...d.data(), you: d.id === user.uid }));
}

export async function myRank(pts) {
  const c = await getCount(query(collection(db, 'board'), where('pts', '>', pts)));
  return c.data().count + 1;
}
