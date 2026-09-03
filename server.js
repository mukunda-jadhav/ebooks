const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { MongoClient } = require('mongodb');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { Readable } = require('stream');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const BOOKS_FILE = path.join(ROOT, 'data', 'books.json');
const STORE_FILE = path.join(ROOT, 'data', 'purchases.json');
const USERS_FILE = path.join(ROOT, 'data', 'users.local.json');
const PRIVATE_BOOKS = path.join(ROOT, 'private-books');
const COVERS_DIR = path.join(ROOT, 'public', 'covers');
const TOKEN_LIFETIME_MS = 30 * 60 * 1000;
const USER_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

let books = JSON.parse(fs.readFileSync(BOOKS_FILE, 'utf8'));
let booksById = new Map(books.map((book) => [book.id, book]));
let store = loadStore();
let localUsers = loadLocalUsers();
let mutationQueue = Promise.resolve();
let catalogQueue = Promise.resolve();
let usersQueue = Promise.resolve();
const adminSessions = new Map();
const userSessions = new Map();
fs.mkdirSync(COVERS_DIR, { recursive: true });
let database;
let mongoClient;

function configured(key) {
  const value = process.env[key];
  return Boolean(value && !value.startsWith('your_') && !value.includes('example.mongodb.net') && !value.includes('your-domain.example') && !value.includes('your-project.supabase.co'));
}
const cloudStorageEnabled = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_STORAGE_BUCKET'].every(configured);
const firebaseConfigured = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_API_KEY', 'FIREBASE_AUTH_DOMAIN'].every(configured);
let firebaseAuth;
if (firebaseConfigured) {
  const firebaseApp = getApps()[0] || initializeApp({ credential: cert({ projectId: process.env.FIREBASE_PROJECT_ID, clientEmail: process.env.FIREBASE_CLIENT_EMAIL, privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') }) });
  firebaseAuth = getAuth(firebaseApp);
}

function supabaseHeaders(extra = {}) {
  return { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, ...extra };
}

function storageUrl(pathname) {
  return `${new URL(process.env.SUPABASE_URL).origin}/storage/v1${pathname}`;
}

async function storageRequest(pathname, options = {}) {
  const response = await fetch(storageUrl(pathname), { ...options, headers: supabaseHeaders(options.headers) });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.message || body.error || `Storage request failed (${response.status})`);
    error.status = response.status === 404 ? 404 : 502;
    throw error;
  }
  return response;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 2 },
  fileFilter(req, file, done) {
    const allowed = file.fieldname === 'ebook'
      ? file.mimetype === 'application/pdf'
      : file.fieldname === 'cover' && ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    done(allowed ? null : Object.assign(new Error(`Invalid ${file.fieldname} file type`), { status: 400 }), allowed);
  }
}).fields([{ name: 'ebook', maxCount: 1 }, { name: 'cover', maxCount: 1 }]);

function loadStore() {
  try {
    const value = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return { orders: value.orders || [], purchases: value.purchases || [] };
  } catch (error) {
    throw new Error(`Unable to load purchase store: ${error.message}`);
  }
}

function loadLocalUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw new Error(`Unable to load local users: ${error.message}`); }
}

function saveLocalUsers(mutator) {
  const operation = usersQueue.then(async () => {
    const result = await mutator(localUsers);
    const temporary = `${USERS_FILE}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, JSON.stringify(localUsers, null, 2));
    await fs.promises.rename(temporary, USERS_FILE);
    return result;
  });
  usersQueue = operation.catch(() => {});
  return operation;
}

// Serializing mutations makes the one-time check and update atomic in this process.
function mutateStore(mutator) {
  const operation = mutationQueue.then(async () => {
    const result = await mutator(store);
    if (database) {
      await database.collection('store').replaceOne({ _id: 'primary' }, { _id: 'primary', ...store }, { upsert: true });
    } else {
      const temporary = `${STORE_FILE}.${process.pid}.tmp`;
      await fs.promises.writeFile(temporary, JSON.stringify(store, null, 2));
      await fs.promises.rename(temporary, STORE_FILE);
    }
    return result;
  });
  mutationQueue = operation.catch(() => {});
  return operation;
}

function saveCatalog(nextBooks) {
  const operation = catalogQueue.then(async () => {
    if (database) {
      const collection = database.collection('books');
      await collection.deleteMany({});
      if (nextBooks.length) await collection.insertMany(nextBooks.map((book) => ({ ...book })));
    } else {
      const temporary = `${BOOKS_FILE}.${process.pid}.tmp`;
      await fs.promises.writeFile(temporary, JSON.stringify(nextBooks, null, 2));
      await fs.promises.rename(temporary, BOOKS_FILE);
    }
    books = nextBooks;
    booksById = new Map(books.map((book) => [book.id, book]));
  });
  catalogQueue = operation.catch(() => {});
  return operation;
}

function sessionToken(req) {
  return (req.headers.cookie || '').split(';').map((item) => item.trim()).find((item) => item.startsWith('admin_session='))?.split('=')[1];
}

function cookieToken(req, name) {
  const item = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!item) return undefined;
  try { return decodeURIComponent(item.slice(name.length + 1)); } catch { return undefined; }
}

function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

async function userSession(req) {
  const token = cookieToken(req, 'user_session');
  if (!token) return null;
  const hash = tokenHash(token);
  if (database) {
    const session = await database.collection('user_sessions').findOne({ tokenHash: hash, expiresAt: { $gt: new Date() } });
    if (!session) return null;
    const user = await database.collection('users').findOne({ id: session.userId, activeSessionHash: hash });
    return user ? { id: user.id, name: user.name, email: user.email } : null;
  }
  const session = userSessions.get(hash);
  if (!session || session.expiresAt < Date.now()) { userSessions.delete(hash); return null; }
  const user = localUsers.find((item) => item.id === session.userId && item.activeSessionHash === hash);
  return user ? { id: user.id, name: user.name, email: user.email } : null;
}

async function requireUser(req, res, next) {
  try {
    req.user = await userSession(req);
    if (!req.user) return res.status(401).json({ error: 'Please sign in to continue' });
    next();
  } catch (error) { next(error); }
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error('Enter a valid email address'), { status: 400 });
  return email;
}

async function firebaseRequest(endpoint, body) {
  if (!firebaseConfigured) throw Object.assign(new Error('Firebase Authentication is not configured'), { status: 503 });
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/${endpoint}?key=${encodeURIComponent(process.env.FIREBASE_API_KEY)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = data.error?.message || '';
    const messages = { EMAIL_EXISTS: 'An account with this email already exists', INVALID_LOGIN_CREDENTIALS: 'Email or password is incorrect', EMAIL_NOT_FOUND: 'Email or password is incorrect', INVALID_PASSWORD: 'Email or password is incorrect', WEAK_PASSWORD: 'Password must be at least 6 characters', TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Try again later.' };
    throw Object.assign(new Error(messages[code] || 'Authentication request failed'), { status: code === 'EMAIL_EXISTS' ? 409 : code === 'TOO_MANY_ATTEMPTS_TRY_LATER' ? 429 : 400 });
  }
  return data;
}

async function saveUserProfile(identity) {
  const user = { id: identity.uid, name: identity.name || identity.email.split('@')[0], email: identity.email, provider: identity.provider || 'password', updatedAt: new Date() };
  if (database) await database.collection('users').updateOne({ id: user.id }, { $set: user, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
  else await saveLocalUsers((users) => { const existing = users.find((item) => item.id === user.id); if (existing) Object.assign(existing, user); else users.push({ ...user, createdAt: new Date().toISOString() }); });
  return user;
}

async function startUserSession(identity, res) {
  const user = await saveUserProfile(identity);
  const token = crypto.randomBytes(32).toString('hex');
  const hash = tokenHash(token);
  const expiresAt = new Date(Date.now() + USER_SESSION_LIFETIME_MS);
  if (database) {
    await database.collection('user_sessions').deleteMany({ userId: user.id });
    await database.collection('user_sessions').insertOne({ userId: user.id, tokenHash: hash, expiresAt });
    await database.collection('users').updateOne({ id: user.id }, { $set: { activeSessionHash: hash, updatedAt: new Date() } });
  } else {
    for (const [key, session] of userSessions) if (session.userId === user.id) userSessions.delete(key);
    userSessions.set(hash, { userId: user.id, expiresAt: expiresAt.getTime() });
    await saveLocalUsers((users) => { const saved = users.find((item) => item.id === user.id); saved.activeSessionHash = hash; });
  }
  res.setHeader('Set-Cookie', `user_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${USER_SESSION_LIFETIME_MS / 1000}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  return { id: user.id, name: user.name, email: user.email };
}

async function adminSession(req) {
  const token = sessionToken(req);
  if (!token) return false;
  if (database) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    return Boolean(await database.collection('admin_sessions').findOne({ tokenHash, expiresAt: { $gt: new Date() } }));
  }
  const expires = token && adminSessions.get(token);
  if (!expires || expires < Date.now()) { if (token) adminSessions.delete(token); return false; }
  return true;
}

async function requireAdmin(req, res, next) {
  try {
    if (!await adminSession(req)) return res.status(401).json({ error: 'Admin sign-in required' });
    next();
  } catch (error) { next(error); }
}

function cleanText(value, name, max, required = true) {
  const text = String(value || '').trim();
  if ((required && !text) || text.length > max) throw Object.assign(new Error(`${name} is invalid`), { status: 400 });
  return text;
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

async function moveUpload(file, directory, extension) {
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${extension}`;
  await fs.promises.writeFile(path.join(directory, filename), file.buffer);
  return filename;
}

async function discardUploads(files) {
  // Uploads use memory storage, so there are no temporary files to remove.
}

function validateFileSignatures(files) {
  const ebook = files?.ebook?.[0];
  const cover = files?.cover?.[0];
  if (ebook && ebook.buffer.subarray(0, 5).toString('ascii') !== '%PDF-') throw Object.assign(new Error('The ebook is not a valid PDF file'), { status: 400 });
  if (cover) {
    const b = cover.buffer;
    const jpeg = b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    const png = b.length > 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const webp = b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP';
    if (!jpeg && !png && !webp) throw Object.assign(new Error('The cover is not a valid JPG, PNG, or WebP image'), { status: 400 });
  }
}

async function addBook(book) {
  if (database) await database.collection('books').insertOne({ ...book });
  else await saveCatalog([...books, book]);
  if (database) { books.push(book); booksById.set(book.id, book); }
}

async function updateBook(book) {
  if (database) await database.collection('books').replaceOne({ id: book.id }, { ...book });
  else await saveCatalog(books.map((item) => item.id === book.id ? book : item));
  if (database) { books = books.map((item) => item.id === book.id ? book : item); booksById.set(book.id, book); }
}

async function removeBook(book) {
  if (database) await database.collection('books').deleteOne({ id: book.id });
  else await saveCatalog(books.filter((item) => item.id !== book.id));
  if (database) { books = books.filter((item) => item.id !== book.id); booksById.delete(book.id); }
}

async function storeEbook(file) {
  if (!cloudStorageEnabled) return moveUpload(file, PRIVATE_BOOKS, '.pdf');
  const key = `ebooks/${Date.now()}-${crypto.randomBytes(8).toString('hex')}.pdf`;
  await storageRequest(`/object/${encodeURIComponent(process.env.SUPABASE_STORAGE_BUCKET)}/${key}`, { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'x-upsert': 'false' }, body: file.buffer });
  return key;
}

async function storeCover(file) {
  const extensions = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
  if (!cloudStorageEnabled) return { cover: `/covers/${await moveUpload(file, COVERS_DIR, extensions[file.mimetype])}` };
  const key = `covers/${Date.now()}-${crypto.randomBytes(8).toString('hex')}${extensions[file.mimetype]}`;
  await storageRequest(`/object/${encodeURIComponent(process.env.SUPABASE_STORAGE_BUCKET)}/${key}`, { method: 'POST', headers: { 'Content-Type': file.mimetype, 'Cache-Control': '31536000', 'x-upsert': 'false' }, body: file.buffer });
  return { cover: `/api/covers/${path.basename(key)}`, coverKey: key };
}

async function deleteStoredFile(key) {
  if (!key) return;
  if (cloudStorageEnabled && (key.startsWith('ebooks/') || key.startsWith('covers/'))) {
    await storageRequest(`/object/${encodeURIComponent(process.env.SUPABASE_STORAGE_BUCKET)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [key] }) });
  }
}

async function deleteEbookLocation(filename) {
  if (!filename) return;
  if (filename.startsWith('ebooks/')) return deleteStoredFile(filename);
  if (!filename.includes('/')) await fs.promises.unlink(path.join(PRIVATE_BOOKS, filename)).catch(() => {});
}

async function deleteCoverLocation(cover, coverKey) {
  if (coverKey) return deleteStoredFile(coverKey);
  if (cover?.startsWith('/covers/')) await fs.promises.unlink(path.join(COVERS_DIR, path.basename(cover))).catch(() => {});
}

async function connectDatabase() {
  if (!configured('MONGODB_URI')) return;
  mongoClient = new MongoClient(process.env.MONGODB_URI);
  await mongoClient.connect();
  database = mongoClient.db(process.env.MONGODB_DB || 'ebook_store');
  const cloudBooks = await database.collection('books').find({}).project({ _id: 0 }).toArray();
  if (cloudBooks.length) books = cloudBooks;
  else if (books.length) await database.collection('books').insertMany(books);
  const legacyStore = await database.collection('store').findOne({ _id: 'primary' });
  const existingOrders = await database.collection('orders').estimatedDocumentCount();
  const existingPurchases = await database.collection('purchases').estimatedDocumentCount();
  const ordersToMigrate = legacyStore?.orders || store.orders;
  const purchasesToMigrate = legacyStore?.purchases || store.purchases;
  if (!existingOrders && ordersToMigrate.length) await database.collection('orders').insertMany(ordersToMigrate);
  if (!existingPurchases && purchasesToMigrate.length) await database.collection('purchases').insertMany(purchasesToMigrate.map((item) => ({ ...item, expiresAt: new Date(item.expiresAt), createdAt: new Date(item.createdAt), ...(item.usedAt ? { usedAt: new Date(item.usedAt) } : {}) })));
  booksById = new Map(books.map((book) => [book.id, book]));
  await database.collection('books').createIndex({ id: 1 }, { unique: true });
  await database.collection('orders').createIndex({ orderId: 1 }, { unique: true });
  await database.collection('purchases').createIndex({ token: 1 }, { unique: true });
  await database.collection('purchases').createIndex({ paymentId: 1 }, { unique: true });
  await database.collection('purchases').createIndex({ orderId: 1 }, { unique: true });
  await database.collection('admin_sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await database.collection('users').createIndex({ email: 1 }, { unique: true });
  await database.collection('users').createIndex({ id: 1 }, { unique: true });
  await database.collection('user_sessions').createIndex({ tokenHash: 1 }, { unique: true });
  await database.collection('user_sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await database.collection('purchases').createIndex({ userId: 1, createdAt: -1 });
  await database.collection('rate_limits').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  console.log('Catalog and purchases connected to MongoDB Atlas');
}

function publicBook(book) {
  return {
    id: book.id,
    title: book.title,
    description: book.description,
    price: book.price,
    cover: book.cover,
    features: book.features,
    author: book.author || 'ReadVault',
    category: book.category || 'General'
  };
}

function siteUrl() {
  const renderUrl = process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : '';
  return (process.env.SITE_URL || renderUrl || `http://localhost:${PORT}`).replace(/\/$/, '');
}

function escapeMarkup(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function safeEqualHex(received, expected) {
  if (typeof received !== 'string' || !/^[a-f0-9]{64}$/i.test(received)) return false;
  const a = Buffer.from(received, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function razorpayCredentials() {
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret || key_id === 'your_key_id' || key_secret === 'your_key_secret') {
    const error = new Error('Payment service is not configured');
    error.status = 503;
    throw error;
  }
  return { key_id, key_secret };
}

async function razorpayRequest(pathname, options = {}) {
  const { key_id, key_secret } = razorpayCredentials();
  const response = await fetch(`https://api.razorpay.com/v1${pathname}`, {
    ...options,
    headers: { Authorization: `Basic ${Buffer.from(`${key_id}:${key_secret}`).toString('base64')}`, 'Content-Type': 'application/json', ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error?.description || 'Payment service request failed');
    error.status = response.status >= 500 ? 502 : 400;
    throw error;
  }
  return body;
}

async function tokenState(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return { error: 'Invalid download token', status: 403 };
  const purchase = database ? await database.collection('purchases').findOne({ token }) : store.purchases.find((item) => item.token === token);
  if (!purchase || !purchase.paymentVerified) return { error: 'Download token not found', status: 403 };
  if (purchase.used) return { error: 'This download token has already been used', status: 410 };
  if (purchase.state === 'claiming') {
    if (purchase.claimExpiresAt && Date.now() >= new Date(purchase.claimExpiresAt).getTime()) {
      await setPurchaseState(token, 'claiming', 'ready');
      purchase.state = 'ready';
    } else return { error: 'This download is already in progress', status: 409 };
  }
  if (Date.now() >= new Date(purchase.expiresAt).getTime()) return { error: 'This download token has expired', status: 410 };
  const book = booksById.get(purchase.bookId);
  if (!book) return { error: 'Book is unavailable', status: 403 };
  return { purchase, book };
}

async function saveOrder(order) {
  if (database) return database.collection('orders').insertOne(order);
  return mutateStore((data) => { data.orders.push(order); });
}

async function findOrder(orderId) {
  return database ? database.collection('orders').findOne({ orderId }) : store.orders.find((item) => item.orderId === orderId);
}

async function createPurchase(purchase) {
  if (database) {
    try { await database.collection('purchases').insertOne(purchase); return true; }
    catch (error) { if (error.code === 11000) return false; throw error; }
  }
  return mutateStore((data) => {
    if (data.purchases.some((item) => item.paymentId === purchase.paymentId || item.orderId === purchase.orderId)) return false;
    data.purchases.push(purchase); return true;
  });
}

async function setPurchaseState(token, from, to) {
  if (database) {
    const update = to === 'used' ? { state: to, used: true, usedAt: new Date() } : { state: to, used: false };
    if (to === 'claiming') update.claimExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const stateFilter = from === 'ready' ? { $or: [{ state: 'ready' }, { state: { $exists: false }, used: false }] } : { state: from };
    const operation = { $set: update };
    if (to !== 'claiming') operation.$unset = { claimExpiresAt: '' };
    const result = await database.collection('purchases').updateOne({ token, ...stateFilter }, operation);
    return result.modifiedCount === 1;
  }
  return mutateStore((data) => {
    const purchase = data.purchases.find((item) => item.token === token && (item.state || (item.used ? 'used' : 'ready')) === from);
    if (!purchase) return false;
    purchase.state = to; purchase.used = to === 'used';
    if (to === 'claiming') purchase.claimExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    else delete purchase.claimExpiresAt;
    if (to === 'used') purchase.usedAt = new Date().toISOString();
    return true;
  });
}

app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-ID', req.id);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://*.razorpay.com https://www.gstatic.com https://apis.google.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: https:; frame-src https://*.razorpay.com https://accounts.google.com https://*.firebaseapp.com; connect-src 'self' https://*.razorpay.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://accounts.google.com");
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.json({ limit: '20kb' }));
const localApiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });
app.use('/api', async (req, res, next) => {
  if (!database) return localApiLimiter(req, res, next);
  try {
    const windowMs = 15 * 60 * 1000;
    const bucket = Math.floor(Date.now() / windowMs);
    const key = crypto.createHash('sha256').update(`${req.ip}:${bucket}`).digest('hex');
    const result = await database.collection('rate_limits').findOneAndUpdate(
      { _id: key },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((bucket + 1) * windowMs) } },
      { upsert: true, returnDocument: 'after' }
    );
    res.setHeader('RateLimit-Limit', '120');
    res.setHeader('RateLimit-Remaining', String(Math.max(0, 120 - result.count)));
    if (result.count > 120) return res.status(429).json({ error: 'Too many requests, please try again later' });
    next();
  } catch (error) { next(error); }
});
app.get('/book.html', (req, res, next) => {
  if (!req.query.id) return next();
  res.redirect(301, `/books/${encodeURIComponent(req.query.id)}`);
});
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'], index: 'index.html' }));

app.get('/healthz', async (req, res) => {
  try {
    if (database) await database.command({ ping: 1 });
    res.json({ status: 'ok', database: database ? 'connected' : 'local', storage: cloudStorageEnabled ? 'supabase' : 'local' });
  } catch { res.status(503).json({ status: 'unhealthy' }); }
});

const passwordLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many login attempts. Try again in 15 minutes.' } });
const accountActionLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many email requests. Try again later.' } });

app.get('/api/auth/firebase-config', (req, res) => res.json(firebaseConfigured ? { apiKey: process.env.FIREBASE_API_KEY, authDomain: process.env.FIREBASE_AUTH_DOMAIN, projectId: process.env.FIREBASE_PROJECT_ID, appId: process.env.FIREBASE_APP_ID || undefined } : null));

app.post('/api/auth/register', accountActionLimiter, async (req, res, next) => {
  try {
    const name = cleanText(req.body?.name, 'Name', 80), email = normalizeEmail(req.body?.email), password = String(req.body?.password || '');
    if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Password must be 8 to 128 characters' });
    const signup = await firebaseRequest('accounts:signUp', { email, password, returnSecureToken: true });
    await firebaseAuth.updateUser(signup.localId, { displayName: name });
    await firebaseRequest('accounts:sendOobCode', { requestType: 'VERIFY_EMAIL', idToken: signup.idToken });
    res.status(201).json({ success: true, message: 'Account created. Check your email and verify it before signing in.' });
  } catch (error) { next(error); }
});

app.post('/api/auth/login', passwordLoginLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email), password = String(req.body?.password || '');
    const login = await firebaseRequest('accounts:signInWithPassword', { email, password, returnSecureToken: true });
    const record = await firebaseAuth.getUser(login.localId);
    if (!record.emailVerified) return res.status(403).json({ error: 'Verify your email before signing in. Use “Resend verification” if needed.' });
    const user = await startUserSession({ uid: record.uid, name: record.displayName, email: record.email, provider: 'password' }, res);
    res.json({ user });
  } catch (error) { next(error); }
});

app.post('/api/auth/google', passwordLoginLimiter, async (req, res, next) => {
  try {
    const idToken = String(req.body?.idToken || '');
    if (!firebaseAuth || idToken.length < 100 || idToken.length > 10000) return res.status(400).json({ error: 'Invalid Google sign-in response' });
    const decoded = await firebaseAuth.verifyIdToken(idToken, true);
    if (!decoded.email || !decoded.email_verified) return res.status(403).json({ error: 'Google account email is not verified' });
    const user = await startUserSession({ uid: decoded.uid, name: decoded.name, email: decoded.email, provider: 'google' }, res);
    res.json({ user });
  } catch (error) { next(Object.assign(new Error('Google sign-in could not be verified'), { status: 401 })); }
});

app.post('/api/auth/resend-verification', accountActionLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email), password = String(req.body?.password || '');
    const login = await firebaseRequest('accounts:signInWithPassword', { email, password, returnSecureToken: true });
    await firebaseRequest('accounts:sendOobCode', { requestType: 'VERIFY_EMAIL', idToken: login.idToken });
    res.json({ success: true, message: 'Verification email sent.' });
  } catch (error) { next(error); }
});

app.post('/api/auth/reset-password', accountActionLimiter, async (req, res, next) => {
  try { await firebaseRequest('accounts:sendOobCode', { requestType: 'PASSWORD_RESET', email: normalizeEmail(req.body?.email) }); }
  catch (error) { if (error.status === 503) return next(error); if (error.message !== 'Email or password is incorrect') console.error('Password reset request failed:', error.message); }
  res.json({ success: true, message: 'If an account exists for that email, Firebase sent a password-reset link.' });
});

app.get('/api/auth/me', async (req, res, next) => {
  try { res.json({ user: await userSession(req) }); } catch (error) { next(error); }
});

app.post('/api/auth/logout', async (req, res, next) => {
  try {
    const token = cookieToken(req, 'user_session');
    const hash = token && tokenHash(token);
    if (hash && database) {
      const session = await database.collection('user_sessions').findOne({ tokenHash: hash });
      await database.collection('user_sessions').deleteOne({ tokenHash: hash });
      if (session) await database.collection('users').updateOne({ id: session.userId, activeSessionHash: hash }, { $unset: { activeSessionHash: '' } });
    } else if (hash) userSessions.delete(hash);
    res.setHeader('Set-Cookie', 'user_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ success: true });
  } catch (error) { next(error); }
});

app.get('/api/library', requireUser, async (req, res, next) => {
  try {
    const purchases = database
      ? await database.collection('purchases').find({ userId: req.user.id, paymentVerified: true }).sort({ createdAt: -1 }).toArray()
      : store.purchases.filter((item) => item.userId === req.user.id && item.paymentVerified).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const seen = new Set();
    const library = purchases.flatMap((purchase) => {
      if (seen.has(purchase.bookId)) return [];
      seen.add(purchase.bookId);
      const book = booksById.get(purchase.bookId);
      return book ? [{ ...publicBook(book), purchasedAt: purchase.createdAt }] : [];
    });
    res.json({ user: req.user, books: library });
  } catch (error) { next(error); }
});

app.post('/api/admin/login', async (req, res, next) => {
  try {
  const configured = process.env.ADMIN_PASSWORD;
  if (!configured) return res.status(503).json({ error: 'Set ADMIN_PASSWORD in .env before using the admin panel' });
  const received = String(req.body?.password || '');
  const a = Buffer.from(received), b = Buffer.from(configured);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Incorrect password' });
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
  if (database) await database.collection('admin_sessions').insertOne({ tokenHash: crypto.createHash('sha256').update(token).digest('hex'), expiresAt });
  else adminSessions.set(token, expiresAt.getTime());
  res.setHeader('Set-Cookie', `admin_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  res.json({ success: true });
  } catch (error) { next(error); }
});

app.post('/api/admin/logout', requireAdmin, async (req, res, next) => {
  try {
  const token = sessionToken(req);
  if (token && database) await database.collection('admin_sessions').deleteOne({ tokenHash: crypto.createHash('sha256').update(token).digest('hex') });
  else if (token) adminSessions.delete(token);
  res.setHeader('Set-Cookie', 'admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ success: true });
  } catch (error) { next(error); }
});

app.get('/api/admin/books', requireAdmin, (req, res) => res.json(books));

app.post('/api/admin/books', requireAdmin, (req, res, next) => upload(req, res, async (uploadError) => {
  if (uploadError) return next(uploadError);
  let uploadedEbook, uploadedCover, uploadedCoverKey;
  try {
    validateFileSignatures(req.files);
    const title = cleanText(req.body.title, 'Title', 120);
    const description = cleanText(req.body.description, 'Description', 1200);
    const price = Number(req.body.price);
    if (!Number.isFinite(price) || price < 0 || price > 100000) throw Object.assign(new Error('Price is invalid'), { status: 400 });
    if (!req.files?.ebook?.[0]) throw Object.assign(new Error('A PDF ebook is required'), { status: 400 });
    let id = slug(req.body.id || title) || crypto.randomBytes(5).toString('hex');
    if (booksById.has(id)) id = `${id}-${crypto.randomBytes(3).toString('hex')}`;
    const filename = await storeEbook(req.files.ebook[0]);
    uploadedEbook = filename;
    let cover = 'linear-gradient(135deg, #6d4aff, #2563eb)';
    let coverKey;
    if (req.files?.cover?.[0]) {
      const stored = await storeCover(req.files.cover[0]);
      cover = stored.cover;
      coverKey = stored.coverKey;
      uploadedCover = cover;
      uploadedCoverKey = coverKey;
    }
    const features = String(req.body.features || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 10);
    const author = cleanText(req.body.author, 'Author', 120);
    const category = cleanText(req.body.category, 'Category', 80);
    const book = { id, title, author, category, description, price: Math.round(price * 100) / 100, cover, filename, features, ...(coverKey ? { coverKey } : {}) };
    await addBook(book);
    res.status(201).json(book);
  } catch (error) {
    await Promise.all([deleteEbookLocation(uploadedEbook), deleteCoverLocation(uploadedCover, uploadedCoverKey)]).catch(console.error);
    next(error);
  }
}));

app.put('/api/admin/books/:id', requireAdmin, (req, res, next) => upload(req, res, async (uploadError) => {
  if (uploadError) return next(uploadError);
  let replacementEbook, replacementCover, replacementCoverKey;
  try {
    validateFileSignatures(req.files);
    const current = booksById.get(req.params.id);
    if (!current) throw Object.assign(new Error('Book not found'), { status: 404 });
    const price = Number(req.body.price);
    if (!Number.isFinite(price) || price < 0 || price > 100000) throw Object.assign(new Error('Price is invalid'), { status: 400 });
    const updated = { ...current, title: cleanText(req.body.title, 'Title', 120), author: cleanText(req.body.author, 'Author', 120), category: cleanText(req.body.category, 'Category', 80), description: cleanText(req.body.description, 'Description', 1200), price: Math.round(price * 100) / 100, features: String(req.body.features || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 10) };
    const previousFilename = current.filename;
    const previousCoverKey = current.coverKey;
    if (req.files?.ebook?.[0]) { updated.filename = await storeEbook(req.files.ebook[0]); replacementEbook = updated.filename; }
    if (req.files?.cover?.[0]) {
      const stored = await storeCover(req.files.cover[0]);
      updated.cover = stored.cover;
      replacementCover = stored.cover;
      replacementCoverKey = stored.coverKey;
      if (stored.coverKey) updated.coverKey = stored.coverKey; else delete updated.coverKey;
    }
    await updateBook(updated);
    if (req.files?.ebook?.[0]) {
      await deleteEbookLocation(previousFilename).catch(console.error);
    }
    if (req.files?.cover?.[0]) {
      await deleteCoverLocation(current.cover, previousCoverKey).catch(console.error);
    }
    res.json(updated);
  } catch (error) {
    await Promise.all([deleteEbookLocation(replacementEbook), deleteCoverLocation(replacementCover, replacementCoverKey)]).catch(console.error);
    next(error);
  }
}));

app.delete('/api/admin/books/:id', requireAdmin, async (req, res, next) => {
  try {
    const book = booksById.get(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });
    await removeBook(book);
    await deleteEbookLocation(book.filename).catch(console.error);
    await deleteCoverLocation(book.cover, book.coverKey).catch(console.error);
    res.json({ success: true });
  } catch (error) { next(error); }
});

app.get('/api/books', (req, res) => res.json(books.map(publicBook)));

app.get('/api/covers/:filename', async (req, res, next) => {
  try {
    if (!cloudStorageEnabled || !/^[a-zA-Z0-9._-]+$/.test(req.params.filename)) return res.status(404).end();
    const object = await storageRequest(`/object/authenticated/${encodeURIComponent(process.env.SUPABASE_STORAGE_BUCKET)}/covers/${encodeURIComponent(req.params.filename)}`);
    res.setHeader('Content-Type', object.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (object.headers.get('content-length')) res.setHeader('Content-Length', object.headers.get('content-length'));
    Readable.fromWeb(object.body).pipe(res);
  } catch (error) {
    if (error.status === 404) return res.status(404).end();
    next(error);
  }
});

app.get('/api/books/:id', (req, res) => {
  const book = booksById.get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });
  res.json(publicBook(book));
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/admin\nSitemap: ${siteUrl()}/sitemap.xml\n`);
});

app.get('/sitemap.xml', (req, res) => {
  const urls = [`<url><loc>${escapeMarkup(siteUrl())}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>`, ...books.map((book) => `<url><loc>${escapeMarkup(siteUrl())}/books/${encodeURIComponent(book.id)}</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>`)];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`);
});

app.get('/books/:id', (req, res, next) => {
  try {
    const book = booksById.get(req.params.id);
    if (!book) return res.status(404).send('Book not found');
    const canonical = `${siteUrl()}/books/${encodeURIComponent(book.id)}`;
    const cover = /^(https?:\/\/)/.test(book.cover) ? book.cover : `${siteUrl()}${book.cover.startsWith('/') ? '' : '/'}${book.cover}`;
    const author = book.author || 'ReadVault';
    const category = book.category || 'General';
    const schema = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Book', name: book.title, author: { '@type': 'Person', name: author }, genre: category, description: book.description, image: cover, offers: { '@type': 'Offer', priceCurrency: 'INR', price: book.price, availability: 'https://schema.org/InStock', url: canonical } }).replace(/</g, '\\u003c');
    const metadata = `<meta name="description" content="${escapeMarkup(book.description)}"><meta name="author" content="${escapeMarkup(author)}"><link rel="canonical" href="${escapeMarkup(canonical)}"><meta property="og:type" content="book"><meta property="og:title" content="${escapeMarkup(book.title)}"><meta property="og:description" content="${escapeMarkup(book.description)}"><meta property="og:url" content="${escapeMarkup(canonical)}"><meta property="og:image" content="${escapeMarkup(cover)}"><meta property="book:author" content="${escapeMarkup(author)}"><meta name="twitter:card" content="summary_large_image"><script type="application/ld+json">${schema}</script>`;
    const template = fs.readFileSync(path.join(ROOT, 'public', 'book.html'), 'utf8');
    res.type('html').send(template.replace('<title>Book details — ReadVault</title>', `<title>${escapeMarkup(book.title)} — ReadVault</title>${metadata}`));
  } catch (error) { next(error); }
});

app.post('/api/create-order', requireUser, async (req, res, next) => {
  try {
    const book = booksById.get(req.body?.bookId);
    if (!book) return res.status(400).json({ error: 'Invalid book ID' });
    const owned = database
      ? await database.collection('purchases').findOne({ userId: req.user.id, bookId: book.id, paymentVerified: true })
      : store.purchases.find((item) => item.userId === req.user.id && item.bookId === book.id && item.paymentVerified);
    if (owned) return res.status(409).json({ error: 'You already own this ebook. Download it from My Library.' });
    const amount = Math.round(book.price * 100);
    const order = await razorpayRequest('/orders', { method: 'POST', body: {
      amount,
      currency: 'INR',
      receipt: `book_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      notes: { bookId: book.id, userId: req.user.id }
    } });
    await saveOrder({ orderId: order.id, bookId: book.id, userId: req.user.id, amount, currency: 'INR', createdAt: new Date() });
    res.json({ orderId: order.id, amount, currency: 'INR', keyId: process.env.RAZORPAY_KEY_ID });
  } catch (error) { next(error); }
});

app.post('/api/verify-payment', requireUser, async (req, res, next) => {
  try {
    const { bookId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    const book = booksById.get(bookId);
    if (!book || ![razorpay_order_id, razorpay_payment_id, razorpay_signature].every((v) => typeof v === 'string' && v.length <= 200)) {
      return res.status(400).json({ error: 'Invalid payment details' });
    }
    const secret = process.env.RAZORPAY_KEY_SECRET;
    razorpayCredentials();
    const expected = crypto.createHmac('sha256', secret).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    if (!safeEqualHex(razorpay_signature, expected)) return res.status(400).json({ error: 'Payment verification failed' });

    const localOrder = await findOrder(razorpay_order_id);
    const expectedAmount = Math.round(book.price * 100);
    if (!localOrder || localOrder.bookId !== bookId || localOrder.userId !== req.user.id || localOrder.amount !== expectedAmount) {
      return res.status(400).json({ error: 'Order does not match this book' });
    }

    // Fetch from Razorpay so a valid signature alone is not treated as proof of amount/status.
    const payment = await razorpayRequest(`/payments/${encodeURIComponent(razorpay_payment_id)}`);
    if (payment.order_id !== razorpay_order_id || Number(payment.amount) !== expectedAmount || payment.currency !== 'INR' || !['authorized', 'captured'].includes(payment.status)) {
      return res.status(400).json({ error: 'Payment amount or status is invalid' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const createdAt = new Date();
    const created = await createPurchase({ token, bookId, userId: req.user.id, paymentId: razorpay_payment_id, orderId: razorpay_order_id, createdAt, expiresAt: new Date(createdAt.getTime() + TOKEN_LIFETIME_MS), state: 'ready', used: false, paymentVerified: true });
    if (!created) return res.status(409).json({ error: 'This payment has already been verified' });
    res.json({ success: true, downloadToken: token });
  } catch (error) { next(error); }
});

app.get('/api/download-status', async (req, res, next) => {
  const state = await tokenState(req.query.token).catch(next);
  if (!state) return;
  if (state.error) return res.status(state.status).json({ valid: false, error: state.error });
  res.json({ valid: true, bookTitle: state.book.title });
});

app.post('/api/download', async (req, res, next) => {
  try {
    const token = req.query.token;
    const state = await tokenState(token);
    if (state.error) return res.status(state.status).json({ error: state.error });

    let source;
    let object;
    if (cloudStorageEnabled && state.book.filename.startsWith('ebooks/')) {
      object = await storageRequest(`/object/authenticated/${encodeURIComponent(process.env.SUPABASE_STORAGE_BUCKET)}/${state.book.filename}`);
      source = Readable.fromWeb(object.body);
    } else {
      const filePath = path.resolve(PRIVATE_BOOKS, state.book.filename);
      if (path.dirname(filePath) !== path.resolve(PRIVATE_BOOKS)) return res.status(403).json({ error: 'Book is unavailable' });
      await fs.promises.access(filePath, fs.constants.R_OK);
      source = fs.createReadStream(filePath);
    }

    if (!await setPurchaseState(token, 'ready', 'claiming')) {
      source.destroy();
      return res.status(409).json({ error: 'This download is already in progress or has been used' });
    }
    let settled = false;
    res.once('finish', () => { settled = true; setPurchaseState(token, 'claiming', 'used').catch(console.error); });
    res.once('close', () => { if (!settled) setPurchaseState(token, 'claiming', 'ready').catch(console.error); });
    source.once('error', (error) => {
      setPurchaseState(token, 'claiming', 'ready').catch(console.error);
      if (!res.headersSent) next(error); else res.destroy(error);
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${state.book.id}.pdf"`);
    if (object?.headers.get('content-length')) res.setHeader('Content-Length', object.headers.get('content-length'));
    source.pipe(res);
  } catch (error) { next(error); }
});

app.get('/api/library/:bookId/download', requireUser, async (req, res, next) => {
  try {
    const book = booksById.get(req.params.bookId);
    if (!book) return res.status(404).json({ error: 'Book not found' });
    const purchase = database
      ? await database.collection('purchases').findOne({ userId: req.user.id, bookId: book.id, paymentVerified: true })
      : store.purchases.find((item) => item.userId === req.user.id && item.bookId === book.id && item.paymentVerified);
    if (!purchase) return res.status(403).json({ error: 'This ebook is not in your library' });
    if (cloudStorageEnabled && book.filename.startsWith('ebooks/')) {
      const object = await storageRequest(`/object/authenticated/${encodeURIComponent(process.env.SUPABASE_STORAGE_BUCKET)}/${book.filename}`);
      res.setHeader('Content-Type', 'application/pdf');
      if (object.headers.get('content-length')) res.setHeader('Content-Length', object.headers.get('content-length'));
      res.setHeader('Content-Disposition', `attachment; filename="${book.id}.pdf"`);
      return Readable.fromWeb(object.body).pipe(res);
    }
    const filePath = path.resolve(PRIVATE_BOOKS, book.filename);
    if (path.dirname(filePath) !== path.resolve(PRIVATE_BOOKS)) return res.status(403).json({ error: 'Book is unavailable' });
    res.download(filePath, `${book.id}.pdf`);
  } catch (error) { next(error); }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found' }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status || (error.code === 'LIMIT_FILE_SIZE' ? 413 : error.code?.startsWith('LIMIT_') ? 400 : error.code === 'ENOENT' ? 404 : 500);
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', requestId: req.id, method: req.method, path: req.path, status, message: error.message, ...(process.env.NODE_ENV !== 'production' ? { stack: error.stack } : {}) }));
  res.status(status).json({ error: status >= 500 ? 'Unable to complete the request' : error.message });
});

function validateProductionConfig() {
  if (process.env.NODE_ENV !== 'production') return;
  const required = ['ADMIN_PASSWORD', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'MONGODB_URI', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_STORAGE_BUCKET', 'FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_API_KEY', 'FIREBASE_AUTH_DOMAIN'];
  const missing = required.filter((key) => !configured(key));
  if (missing.length) throw new Error(`Missing required production configuration: ${missing.join(', ')}`);
  if (process.env.ADMIN_PASSWORD.length < 16) throw new Error('ADMIN_PASSWORD must contain at least 16 characters in production');
  if (!/^https:\/\//.test(siteUrl())) throw new Error('SITE_URL must use HTTPS in production');
}

let httpServer;
validateProductionConfig();
connectDatabase().then(() => {
  httpServer = app.listen(PORT, () => {
  console.log(`Ebook store running at http://localhost:${PORT}`);
  console.log(`File storage: ${cloudStorageEnabled ? 'Supabase Storage' : 'local development folders'}`);
  });
}).catch((error) => {
  console.error('Startup failed:', error.message);
  process.exitCode = 1;
});

async function shutdown(signal) {
  console.log(`${signal} received; shutting down safely`);
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  if (mongoClient) await mongoClient.close();
  process.exit(0);
}
process.once('SIGTERM', () => shutdown('SIGTERM').catch(console.error));
process.once('SIGINT', () => shutdown('SIGINT').catch(console.error));
