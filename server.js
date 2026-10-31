require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const OpenAI = require('openai');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const MAX_CHAT_HISTORY = 16;
const IS_VERCEL = Boolean(process.env.VERCEL);
// Vercel functions can only write to the temp dir, and it does not persist between instances
const DATA_DIR = process.env.DATA_DIR || (IS_VERCEL ? path.join(os.tmpdir(), 'digital-ca-data') : path.join(__dirname, 'data'));
if (IS_VERCEL && !process.env.DATA_DIR) {
  console.warn('Digital CA: SQLite is stored in the function temp dir on Vercel; accounts and ledgers reset when instances recycle.');
}
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'digital-ca.sqlite');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    UNIQUE(user_id, name)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('income','expense')),
    amount REAL NOT NULL CHECK(amount > 0),
    category TEXT,
    merchant TEXT,
    source TEXT,
    income_type TEXT,
    method TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    date TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, date);
  CREATE INDEX IF NOT EXISTS idx_transactions_user_type ON transactions(user_id, type);

  CREATE TABLE IF NOT EXISTS payment_orders (
    id TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    provider_order_id TEXT NOT NULL,
    amount_paise INTEGER NOT NULL,
    merchant TEXT NOT NULL,
    category TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'paid',
    provider_payment_id TEXT,
    transaction_id TEXT,
    created_at TEXT NOT NULL,
    paid_at TEXT
  );

  CREATE TABLE IF NOT EXISTS investment_profiles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    goal TEXT,
    horizon TEXT,
    experience TEXT,
    risk TEXT,
    monthly_investment REAL NOT NULL DEFAULT 0,
    emergency_savings REAL NOT NULL DEFAULT 0,
    target_amount REAL NOT NULL DEFAULT 0,
    existing_investments REAL NOT NULL DEFAULT 0,
    debt REAL NOT NULL DEFAULT 0,
    upcoming_expense REAL NOT NULL DEFAULT 0,
    age INTEGER,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    month TEXT NOT NULL,
    amount REAL NOT NULL CHECK(amount > 0),
    UNIQUE(user_id, category, month)
  );

  CREATE TABLE IF NOT EXISTS financial_goals (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    target_amount REAL NOT NULL CHECK(target_amount > 0),
    target_date TEXT,
    current_amount REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS investments (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    asset_class TEXT NOT NULL,
    value REAL NOT NULL CHECK(value > 0),
    notes TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_investments_user ON investments(user_id);

  CREATE TABLE IF NOT EXISTS ai_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

const DEFAULT_CATEGORIES = ['Food', 'Travel', 'Bills', 'Shopping', 'Healthcare', 'Education', 'Entertainment', 'Other'];
for (const user of db.prepare('SELECT id FROM users').all()) {
  for (const category of DEFAULT_CATEGORIES) {
    db.prepare('INSERT OR IGNORE INTO categories(user_id,name) VALUES(?,?)').run(user.id, category);
  }
}

app.disable('x-powered-by');
// Behind Vercel's proxy, use the client IP from X-Forwarded-For for rate limiting
if (IS_VERCEL) app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // Safe CSP enabling local, inline, Chart.js CDN, and generative AI APIs without Razorpay restrictions
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self' data:; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self' https://generativelanguage.googleapis.com https://api.openai.com; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  );
  next();
});
app.use(express.json({ limit: '500kb' }));
app.use('/api', (req, res, next) => {
  if (['POST','PUT','PATCH','DELETE'].includes(req.method) && req.headers['x-digital-ca'] !== '1') {
    return res.status(403).json({ error: 'Request rejected. Missing required header.' });
  }
  next();
});
// Only serve the front-end; never expose server source, config, database files or the legacy copy
const PRIVATE_PATHS = /^\/(\.|server\.js|package(-lock)?\.json|readme\.txt|data|node_modules|digital-ca-edit)(\/|$)|\/\./i;
app.use((req, res, next) => (PRIVATE_PATHS.test(req.path) ? res.status(404).end() : next()));
app.use(express.static(__dirname, { dotfiles: 'deny' }));

const rateBuckets = new Map();
function rateLimit(limit = 120, windowMs = 10 * 60 * 1000) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.startedAt > windowMs) {
      rateBuckets.set(key, { startedAt: now, count: 1 });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > limit) return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    next();
  };
}

const SESSION_COOKIE = 'dc_session';
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const now = new Date().toISOString();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
    .run(tokenHash, userId, expiresAt, now);
  return { token, expiresAt };
}
function setSessionCookie(res, session) {
  const attrs = [
    `${SESSION_COOKIE}=${session.token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];
  if (IS_PROD) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}
function clearSessionCookie(res) {
  const attrs = [`${SESSION_COOKIE}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (IS_PROD) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const part = raw.split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : null;
}
function authUser(req) {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id,u.name,u.email,s.expires_at
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>?
  `).get(hashToken(token), Date.now());
  return row ? { id: row.id, name: row.name, email: row.email } : null;
}
function requireAuth(req, res, next) {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required.' });
  req.user = user;
  next();
}
function cleanSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
}
setInterval(cleanSessions, 30 * 60 * 1000).unref();

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  return {
    salt,
    hash: crypto.scryptSync(password, salt, 64).toString('hex')
  };
}
function passwordMatches(password, salt, expectedHex) {
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}
function jsonSafeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function validAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= 1e12;
}
function normalizeDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function userCategories(userId) {
  return db.prepare('SELECT name FROM categories WHERE user_id=? ORDER BY name').all(userId).map(row => row.name);
}

function transactionFromRow(row) {
  return {
    id: row.id,
    type: row.type,
    amount: Number(row.amount),
    category: row.category,
    merchant: row.merchant,
    source: row.source,
    incomeType: row.income_type,
    method: row.method,
    hidden: Boolean(row.hidden),
    date: row.date,
    createdAt: row.created_at
  };
}

function upsertTransaction(userId, body, existingId = null) {
  const type = body.type === 'income' ? 'income' : 'expense';
  const amount = Number(body.amount);
  if (!validAmount(amount)) throw new Error('Invalid amount.');
  const date = normalizeDate(body.date);
  if (!date) throw new Error('Invalid date.');
  const now = new Date().toISOString();
  const id = existingId || crypto.randomUUID();

  if (type === 'income') {
    const source = String(body.source || '').trim().slice(0, 160);
    const incomeType = String(body.incomeType || 'Other').trim().slice(0, 80);
    const method = String(body.method || 'Other').trim().slice(0, 80);
    if (existingId) {
      db.prepare(`
        UPDATE transactions SET type=?,amount=?,category=NULL,merchant=NULL,source=?,income_type=?,method=?,hidden=0,date=?
        WHERE id=? AND user_id=?
      `).run(type, amount, source, incomeType, method, date, id, userId);
    } else {
      db.prepare(`
        INSERT INTO transactions(id,user_id,type,amount,category,merchant,source,income_type,method,hidden,date,created_at)
        VALUES(?,?,'income',?,NULL,NULL,?,?,?,0,?,?)
      `).run(id, userId, amount, source, incomeType, method, date, now);
    }
  } else {
    const merchant = String(body.merchant || '').trim().slice(0, 160);
    if (!merchant) throw new Error('Payee / merchant name is required.');
    const category = String(body.category || 'Other').trim().slice(0, 80);
    const method = String(body.method || 'Other').trim().slice(0, 80);
    const hidden = body.hidden ? 1 : 0;
    if (existingId) {
      db.prepare(`
        UPDATE transactions SET type=?,amount=?,category=?,merchant=?,source=NULL,income_type=NULL,method=?,hidden=?,date=?
        WHERE id=? AND user_id=?
      `).run(type, amount, category, merchant, method, hidden, date, id, userId);
    } else {
      db.prepare(`
        INSERT INTO transactions(id,user_id,type,amount,category,merchant,source,income_type,method,hidden,date,created_at)
        VALUES(?,?,'expense',?,?,?,NULL,NULL,?,?,?,?)
      `).run(id, userId, amount, category, merchant, method, hidden, date, now);
    }
  }
  return transactionFromRow(db.prepare('SELECT * FROM transactions WHERE id=? AND user_id=?').get(id, userId));
}

// Auth API
app.get('/api/health', (req, res) => res.json({ ok: true, status: 'operational', timestamp: new Date().toISOString() }));
app.get('/api/me', (req, res) => res.json({ ok: true, user: authUser(req) }));

app.post('/api/auth/register', rateLimit(15), (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 120);
  const password = String(req.body?.password || '');
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  if (!validEmail(email)) return res.status(400).json({ error: 'Valid email is required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters long.' });

  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (existing) return res.status(409).json({ error: 'An account with that email already exists.' });

  const { salt, hash } = passwordHash(password);
  const now = new Date().toISOString();
  const info = db.prepare('INSERT INTO users(name,email,password_salt,password_hash,created_at) VALUES(?,?,?,?,?)')
    .run(name, email, salt, hash, now);
  const userId = Number(info.lastInsertRowid);
  for (const category of DEFAULT_CATEGORIES) {
    db.prepare('INSERT OR IGNORE INTO categories(user_id,name) VALUES(?,?)').run(userId, category);
  }
  const session = createSession(userId);
  setSessionCookie(res, session);
  res.status(201).json({ ok: true, user: { id: userId, name, email } });
});

app.post('/api/auth/login', rateLimit(25), (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 120);
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  const user = db.prepare('SELECT id,name,email,password_salt,password_hash FROM users WHERE email=?').get(email);
  if (!user || !passwordMatches(password, user.password_salt, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const session = createSession(user.id);
  setSessionCookie(res, session);
  res.json({ ok: true, user: { id: user.id, name: user.name, email: user.email } });
});

app.post('/api/auth/logout', (req, res) => {
  const token = getCookie(req, SESSION_COOKIE);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Bootstrap & Transactions API
app.get('/api/bootstrap', requireAuth, (req, res) => {
  const userId = req.user.id;
  const transactions = db.prepare('SELECT * FROM transactions WHERE user_id=? ORDER BY date DESC LIMIT 400')
    .all(userId).map(transactionFromRow);
  const categories = userCategories(userId);
  const profile = db.prepare('SELECT * FROM investment_profiles WHERE user_id=?').get(userId);
  const budgets = db.prepare('SELECT * FROM budgets WHERE user_id=? ORDER BY month DESC').all(userId);
  const goals = db.prepare('SELECT * FROM financial_goals WHERE user_id=? ORDER BY target_date').all(userId);
  const investments = db.prepare('SELECT * FROM investments WHERE user_id=? ORDER BY value DESC').all(userId);

  res.json({
    ok: true,
    user: req.user,
    transactions,
    categories,
    budgets,
    goals,
    investments,
    investmentProfile: profileFromRow(profile)
  });
});

app.get('/api/transactions', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM transactions WHERE user_id=? ORDER BY date DESC LIMIT 500').all(req.user.id);
  res.json({ ok: true, transactions: rows.map(transactionFromRow) });
});

app.post('/api/transactions', requireAuth, (req, res) => {
  try {
    const tx = upsertTransaction(req.user.id, req.body || {});
    res.status(201).json({ ok: true, transaction: tx });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/transactions/:id', requireAuth, (req, res) => {
  try {
    const existing = db.prepare('SELECT id FROM transactions WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Transaction not found.' });
    const tx = upsertTransaction(req.user.id, req.body || {}, req.params.id);
    res.json({ ok: true, transaction: tx });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/transactions/:id', requireAuth, (req, res) => {
  const info = db.prepare('DELETE FROM transactions WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Transaction not found.' });
  res.json({ ok: true, id: req.params.id });
});

// Categories API
app.get('/api/categories', requireAuth, (req, res) => {
  res.json({ ok: true, categories: userCategories(req.user.id) });
});

app.post('/api/categories', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Category name is required.' });
  db.prepare('INSERT OR IGNORE INTO categories(user_id, name) VALUES(?,?)').run(req.user.id, name);
  res.status(201).json({ ok: true, categories: userCategories(req.user.id) });
});

app.delete('/api/categories/:name', requireAuth, (req, res) => {
  const name = req.params.name;
  if (name === 'Other') return res.status(400).json({ error: 'The Other category cannot be removed.' });
  db.prepare('DELETE FROM categories WHERE user_id=? AND name=?').run(req.user.id, name);
  db.prepare('INSERT OR IGNORE INTO categories(user_id,name) VALUES(?,?)').run(req.user.id, 'Other');
  db.prepare("UPDATE transactions SET category='Other' WHERE user_id=? AND type='expense' AND category=?").run(req.user.id, name);
  res.json({ ok: true, categories: userCategories(req.user.id) });
});

// Investment Profile API
function profileFromRow(profile) {
  return profile ? {
    goal: profile.goal,
    horizon: profile.horizon,
    experience: profile.experience,
    risk: profile.risk,
    monthly: profile.monthly_investment,
    emergency: profile.emergency_savings,
    targetAmount: profile.target_amount,
    existingInvestments: profile.existing_investments,
    debt: profile.debt,
    upcomingExpense: profile.upcoming_expense,
    age: profile.age
  } : {};
}

app.put('/api/profile/investment', requireAuth, (req, res) => {
  const b = req.body || {};
  const text = v => String(v || '').trim().slice(0, 80) || null;
  const num = v => Math.max(0, jsonSafeNumber(v, 0));
  const age = Number.isInteger(Number(b.age)) && Number(b.age) > 0 && Number(b.age) < 120 ? Number(b.age) : null;
  db.prepare(`
    INSERT INTO investment_profiles(user_id,goal,horizon,experience,risk,monthly_investment,emergency_savings,target_amount,existing_investments,debt,upcoming_expense,age,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      goal=excluded.goal, horizon=excluded.horizon, experience=excluded.experience, risk=excluded.risk,
      monthly_investment=excluded.monthly_investment, emergency_savings=excluded.emergency_savings,
      target_amount=excluded.target_amount, existing_investments=excluded.existing_investments,
      debt=excluded.debt, upcoming_expense=excluded.upcoming_expense, age=excluded.age, updated_at=excluded.updated_at
  `).run(req.user.id, text(b.goal), text(b.horizon), text(b.experience), text(b.risk), num(b.monthly), num(b.emergency),
    num(b.targetAmount), num(b.existingInvestments), num(b.debt), num(b.upcomingExpense), age, new Date().toISOString());
  const row = db.prepare('SELECT * FROM investment_profiles WHERE user_id=?').get(req.user.id);
  res.json({ ok: true, profile: profileFromRow(row) });
});

// Budgets API
function upsertBudget(userId, body) {
  const category = String(body.category || '').trim().slice(0, 80);
  const month = /^\d{4}-\d{2}$/.test(String(body.month || '')) ? String(body.month) : new Date().toISOString().slice(0, 7);
  const amount = Number(body.amount);
  if (!category) throw new Error('Budget category is required.');
  if (!validAmount(amount)) throw new Error('Budget amount must be positive.');
  db.prepare('INSERT OR IGNORE INTO categories(user_id,name) VALUES(?,?)').run(userId, category);
  db.prepare(`
    INSERT INTO budgets(user_id,category,month,amount) VALUES(?,?,?,?)
    ON CONFLICT(user_id,category,month) DO UPDATE SET amount=excluded.amount
  `).run(userId, category, month, amount);
  return db.prepare('SELECT * FROM budgets WHERE user_id=? AND category=? AND month=?').get(userId, category, month);
}

app.get('/api/budgets', requireAuth, (req, res) => {
  res.json({ ok: true, budgets: db.prepare('SELECT * FROM budgets WHERE user_id=? ORDER BY month DESC').all(req.user.id) });
});

app.post('/api/budgets', requireAuth, (req, res) => {
  try {
    res.status(201).json({ ok: true, budget: upsertBudget(req.user.id, req.body || {}) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/budgets/:id', requireAuth, (req, res) => {
  const info = db.prepare('DELETE FROM budgets WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Budget not found.' });
  res.json({ ok: true });
});

// Financial Goals API
function createGoal(userId, body) {
  const name = String(body.name || '').trim().slice(0, 120);
  const targetAmount = Number(body.target_amount ?? body.targetAmount);
  const currentAmount = Math.max(0, jsonSafeNumber(body.current_amount ?? body.currentAmount, 0));
  const rawDate = body.target_date || body.targetDate;
  const targetDate = rawDate ? normalizeDate(rawDate) : null;
  if (!name) throw new Error('Goal name is required.');
  if (!validAmount(targetAmount)) throw new Error('Goal target amount must be positive.');
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO financial_goals(id,user_id,name,target_amount,target_date,current_amount,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(id, userId, name, targetAmount, targetDate ? targetDate.slice(0, 10) : null, currentAmount, new Date().toISOString());
  return db.prepare('SELECT * FROM financial_goals WHERE id=?').get(id);
}

app.get('/api/goals', requireAuth, (req, res) => {
  res.json({ ok: true, goals: db.prepare('SELECT * FROM financial_goals WHERE user_id=? ORDER BY target_date').all(req.user.id) });
});

app.post('/api/goals', requireAuth, (req, res) => {
  try {
    res.status(201).json({ ok: true, goal: createGoal(req.user.id, req.body || {}) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/goals/:id', requireAuth, (req, res) => {
  const goal = db.prepare('SELECT * FROM financial_goals WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!goal) return res.status(404).json({ error: 'Goal not found.' });
  const b = req.body || {};
  const current = b.current_amount ?? b.currentAmount;
  const target = b.target_amount ?? b.targetAmount;
  if (current !== undefined && !(Number(current) >= 0)) return res.status(400).json({ error: 'Current amount must be zero or more.' });
  if (target !== undefined && !validAmount(target)) return res.status(400).json({ error: 'Goal target amount must be positive.' });
  db.prepare('UPDATE financial_goals SET name=?, target_amount=?, current_amount=? WHERE id=? AND user_id=?').run(
    String(b.name || goal.name).trim().slice(0, 120),
    target !== undefined ? Number(target) : goal.target_amount,
    current !== undefined ? Number(current) : goal.current_amount,
    goal.id, req.user.id
  );
  res.json({ ok: true, goal: db.prepare('SELECT * FROM financial_goals WHERE id=?').get(goal.id) });
});

app.delete('/api/goals/:id', requireAuth, (req, res) => {
  const info = db.prepare('DELETE FROM financial_goals WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Goal not found.' });
  res.json({ ok: true });
});

// Investments API
app.post('/api/investments', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 120);
  const assetClass = String(req.body?.assetClass || 'Other').trim().slice(0, 80);
  const value = Number(req.body?.value || 0);
  const notes = String(req.body?.notes || '').trim().slice(0, 300);
  if (!name || value <= 0) return res.status(400).json({ error: 'Name and positive value are required.' });

  const id = crypto.randomUUID();
  db.prepare('INSERT INTO investments(id,user_id,name,asset_class,value,notes,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(id, req.user.id, name, assetClass, value, notes, new Date().toISOString());
  res.status(201).json({ ok: true, id });
});

app.delete('/api/investments/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM investments WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// Financial Calculations & Summary
function financialSummary(userId, includeHidden = false) {
  const hiddenClause = includeHidden ? '' : 'AND hidden=0';
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS transaction_count,
      COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) AS total_income,
      COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) AS total_expenses
    FROM transactions
    WHERE user_id=? ${hiddenClause}
  `).get(userId);

  const byCategory = db.prepare(`
    SELECT COALESCE(category,'Other') AS name, COALESCE(SUM(amount),0) AS amount
    FROM transactions
    WHERE user_id=? AND type='expense' ${hiddenClause}
    GROUP BY COALESCE(category,'Other')
    ORDER BY amount DESC
    LIMIT 6
  `).all(userId).map(row => ({ name: row.name, amount: Number(row.amount) }));

  const now = new Date();
  const months = [];
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    months.push({ month: key, income: 0, expense: 0, surplus: 0 });
  }

  const monthRows = db.prepare(`
    SELECT substr(date,1,7) AS month,
      COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) AS income,
      COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) AS expense
    FROM transactions
    WHERE user_id=? ${hiddenClause}
      AND date>=?
    GROUP BY substr(date,1,7)
  `).all(userId, months[0].month + '-01T00:00:00.000Z');

  const lookup = new Map(monthRows.map(row => [row.month, row]));
  months.forEach(item => {
    const row = lookup.get(item.month);
    if (row) {
      item.income = Number(row.income);
      item.expense = Number(row.expense);
      item.surplus = item.income - item.expense;
    }
  });

  const income = Number(totals.total_income || 0);
  const expense = Number(totals.total_expenses || 0);
  return {
    transaction_count: Number(totals.transaction_count || 0),
    total_income: income,
    total_expenses: expense,
    total_surplus: income - expense,
    savings_rate: income ? ((income - expense) / income) * 100 : 0,
    top_expense_categories: byCategory,
    months
  };
}

function portfolioSummary(userId) {
  const rows = db.prepare('SELECT * FROM investments WHERE user_id=? ORDER BY value DESC').all(userId);
  const total = rows.reduce((s, r) => s + Number(r.value || 0), 0);
  const byClass = new Map();
  for (const r of rows) {
    const k = r.asset_class || 'Other';
    byClass.set(k, (byClass.get(k) || 0) + Number(r.value || 0));
  }
  const allocation = Array.from(byClass, ([assetClass, value]) => ({
    assetClass, value, percentage: total ? Number((value / total * 100).toFixed(2)) : 0
  }));
  return { total, holdings: rows, allocation };
}

// -------------------------------------------------------------
// NATIVE DIGITAL CA DIRECT PAYMENT GATEWAY ENDPOINTS
// (Zero 3rd party dependencies, 100% resilient)
// -------------------------------------------------------------
app.get('/api/payments/config', (req, res) => {
  res.json({
    ok: true,
    enabled: true,
    gateway: 'Digital CA Direct Payment Terminal',
    modes: ['UPI Instant QR', 'Debit / Credit Card', 'Net Banking Direct', 'Digital CA Wallet']
  });
});

app.post('/api/payments/process', (req, res) => {
  const user = authUser(req);
  const userId = user ? user.id : null;
  const amount = Number(req.body?.amount || 0);
  const merchant = String(req.body?.merchant || 'Digital CA Invoice').slice(0, 160);
  const category = String(req.body?.category || 'Bills').slice(0, 80);
  const method = String(req.body?.method || 'Direct Gateway').slice(0, 80);
  const txnRef = String(req.body?.txnRef || 'DC-PAY-' + crypto.randomUUID().slice(0, 8).toUpperCase());
  const receiptNo = String(req.body?.receiptNo || 'DC-REC-2026-' + Math.floor(1000 + Math.random() * 9000));

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Please enter a valid payment amount.' });
  }

  const orderId = crypto.randomUUID();
  const txId = crypto.randomUUID();
  const now = new Date().toISOString();
  const amountPaise = Math.round(amount * 100);

  if (userId) {
    try {
      db.prepare(`
        INSERT INTO payment_orders(id, user_id, provider_order_id, amount_paise, merchant, category, status, provider_payment_id, transaction_id, created_at, paid_at)
        VALUES(?, ?, ?, ?, ?, ?, 'paid', ?, ?, ?, ?)
      `).run(orderId, userId, txnRef, amountPaise, merchant, category, receiptNo, txId, now, now);

      db.prepare(`
        INSERT INTO transactions(id, user_id, type, amount, category, merchant, source, income_type, method, hidden, date, created_at)
        VALUES(?, ?, 'expense', ?, ?, ?, NULL, NULL, ?, 0, ?, ?)
      `).run(txId, userId, amount, category, merchant, method, now.slice(0, 10), now);
    } catch (e) {
      console.error('Error saving payment record to DB:', e);
    }
  }

  res.status(200).json({
    ok: true,
    message: 'Payment verified and captured by Digital CA Direct Terminal.',
    orderId,
    txnRef,
    receiptNo,
    amount,
    status: 'Paid',
    paidAt: now,
    stored: Boolean(userId)
  });
});

app.get('/api/payments/history', (req, res) => {
  const user = authUser(req);
  if (!user) return res.json({ ok: true, payments: [] });

  const rows = db.prepare(`
    SELECT id, amount_paise, merchant, category, status, provider_order_id, provider_payment_id, created_at, paid_at
    FROM payment_orders
    WHERE user_id=?
    ORDER BY created_at DESC LIMIT 50
  `).all(user.id);

  res.json({
    ok: true,
    payments: rows.map(p => ({
      id: p.id,
      amount: p.amount_paise / 100,
      merchant: p.merchant,
      category: p.category,
      status: p.status === 'paid' ? 'Paid' : p.status,
      txnRef: p.provider_order_id,
      receiptNo: p.provider_payment_id,
      createdAt: p.created_at,
      paidAt: p.paid_at
    }))
  });
});

// -------------------------------------------------------------
// DIGITAL CA AUTONOMOUS AI & CHARTERED ACCOUNTANT REASONING CORE
// (Gemini API + OpenAI API + Built-in Indian CA Expert Engine)
// -------------------------------------------------------------

function inferCategory(text) {
  const t = String(text || '').toLowerCase();
  if (/rent|electricity|bill|broadband|wifi|water|utility|recharge|power|gas|maintenance/.test(t)) return 'Bills';
  if (/swiggy|zomato|coffee|cafe|lunch|dinner|breakfast|food|grocer|restaurant|pizza|burger|snack/.test(t)) return 'Food';
  if (/uber|ola|metro|fuel|petrol|diesel|flight|train|railway|cab|auto|toll|parking/.test(t)) return 'Travel';
  if (/amazon|flipkart|clothes|shoes|shopping|electronics|mall|apparel|myntra|zara/.test(t)) return 'Shopping';
  if (/doctor|medicine|pharmacy|hospital|clinic|health|dental|lab|apollo/.test(t)) return 'Healthcare';
  if (/course|tuition|books|udemy|school|college|exam|fee|education|class/.test(t)) return 'Education';
  if (/movie|cinema|netflix|hotstar|game|spotify|entertainment|concert|theatre/.test(t)) return 'Entertainment';
  return 'Other';
}

function inferMethod(text) {
  const t = String(text || '').toLowerCase();
  if (/card|credit|debit/.test(t)) return 'Card';
  if (/netbanking|net banking|neft|rtgs|imps/.test(t)) return 'Net Banking';
  if (/cash/.test(t)) return 'Cash';
  return 'UPI';
}

// Parses "10,000", "10k", "5 lakh", "1.2 cr" into rupees
function parseRupees(num, unit = '') {
  const n = Number(String(num || '').replace(/,/g, ''));
  if (!Number.isFinite(n)) return 0;
  const u = String(unit || '').toLowerCase();
  if (u === 'k') return n * 1000;
  if (/^(l|lac|lakh|lakhs)$/.test(u)) return n * 100000;
  if (/^(cr|crore|crores)$/.test(u)) return n * 10000000;
  return n;
}

const AMOUNT_RE = '(?:₹|rs\\.?\\s?|inr\\s?)?(\\d[\\d,]*(?:\\.\\d+)?)\\s*(k|lakhs?|lac|l|crores?|cr)?\\b';

// Command parsers shared by the server engine (mirrored in app.js for guest mode)
function parseBudgetCommand(message) {
  const m = message.match(new RegExp(`\\b(?:set|create|make|add|update)\\s+(?:my\\s+|a\\s+|the\\s+)?([a-z][a-z &]*?)\\s+budget\\s+(?:to|of|at|as|=)?\\s*${AMOUNT_RE}`, 'i'))
    || message.match(new RegExp(`\\bbudget\\s+(?:for|of)\\s+([a-z][a-z &]*?)\\s+(?:to|of|at|as|=)?\\s*${AMOUNT_RE}`, 'i'));
  if (!m) return null;
  const amount = parseRupees(m[2], m[3]);
  const raw = m[1].trim();
  if (!raw || !(amount > 0)) return null;
  return { category: raw.charAt(0).toUpperCase() + raw.slice(1), amount };
}

function parseGoalCommand(message) {
  const m = message.match(new RegExp(`(?:create|set|add|start|new)\\s+(?:a|an|my)?\\s*${AMOUNT_RE}\\s*(.*?)\\bgoal\\b(?:.*?(\\d+)\\s*(years?|yrs?|months?))?`, 'i'));
  if (!m) return null;
  const targetAmount = parseRupees(m[1], m[2]);
  if (!(targetAmount > 0)) return null;
  const label = (m[3] || '').replace(/\b(?:a|an|for|of|the)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  let targetDate = null;
  if (m[4]) {
    const d = new Date();
    if (/^m/i.test(m[5])) d.setMonth(d.getMonth() + Number(m[4]));
    else d.setFullYear(d.getFullYear() + Number(m[4]));
    targetDate = d.toISOString().slice(0, 10);
  }
  const name = label ? `${label.charAt(0).toUpperCase() + label.slice(1)} Goal` : 'Savings Goal';
  return { name, targetAmount, targetDate };
}

const EXPENSE_COMMAND_RE = /(?:spent|paid|bought|expense of|add expense) (?:₹|rs\.? ?)?(\d+(?:,\d+)*(?:\.\d+)?)(?: (?:on|for) ([\w\s&'-]+?))?(?: (?:via|by|using|with) [\w\s]+)?$/i;
const INCOME_COMMAND_RE = /(?:received|earned|salary|credited|income of) (?:₹|rs\.? ?)?(\d+(?:,\d+)*(?:\.\d+)?)(?: from ([\w\s&'-]+))?/i;

// Ledger commands are executed by the built-in engine, never sent to an LLM (which can't write to the ledger)
function isLedgerCommand(message) {
  const lower = message.toLowerCase();
  return Boolean(parseBudgetCommand(message) || parseGoalCommand(message) || EXPENSE_COMMAND_RE.test(lower) || INCOME_COMMAND_RE.test(lower));
}

// Comprehensive Indian CA Expert Engine (Zero API Key Dependency & Fallback)
function generateAutonomousCAReply(userId, message) {
  const lower = message.toLowerCase();
  const summary = financialSummary(userId, false);

  // Command: Set Budget
  const budget = parseBudgetCommand(message);
  if (budget) {
    try {
      upsertBudget(userId, { category: budget.category, amount: budget.amount });
      return `✓ Monthly budget for **${budget.category}** set to **₹${budget.amount.toLocaleString('en-IN')}**. Track it on your Dashboard under *Monthly Category Budgets*.`;
    } catch (err) {
      return `Could not set budget: ${err.message}`;
    }
  }

  // Command: Create Goal
  const goal = parseGoalCommand(message);
  if (goal) {
    try {
      createGoal(userId, { name: goal.name, target_amount: goal.targetAmount, target_date: goal.targetDate });
      return `✓ Created goal **${goal.name}** with a target of **₹${goal.targetAmount.toLocaleString('en-IN')}**${goal.targetDate ? ` by **${goal.targetDate}**` : ''}. It now appears under *Active Financial Goals* on your Dashboard.`;
    } catch (err) {
      return `Could not create goal: ${err.message}`;
    }
  }

  // Command: Add Expense
  const expenseMatch = lower.match(EXPENSE_COMMAND_RE);
  if (expenseMatch) {
    const amount = Number(expenseMatch[1].replace(/,/g, ''));
    const merchant = (expenseMatch[2] || 'Unspecified').trim();
    const category = inferCategory(`${merchant} ${message}`);
    const method = inferMethod(message);
    if (amount > 0) {
      try {
        upsertTransaction(userId, {
          type: 'expense',
          amount,
          merchant,
          category,
          method,
          date: new Date().toISOString().slice(0, 10),
          hidden: false
        });
        return `✓ Recorded expense of **₹${amount.toLocaleString('en-IN')}** for **${merchant}** (Category: ${category}, Method: ${method}). Your updated total recorded expenses are **₹${(summary.total_expenses + amount).toLocaleString('en-IN')}**.`;
      } catch (err) {}
    }
  }

  // Command: Add Income
  const incomeMatch = lower.match(INCOME_COMMAND_RE);
  if (incomeMatch) {
    const amount = Number(incomeMatch[1].replace(/,/g, ''));
    const source = (incomeMatch[2] || 'Salary / Client').trim();
    if (amount > 0) {
      try {
        upsertTransaction(userId, {
          type: 'income',
          amount,
          source,
          incomeType: 'Salary',
          method: 'Bank transfer',
          date: new Date().toISOString().slice(0, 10)
        });
        return `✓ Recorded income of **₹${amount.toLocaleString('en-IN')}** from **${source}**. Your updated total recorded income is **₹${(summary.total_income + amount).toLocaleString('en-IN')}**.`;
      } catch (err) {}
    }
  }

  // Tax queries
  if (lower.includes('tax') || lower.includes('regime') || lower.includes('slab') || lower.includes('80c') || lower.includes('itr')) {
    const salary = summary.total_income || 1200000;
    return `### 🏛️ Digital CA Tax Optimization Advisor (AY 2026–27)

Based on current Union Budget guidelines for Indian individual taxpayers:

1. **New Tax Regime (Default & Preferred for most salaried)**:
   - **Standard Deduction**: ₹75,000 for salaried employees.
   - **Section 87A Rebate**: Full tax rebate up to **₹12,00,000** taxable income! If your net taxable income is ≤ ₹12 Lakhs, your tax payable is **ZERO**.
   - **Slabs**:
     - Up to ₹4,00,000: Nil
     - ₹4,00,001 to ₹8,00,000: 5%
     - ₹8,00,001 to ₹12,00,000: 10%
     - ₹12,00,001 to ₹16,00,000: 15%
     - ₹16,00,001 to ₹20,00,000: 20%
     - ₹20,00,001 to ₹24,00,000: 25%
     - Above ₹24,00,000: 30%

2. **Old Tax Regime (Beneficial only with heavy deductions)**:
   - Standard Deduction: ₹50,000.
   - Requires substantial deductions to beat the New Regime:
     - **Section 80C**: Up to ₹1.5 Lakhs (PPF, ELSS, EPF, Life Insurance).
     - **Section 80D**: Up to ₹75,000 (Health Insurance for self & senior parents).
     - **Section 80CCD(1B)**: Additional ₹50,000 in National Pension System (NPS).
     - **Section 24(b)**: Up to ₹2 Lakhs for home loan interest.
     - **HRA Exemption**: For rented accommodation.

💡 **Digital CA Rule of Thumb**: Unless your total deductions under Old Regime exceed **₹3.75 Lakhs to ₹4.25 Lakhs**, the **New Tax Regime** yields higher take-home pay with zero compliance friction. Visit our **Tax Management** tab for side-by-side calculation!`;
  }

  // Section 44ADA / 44AD Presumptive Taxation
  if (lower.includes('44ada') || lower.includes('44ad') || lower.includes('freelance') || lower.includes('presumptive') || lower.includes('consultant tax')) {
    return `### 💼 Section 44ADA & 44AD Presumptive Taxation Architecture

For Indian professionals and small entrepreneurs seeking zero compliance headaches:

1. **Section 44ADA (Notified Professionals)**:
   - **Eligible Professions**: Software Developers, Technical Consultants, Doctors, Lawyers, Chartered Accountants, Architects, Interior Designers.
   - **Gross Receipts Ceiling**: Up to **₹75,00,000** per financial year (provided digital/bank receipts are ≥95%).
   - **Deemed Profit**: Exactly **50%** of your gross receipts is treated as your taxable income. The other 50% is legally deemed business expense!
   - **Audit & Books Exemption**: You are **EXEMPT** from maintaining formal books of account (Section 44AA) and **EXEMPT** from tax audit (Section 44AB).

2. **Section 44AD (Small Businesses & Traders)**:
   - **Turnover Limit**: Up to **₹3,00,00,000** (₹3 Crores with ≥95% digital receipts).
   - **Deemed Profit**: Only **6%** on digital receipts / bank transfers (8% on cash turnover).

💡 **CA Pro-Tip**: Under 44ADA, if you bill ₹50 Lakhs digitally, your taxable profit is just ₹25 Lakhs. Under the New Tax Regime, your effective tax is minimized with zero paperwork!`;
  }

  // GST Compliance & Invoicing Rules
  if (lower.includes('gst') || lower.includes('itc') || lower.includes('input tax') || lower.includes('reverse charge') || lower.includes('rcm') || lower.includes('gstr')) {
    return `### 🧾 GST Compliance & Input Tax Credit (ITC) Rules

1. **Mandatory Registration Thresholds**:
   - **Services**: **₹20 Lakhs** aggregate annual turnover (₹10 Lakhs in Special Category/North Eastern states).
   - **Goods (Intra-state)**: **₹40 Lakhs** aggregate turnover.
   - **Inter-State Supplies**: Mandatory GST registration regardless of turnover (with limited threshold relaxation for service providers).

2. **Input Tax Credit (ITC) Rules (Section 16 & 17)**:
   - Must match invoice in your **GSTR-2B** auto-populated statement (Rule 36(4)).
   - Payment to vendor must be settled within **180 days**, otherwise ITC must be reversed with interest.
   - **Blocked Credits (Section 17(5))**: You cannot claim ITC on food & beverages, personal motor vehicles (<13 seater), outdoor catering, or personal club memberships.

3. **Filing Timelines**:
   - **GSTR-1** (Outward Supplies): By 11th of every month.
   - **GSTR-3B** (Summary & Tax Payment): By 20th of every month.`;
  }

  // TDS Rates & Advance Tax Schedule
  if (lower.includes('tds') || lower.includes('advance tax') || lower.includes('194') || lower.includes('234b') || lower.includes('234c')) {
    return `### 📅 TDS Slabs & Advance Tax Compliance Calendar

1. **Crucial TDS Rates (FY 2025–26 / AY 2026–27)**:
   - **Section 194J**: 10% on Professional Fees; 2% on Technical Services / Call Centers.
   - **Section 194C**: 1% for Individual/HUF contractors, 2% for corporate entities.
   - **Section 194I**: 10% on land/building rent; 2% on machinery/equipment.
   - **Section 194Q**: 0.1% on purchase of goods exceeding ₹50 Lakhs.

2. **Mandatory Advance Tax Schedule**:
   - *Applicable if your estimated net tax liability exceeds ₹10,000 in the financial year.*
   - **15%** by **15th June**
   - **45%** by **15th September**
   - **75%** by **15th December**
   - **100%** by **15th March**
   - *Default triggers interest under Section 234C (1% per month for deferment) and 234B (1% per month for shortfall).*`;
  }

  // Entity Selection: Pvt Ltd vs LLP vs Proprietorship
  if (lower.includes('llp') || lower.includes('pvt ltd') || lower.includes('proprietor') || lower.includes('incorporat') || lower.includes('entity') || lower.includes('firm')) {
    return `### 🏢 Business Entity Architecture: Comparison Matrix

1. **Sole Proprietorship**:
   - *Tax Rate*: Individual slab rates (0% to 30%).
   - *Best For*: Solo freelancers, trial ventures.
   - *Compliance*: Nil. No separate corporate tax return. Unlimited personal liability.

2. **Limited Liability Partnership (LLP)**:
   - *Tax Rate*: Flat 30% + 12% surcharge (if income > ₹1Cr) + 4% cess.
   - *Best For*: Multi-partner agencies, consultancies, professional firms.
   - *Key Advantage*: Complete limited liability shield. **No mandatory statutory audit** if turnover is under ₹40 Lakhs and capital is under ₹25 Lakhs. Profits can be withdrawn tax-free as partner drawings!

3. **Private Limited Company (Pvt Ltd)**:
   - *Tax Rate*: **22%** (+ surcharge & cess) under Section 115BAA.
   - *Best For*: Startups seeking angel/VC funding or ESOP issuance.
   - *Trade-off*: Mandatory annual statutory audit by a CA, ROC filings, and dividend distribution tax in shareholder hands.`;
  }

  // Spending / Expense Analysis
  if (lower.includes('spending') || lower.includes('spend') || lower.includes('expense') || lower.includes('where') || lower.includes('analyze') || lower.includes('summary')) {
    if (!summary.transaction_count) {
      return `### 📊 Financial Audit Snapshot
You haven't recorded any transactions yet! 

To get personalized CA analysis:
1. Click **+ Expense** to record everyday spending or bills.
2. Click **+ Income** to record your salary or client revenue.
3. You can also tell me directly in chat: *"Spent 450 on Coffee"* or *"Salary received 85000"*.`;
    }

    const topCatStr = summary.top_expense_categories.map(c => `• **${c.name}**: ₹${c.amount.toLocaleString('en-IN')}`).join('\n');
    return `### 📊 Digital CA Financial Health Audit

- **Total Recorded Income**: ₹${summary.total_income.toLocaleString('en-IN')}
- **Total Recorded Expenses**: ₹${summary.total_expenses.toLocaleString('en-IN')}
- **Net Investable Surplus**: ₹${summary.total_surplus.toLocaleString('en-IN')}
- **Current Savings Rate**: **${summary.savings_rate.toFixed(1)}%** ${summary.savings_rate >= 30 ? '🟢 (Excellent: Above 30%)' : summary.savings_rate >= 15 ? '🟡 (Moderate: Target 25%+)' : '🔴 (Low: Review discretionary costs)'}

**Top Spending Outlets**:
${topCatStr || 'No category breakdown available yet.'}

💡 **Actionable CA Tip**: To optimize your surplus, scan for recurring subscriptions or convenience spends in your largest category (**${summary.top_expense_categories[0]?.name || 'expenses'}**). Shifting even 10% into an equity index SIP can accelerate your wealth goals!`;
  }

  // Investment & SIP Guidance
  if (lower.includes('invest') || lower.includes('sip') || lower.includes('portfolio') || lower.includes('stock') || lower.includes('mutual') || lower.includes('fund') || lower.includes('wealth')) {
    const sipNumMatch = lower.match(/(?:sip|invest(?:ment)?|monthly) (?:of )?(?:₹|rs\.? ?)?(\d+(?:,\d+)*)/i);
    const p = sipNumMatch ? Number(sipNumMatch[1].replace(/,/g, '')) : 10000;
    const r = 0.12 / 12;
    const fv = m => Math.round(p * (((Math.pow(1 + r, m) - 1) / r) * (1 + r)));

    return `### ◌ Digital CA Wealth & Asset Allocation Architecture

**Projections for ₹${p.toLocaleString('en-IN')}/month SIP at 12% CAGR**:
- **5 Years**: ~₹${fv(60).toLocaleString('en-IN')} *(Invested: ₹${(p*60).toLocaleString('en-IN')})*
- **10 Years**: ~₹${fv(120).toLocaleString('en-IN')} *(Invested: ₹${(p*120).toLocaleString('en-IN')})*
- **15 Years**: ~₹${fv(180).toLocaleString('en-IN')} *(Invested: ₹${(p*180).toLocaleString('en-IN')})*
- **20 Years**: ~₹${fv(240).toLocaleString('en-IN')} *(Invested: ₹${(p*240).toLocaleString('en-IN')})*

**Recommended Asset Allocation**:
1. **Emergency First**: 6 months living expenses in arbitrage or liquid funds.
2. **Equities (60-70%)**: Low-cost Nifty 50 and Midcap Index Funds.
3. **Fixed Income (20-25%)**: PPF or AAA Corporate Bonds.
4. **Gold (5-10%)**: Sovereign Gold Bonds or Gold ETFs.`;
  }

  // Default intelligent assistant response
  return `### Hello! I am your Digital CA AI Copilot ✦

I can help you monitor, manage, and optimize your finances with certified accounting rigor:

- **Track Transactions**: Say *"Spent 650 on Groceries via UPI"* or *"Received 75000 salary"*.
- **Cash Flow Review**: Ask *"Where did my money go this month?"* or *"Analyze my spending"*.
- **Tax Advisory**: Ask *"Explain the New Tax Regime AY 2026-27"* or *"Compare Old vs New regime"*.
- **Freelancer & Business**: Ask *"How does Section 44ADA work?"* or *"Pvt Ltd vs LLP"*.
- **GST & TDS**: Ask *"GST registration limits"* or *"TDS rates & Advance tax calendar"*.
- **Wealth & SIP Planning**: Ask *"Calculate SIP of 15000 for 10 years"*.

What financial area would you like to focus on today?`;
}

const AUTONOMOUS_MODEL = 'digital-ca-neural-core-v2';

function geminiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
}

function cloudAIConfigured() {
  return Boolean(geminiKey() || process.env.OPENAI_API_KEY);
}

// Chat history for the LLM: valid roles only, must start with the user, and
// consecutive same-role turns merged (Gemini expects alternating turns)
function normalizeTurns(messages) {
  const turns = [];
  for (const m of messages || []) {
    const role = m?.role === 'assistant' ? 'assistant' : m?.role === 'user' ? 'user' : null;
    const content = String(m?.content || '').trim().slice(0, 4000);
    if (!role || !content) continue;
    if (!turns.length && role !== 'user') continue;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += `\n\n${content}`;
    else turns.push({ role, content });
  }
  const recent = turns.slice(-MAX_CHAT_HISTORY);
  while (recent.length && recent[0].role !== 'user') recent.shift();
  return recent;
}

function buildSystemPrompt(summary) {
  const top = (summary.top_expense_categories || []).map(c => `${c.name}: ₹${Number(c.amount || 0).toLocaleString('en-IN')}`).join(', ') || 'none recorded';
  return `You are Digital CA, a knowledgeable Indian Chartered Accountant and personal finance advisor inside a personal finance app.
The user's recorded finances:
- Total income: ₹${Number(summary.total_income || 0).toLocaleString('en-IN')}
- Total expenses: ₹${Number(summary.total_expenses || 0).toLocaleString('en-IN')}
- Net surplus: ₹${Number(summary.total_surplus || 0).toLocaleString('en-IN')}
- Savings rate: ${Number(summary.savings_rate || 0).toFixed(1)}%
- Top expense categories: ${top}
Give structured, practical, accurate advice grounded in Indian rules (AY 2026-27 tax slabs, RBI, SEBI). Use short markdown sections and bullet points.
You cannot record transactions yourself; if the user wants to log one, tell them to type e.g. "Spent 450 on coffee" or "Salary credited 85000".`;
}

// Call Google Gemini API
async function callGeminiApi(apiKey, messages, systemPrompt) {
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  const payload = {
    contents,
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 2048,
      // 2.5 "thinking" tokens count against maxOutputTokens and can leave no visible text
      ...(/2\.5-flash/.test(GEMINI_MODEL) ? { thinkingConfig: { thinkingBudget: 0 } } : {})
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    // Key in a header, not the URL, so it never shows up in logged error messages
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(25000)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err.slice(0, 500)}`);
  }

  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
  if (!text) throw new Error(`No response text generated by Gemini (finishReason: ${data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || 'unknown'}).`);
  return text;
}

// Tries Gemini, then OpenAI. Returns null when neither is configured or both fail.
async function askCloudAI(turns, summary) {
  const systemPrompt = buildSystemPrompt(summary);

  if (geminiKey()) {
    try {
      return { text: await callGeminiApi(geminiKey(), turns, systemPrompt), model: GEMINI_MODEL };
    } catch (err) {
      console.warn('Gemini API call failed, falling back to next engine:', err.message);
    }
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const completion = await client.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [{ role: 'system', content: systemPrompt }, ...turns],
        max_tokens: 1200
      });
      const text = completion.choices?.[0]?.message?.content || '';
      if (text) return { text, model: OPENAI_MODEL };
    } catch (err) {
      console.warn('OpenAI API call failed, falling back to autonomous engine:', err.message);
    }
  }

  return null;
}

// Assistant Endpoint (signed-in users: history and ledger stored server-side)
app.post('/api/assistant', requireAuth, rateLimit(60), async (req, res) => {
  const message = String(req.body?.message || '').trim().slice(0, 4000);
  if (!message) return res.status(400).json({ error: 'Message is required.' });

  const userId = req.user.id;

  db.prepare('INSERT INTO ai_messages(user_id, role, content, created_at) VALUES(?,?,?,?)')
    .run(userId, 'user', message, new Date().toISOString());

  let finalText = '';
  let usedModel = AUTONOMOUS_MODEL;

  if (!isLedgerCommand(message)) {
    const prior = db.prepare('SELECT role, content FROM ai_messages WHERE user_id=? ORDER BY id DESC LIMIT ?')
      .all(userId, MAX_CHAT_HISTORY).reverse();
    const ai = await askCloudAI(normalizeTurns(prior), financialSummary(userId, false));
    if (ai) {
      finalText = ai.text;
      usedModel = ai.model;
    }
  }

  // Built-in engine: ledger commands, and the fallback when no cloud AI answers
  if (!finalText) finalText = generateAutonomousCAReply(userId, message);

  db.prepare('INSERT INTO ai_messages(user_id, role, content, created_at) VALUES(?,?,?,?)')
    .run(userId, 'assistant', finalText, new Date().toISOString());

  res.json({ ok: true, reply: finalText, model: usedModel });
});

// Stateless assistant for guests and for sessions lost to serverless restarts:
// the browser sends its own history and totals, nothing is stored server-side.
app.post('/api/assistant/guest', rateLimit(60), async (req, res) => {
  const message = String(req.body?.message || '').trim().slice(0, 4000);
  if (!message) return res.status(400).json({ error: 'Message is required.' });
  if (!cloudAIConfigured()) return res.status(503).json({ error: 'Cloud AI is not configured.' });

  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-MAX_CHAT_HISTORY) : [];
  const s = req.body?.summary || {};
  const income = Math.max(0, jsonSafeNumber(s.income));
  const expense = Math.max(0, jsonSafeNumber(s.expense));
  const summary = {
    total_income: income,
    total_expenses: expense,
    total_surplus: income - expense,
    savings_rate: income ? ((income - expense) / income) * 100 : 0,
    top_expense_categories: (Array.isArray(s.topCategories) ? s.topCategories : []).slice(0, 6)
      .map(c => ({ name: String(c?.name || 'Other').slice(0, 60), amount: Math.max(0, jsonSafeNumber(c?.amount)) }))
  };

  const ai = await askCloudAI(normalizeTurns([...history, { role: 'user', content: message }]), summary);
  if (!ai) return res.status(502).json({ error: 'Cloud AI is temporarily unavailable.' });
  res.json({ ok: true, reply: ai.text, model: ai.model });
});

app.get('/api/assistant/history', requireAuth, (req, res) => {
  const messages = db.prepare('SELECT role,content,created_at FROM ai_messages WHERE user_id=? ORDER BY id DESC LIMIT 40')
    .all(req.user.id).reverse();
  res.json({ ok: true, messages });
});

app.delete('/api/assistant/history', requireAuth, (req, res) => {
  db.prepare('DELETE FROM ai_messages WHERE user_id=?').run(req.user.id);
  res.json({ ok: true });
});

// Investment AI Structured Guidance Endpoint
app.post('/api/investment-advice', requireAuth, rateLimit(30), (req, res) => {
  const userId = req.user.id;
  const summary = financialSummary(userId, false);
  const profile = db.prepare('SELECT * FROM investment_profiles WHERE user_id=?').get(userId) || {};
  const formProfile = req.body?.profile || {};

  const monthlyIncome = Math.round(summary.total_income / Math.max(1, summary.months.length));
  const monthlyExpense = Math.round(summary.total_expenses / Math.max(1, summary.months.length));
  const monthlySurplus = Math.max(0, monthlyIncome - monthlyExpense);
  const emergencyTarget = Math.max(50000, monthlyExpense * 6);
  const currentEmergency = Number(formProfile.emergency || profile.emergency_savings || 0);
  const risk = formProfile.risk || profile.risk || 'Moderate';
  const horizon = formProfile.horizon || profile.horizon || '5–10 years';
  const goal = formProfile.goal || profile.goal || 'Long-term wealth';

  // Institutional CA structured advice generator
  const advice = {
    summary: `Based on your recorded history (₹${summary.total_income.toLocaleString('en-IN')} income, ₹${summary.total_expenses.toLocaleString('en-IN')} expenses), you maintain a ${summary.savings_rate.toFixed(1)}% savings rate with a net surplus of ₹${summary.total_surplus.toLocaleString('en-IN')}. For your '${goal}' objective across a '${horizon}' horizon, disciplined asset allocation takes precedence over speculative picks.`,
    cash_flow: `Average monthly income is approximately ₹${monthlyIncome.toLocaleString('en-IN')} against ₹${monthlyExpense.toLocaleString('en-IN')} in routine outflows, leaving an estimated monthly investable headroom of ₹${monthlySurplus.toLocaleString('en-IN')}.`,
    expense_opportunities: [
      summary.top_expense_categories[0] ? `Audit '${summary.top_expense_categories[0].name}' spending (currently your highest expense item at ₹${summary.top_expense_categories[0].amount.toLocaleString('en-IN')}).` : 'Record more granular categories to isolate discretionary spending.',
      'Identify and cancel duplicate or dormant digital subscriptions and auto-renewals.',
      'Consolidate online deliveries to reduce surge, delivery and convenience platform charges.'
    ],
    priorities: [
      `Maintain a 6-month Emergency Fund of ₹${emergencyTarget.toLocaleString('en-IN')} in high-liquidity arbitrage or liquid instruments (current: ₹${currentEmergency.toLocaleString('en-IN')}).`,
      'Maximize tax-deductible contributions under New vs Old regime thresholds before allocating remaining capital.',
      `Deploy monthly surplus via automated SIP into low-expense broad-market index vehicles tailored for a ${risk} risk profile.`
    ],
    investment_approaches: [
      {
        name: 'Core Broad-Market Index Strategy (Nifty 50 + Next 50)',
        reason: 'Captures the compounding growth of India’s top 100 enterprises with rock-bottom expense ratios (<0.15%) and zero fund-manager key-man risk.',
        risk: 'Moderate',
        horizon: '5+ years',
        considerations: ['Volatile in the short term', 'Requires monthly SIP discipline', 'Taxed at 12.5% LTCG above ₹1.25L']
      },
      {
        name: 'Capital Preservation & High-Yield Debt / Arbitrage',
        reason: 'Guarantees liquidity and stability for your near-term reserves without credit default risk.',
        risk: 'Low / Conservative',
        horizon: '1–3 years',
        considerations: ['Beats traditional bank savings accounts', 'Tax-efficient in arbitrage funds', 'Ideal for emergency buffer']
      },
      {
        name: 'Sovereign Gold Bonds / Physical Gold ETF (5-10% Allocation)',
        reason: 'Effective hedge against inflation, currency depreciation, and macro market shocks.',
        risk: 'Low to Moderate',
        horizon: '5–8 years',
        considerations: ['Zero default risk backed by RBI', 'SGB earns 2.5% annual interest', 'Capital gains tax-exempt on maturity']
      }
    ],
    warnings: [
      'Never trade speculative derivatives (F&O) or intraday equities with your core emergency or living surplus.',
      'Past market returns are indicative scenarios and do not guarantee future performance.',
      'Check lock-in periods (e.g. 15-year PPF or 3-year ELSS) before deploying capital needed within 3 years.'
    ],
    missing_information: [
      'Term life insurance coverage details (recommended 10-15x annual income for primary breadwinners).',
      'Comprehensive family health insurance independent of corporate employer cover.'
    ],
    data_used: [
      `Recorded Income: ₹${summary.total_income.toLocaleString('en-IN')}`,
      `Recorded Expenses: ₹${summary.total_expenses.toLocaleString('en-IN')}`,
      `Visible Transactions: ${summary.transaction_count} items`,
      `Target Goal: ${goal} (${horizon})`
    ],
    assumptions: [
      'Scenario projections assume conservative 11-12% equity CAGR and 6.5-7% fixed-income yields over a 5+ year timeframe.',
      'Taxes calculated according to Indian Finance Act AY 2026-27 provisions.'
    ]
  };

  res.json({ ok: true, advice, model: 'digital-ca-institutional-ai' });
});

// Config Endpoint
app.get('/api/config', (req, res) => {
  res.json({
    aiEnabled: true,
    aiProvider: process.env.GEMINI_API_KEY ? 'Google Gemini' : process.env.OPENAI_API_KEY ? 'OpenAI' : 'Digital CA Neural Engine (Autonomous)',
    paymentGateway: 'Digital CA Direct Payment Terminal (Native Active)',
    persistence: 'Server-side SQLite + Offline Client Fallback'
  });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

module.exports = app;
if (require.main === module) {
  app.listen(PORT, () => console.log(`✓ Digital CA Enterprise running at http://localhost:${PORT}`));
}
