/**
 * In-browser stand-in for the Firebase SDK, used only by tests/ui.test.mjs.
 * One file is served for every gstatic firebasejs URL the app imports.
 * State lives on window.__fake and is seeded by the test via window.__seed.
 */
const seed = window.__seed || {};
const fake = window.__fake = window.__fake || {
    store: new Map(),
    listeners: new Set(),
    authListeners: [],
    user: null,
    tokenRefreshes: 0
};

const ts = (ms) => ({ toMillis: () => ms, seconds: Math.floor(ms / 1000) });
const SERVER_TS = { __serverTimestamp: true };

function revive(value) {
    if (value && typeof value === 'object' && '__ts' in value) return ts(Date.now() + value.__ts);
    return value;
}
if (!fake.seeded) {
    fake.seeded = true;
    for (const [path, data] of Object.entries(seed.store || {})) {
        fake.store.set(path, Object.fromEntries(Object.entries(data).map(([k, v]) => [k, revive(v)])));
    }
}

function makeUser(u) {
    return {
        uid: u.uid, email: u.email, emailVerified: u.emailVerified !== false,
        displayName: u.displayName || 'Test User', photoURL: '',
        getIdToken: async (force) => { if (force) fake.tokenRefreshes++; return 'token'; }
    };
}

// ---------- app ----------
export function initializeApp(config) { return { config }; }

// ---------- auth ----------
export class GoogleAuthProvider {}
export function getAuth() { return {}; }
export function onAuthStateChanged(auth, cb) {
    fake.authListeners.push(cb);
    if (seed.user && !fake.user) fake.user = makeUser(seed.user);
    setTimeout(() => cb(fake.user), 0);
    return () => {};
}
export async function signInWithPopup() {
    fake.user = makeUser(seed.signInAs || { uid: 'new-user', email: 'new@example.com' });
    fake.authListeners.forEach(cb => cb(fake.user));
    return { user: fake.user };
}
export async function signOut() {
    fake.user = null;
    fake.authListeners.forEach(cb => cb(null));
}

// ---------- firestore ----------
export function getFirestore() { return {}; }
export function serverTimestamp() { return SERVER_TS; }
export function doc(db, ...segments) { const path = segments.join('/'); return { path, id: path.split('/').pop() }; }
export function collection(db, ...segments) { return { path: segments.join('/'), constraints: [] }; }
export function orderBy(field, dir = 'asc') { return { type: 'orderBy', field, dir }; }
export function where(field, op, value) { return { type: 'where', field, op, value }; }
export function query(col, ...constraints) { return { path: col.path, constraints }; }

function resolve(data) {
    return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v === SERVER_TS ? ts(Date.now()) : v]));
}
function denied(path, kind) {
    return typeof fake.deny === 'function' && fake.deny(path, kind);
}
function fail() {
    const err = new Error('Missing or insufficient permissions.');
    err.code = 'permission-denied';
    throw err;
}
function docSnap(path) {
    const data = fake.store.get(path);
    return { id: path.split('/').pop(), exists: () => data !== undefined, data: () => (data ? { ...data } : undefined) };
}
function querySnap(q) {
    let docs = [...fake.store.keys()]
        .filter(p => p.startsWith(q.path + '/') && !p.slice(q.path.length + 1).includes('/'))
        .map(docSnap);
    for (const c of q.constraints || []) {
        if (c.type === 'where' && c.op === 'in') docs = docs.filter(d => c.value.includes(d.data()[c.field]));
        if (c.type === 'where' && c.op === '==') docs = docs.filter(d => d.data()[c.field] === c.value);
        if (c.type === 'orderBy') {
            docs.sort((a, b) => String(a.data()[c.field] ?? '').localeCompare(String(b.data()[c.field] ?? '')) * (c.dir === 'desc' ? -1 : 1));
        }
    }
    return { docs, empty: docs.length === 0, size: docs.length, forEach: (fn) => docs.forEach(fn) };
}
function notify(path) {
    for (const l of fake.listeners) {
        if (l.target.constraints) {
            if (path.startsWith(l.target.path + '/')) l.cb(querySnap(l.target));
        } else if (l.target.path === path) {
            l.cb(docSnap(path));
        }
    }
}
function write(path, data, merge) {
    const previous = fake.store.get(path);
    fake.store.set(path, merge && previous ? { ...previous, ...resolve(data) } : resolve(data));
    setTimeout(() => notify(path), 0);
}

export async function getDoc(ref) { if (denied(ref.path, 'read')) fail(); return docSnap(ref.path); }
export async function getDocs(q) { return querySnap(q); }
export async function setDoc(ref, data, opts = {}) {
    if (denied(ref.path, 'write')) fail();
    write(ref.path, data, opts.merge);
}
export async function deleteDoc(ref) { fake.store.delete(ref.path); }
export async function addDoc(col, data) {
    const id = 'doc' + Math.random().toString(36).slice(2, 10);
    const path = `${col.path}/${id}`;
    write(path, data, false);
    return { path, id };
}
export function writeBatch() {
    const ops = [];
    return {
        set: (ref, data, opts = {}) => ops.push({ ref, data, opts }),
        delete: (ref) => ops.push({ ref, remove: true }),
        commit: async () => {
            if (ops.some(op => !op.remove && denied(op.ref.path, 'write'))) fail();
            (fake.batchSizes = fake.batchSizes || []).push(ops.length);
            for (const op of ops) {
                if (op.remove) fake.store.delete(op.ref.path);
                else write(op.ref.path, op.data, op.opts.merge);
            }
        }
    };
}
export function onSnapshot(target, cb) {
    const listener = { target, cb };
    fake.listeners.add(listener);
    setTimeout(() => cb(target.constraints ? querySnap(target) : docSnap(target.path)), 0);
    return () => fake.listeners.delete(listener);
}

// ---------- functions ----------
export function getFunctions(app, region) { return { region }; }
// Stand-ins for the Cloud Functions in functions/index.js.
const serverFunctions = {
    async createSubscription({ plan, token }) {
        if (token === 'cnon:declined') {
            const err = new Error('Card declined.');
            err.code = 'functions/failed-precondition';
            throw err;
        }
        write(`billing/${fake.user.uid}`, {
            active: true, status: 'active', plan, cancelRequested: false, endsAt: null,
            chargedThrough: '2027-11-21', squareSubscriptionId: 'SUB_1'
        }, true);
        return { plan, subscriptionId: 'SUB_1' };
    },
    async deleteAccount() {
        if (fake.deleteFails) {
            const err = new Error('Your subscription could not be cancelled just now, so nothing was deleted. Please try again in a few minutes.');
            err.code = 'functions/unavailable';
            throw err;
        }
        const uid = fake.user.uid;
        for (const path of [...fake.store.keys()]) {
            if (path === `users/${uid}` || path.startsWith(`users/${uid}/`) || path === `billing/${uid}`) {
                fake.store.delete(path);
            }
        }
        return { deleted: true };
    },
    async cancelSubscription() {
        const endsAt = Date.UTC(2027, 10, 21, 23, 59, 59);
        write(`billing/${fake.user.uid}`, { cancelRequested: true, endsAt: ts(endsAt) }, true);
        return { endsAt };
    }
};
export function httpsCallable(functions, name) {
    return async (data) => {
        fake.calls = fake.calls || [];
        fake.calls.push({ name, region: functions.region, data });
        return { data: await serverFunctions[name](data) };
    };
}
