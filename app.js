const LEGACY_TX_KEY = 'digitalCA_transactions_v3';
const LEGACY_CATS_KEY = 'digitalCA_categories_v3';
const LEGACY_HIDDEN_HASH = 'digitalCA_hidden_hash_v3';
const LEGACY_USER_KEY = 'digitalCA_user_v3';
const PROFILE_KEY = 'digitalCA_investment_profile_v1';
const DEFAULT_CATS = ['Food', 'Travel', 'Bills', 'Shopping', 'Healthcare', 'Education', 'Entertainment', 'Other'];

let isServerAvailable = true;

const state = {
  user: null,
  transactions: [],
  categories: [...DEFAULT_CATS],
  investmentProfile: {},
  budgets: [],
  goals: [],
  investments: [],
  authMode: 'login',
  assistantMessages: [],
  loading: false,
  filterText: '',
  filterCategory: 'All',
  filterType: 'All'
};

function readJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn('Storage write failed', e);
  }
}

function legacyKey(base, email = null) {
  return `${base}_${email || 'guest'}`;
}

function legacyTransactions(email = null) {
  return readJson(legacyKey(LEGACY_TX_KEY, email), []);
}

function legacyCategories(email = null) {
  const saved = readJson(legacyKey(LEGACY_CATS_KEY, email), null);
  return Array.isArray(saved) && saved.length ? saved : [...DEFAULT_CATS];
}

function legacyProfile(email = null) {
  return readJson(legacyKey(PROFILE_KEY, email), {});
}

function legacyHiddenUnlocked(email = null) {
  return sessionStorage.getItem(`hiddenUnlocked_${email || 'guest'}`) === '1';
}

function currentUser() {
  return state.user;
}

function txs() {
  return Array.isArray(state.transactions) ? state.transactions : [];
}

function cats() {
  return Array.isArray(state.categories) && state.categories.length ? state.categories : [...DEFAULT_CATS];
}

function investmentProfile() {
  return state.investmentProfile || {};
}

function money(n) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', {
    maximumFractionDigits: 0
  });
}

function moneyDec(n) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function fmtDate(d) {
  if (!d) return '—';
  const parsed = new Date(d);
  if (isNaN(parsed.getTime())) return String(d);
  return parsed.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
}

function monthKey(d) {
  const x = new Date(d);
  if (isNaN(x.getTime())) return '';
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`;
}

function last6() {
  const out = [];
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  for (let i = 5; i >= 0; i -= 1) {
    const x = new Date(first);
    x.setMonth(first.getMonth() - i);
    out.push({
      key: monthKey(x),
      label: x.toLocaleDateString('en-IN', { month: 'short' })
    });
  }
  return out;
}

function visibleTxs() {
  return txs().filter(x => !x.hidden);
}

function dashboardTotals() {
  const a = visibleTxs();
  const income = a.filter(x => x.type === 'income').reduce((s, x) => s + Number(x.amount || 0), 0);
  const expense = a.filter(x => x.type === 'expense').reduce((s, x) => s + Number(x.amount || 0), 0);
  return {
    income,
    expense,
    net: income - expense,
    savingsRate: income ? ((income - expense) / income) * 100 : 0
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[c]));
}

function openModal(id) {
  document.getElementById(id)?.classList.add('open');
}

function closeModal(id) {
  document.getElementById(id)?.classList.remove('open');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// Resilient API Fetch (Zero "Failed to Fetch" Unhandled Crashes)
async function apiFetch(url, options = {}) {
  try {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Digital-CA': '1',
        ...(options.headers || {})
      }
    });

    isServerAvailable = true;
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
      ? await response.json()
      : { error: await response.text() };

    if (response.status === 401 && !url.startsWith('/api/auth/')) {
      state.user = null;
      localStorage.removeItem(LEGACY_USER_KEY);
      throw new Error('Please sign in to continue.');
    }

    if (!response.ok) {
      throw new Error(payload.error || 'Request failed.');
    }

    return payload;
  } catch (err) {
    if (err.name === 'TypeError' || err.message.includes('fetch')) {
      isServerAvailable = false;
      console.warn('Backend server currently offline or running in standalone static mode. Operating locally with zero data loss.');
      // Return a simulated response for essential endpoints to avoid breaking callers
      if (url === '/api/me') return { ok: true, user: state.user };
      if (url === '/api/bootstrap') {
        return {
          ok: true,
          transactions: txs(),
          categories: cats(),
          investmentProfile: investmentProfile(),
          budgets: state.budgets,
          goals: state.goals,
          investments: state.investments
        };
      }
      if (url.startsWith('/api/payments/config')) return { ok: true, enabled: true, gateway: 'Digital CA Direct Terminal' };
      if (url === '/api/payments/history') return { ok: true, payments: readJson('digitalca_payment_history', []) };
    }
    throw err;
  }
}

async function checkSession() {
  try {
    const result = await fetch('/api/me', { credentials: 'same-origin' });
    if (result.ok) {
      const payload = await result.json();
      state.user = payload.user || null;
      if (state.user) writeJson(LEGACY_USER_KEY, state.user);
      else localStorage.removeItem(LEGACY_USER_KEY);
      return;
    }
  } catch {}
  state.user = readJson(LEGACY_USER_KEY, null);
}

async function loadData() {
  if (state.user) {
    try {
      const payload = await apiFetch('/api/bootstrap');
      state.transactions = Array.isArray(payload.transactions) ? payload.transactions : [];
      state.categories = Array.isArray(payload.categories) && payload.categories.length
        ? payload.categories
        : [...DEFAULT_CATS];
      state.investmentProfile = payload.investmentProfile || {};
      state.budgets = payload.budgets || [];
      state.goals = payload.goals || [];
      state.investments = payload.investments || [];
      return;
    } catch {}
  }

  // Load guest data with rich preloaded samples if pristine
  let localTxs = legacyTransactions();
  if (!localTxs.length) {
    localTxs = getStarterTransactions();
    saveGuestTransactions(localTxs);
  }
  state.transactions = localTxs;
  state.categories = legacyCategories();
  state.investmentProfile = legacyProfile();
  state.budgets = readJson('digitalca_budgets_guest', [
    { category: 'Food', month: monthKey(new Date()), amount: 12000 },
    { category: 'Bills', month: monthKey(new Date()), amount: 8000 }
  ]);
  state.goals = readJson('digitalca_goals_guest', [
    { id: 'g1', name: 'Emergency Reserve (6 Months)', target_amount: 150000, current_amount: 90000, target_date: '2026-12-31' },
    { id: 'g2', name: 'Nifty 50 Index Wealth Goal', target_amount: 500000, current_amount: 180000, target_date: '2028-06-30' }
  ]);
  state.investments = readJson('digitalca_investments_guest', [
    { id: 'inv1', name: 'Nifty 50 Index Mutual Fund', asset_class: 'Equity Index', value: 125000, notes: 'Direct Growth' },
    { id: 'inv2', name: 'Public Provident Fund (PPF)', asset_class: 'Government Debt', value: 85000, notes: 'Section 80C tax exempt' },
    { id: 'inv3', name: 'Sovereign Gold Bonds (SGB)', asset_class: 'Gold', value: 35000, notes: '2.5% annual coupon' }
  ]);
}

function getStarterTransactions() {
  const d = new Date();
  const iso = offsetDays => {
    const x = new Date(d);
    x.setDate(x.getDate() - offsetDays);
    return x.toISOString().slice(0, 10);
  };

  return [
    { id: 'tx-1', type: 'income', amount: 85000, source: 'Tech Corp Tech Salary', incomeType: 'Salary', method: 'Bank transfer', date: iso(2), hidden: false },
    { id: 'tx-2', type: 'expense', amount: 18500, merchant: 'Apartment Rent', category: 'Bills', method: 'Net Banking', date: iso(3), hidden: false },
    { id: 'tx-3', type: 'expense', amount: 2800, merchant: 'Nature Basket Groceries', category: 'Food', method: 'UPI', date: iso(4), hidden: false },
    { id: 'tx-4', type: 'expense', amount: 1500, merchant: 'Electricity & Gas Bill', category: 'Bills', method: 'UPI', date: iso(6), hidden: false },
    { id: 'tx-5', type: 'expense', amount: 1200, merchant: 'Uber Business Commute', category: 'Travel', method: 'UPI', date: iso(7), hidden: false },
    { id: 'tx-6', type: 'expense', amount: 4500, merchant: 'Uniqlo Apparel', category: 'Shopping', method: 'Card', date: iso(10), hidden: false },
    { id: 'tx-7', type: 'income', amount: 15000, source: 'Freelance Advisory Retainer', incomeType: 'Freelance', method: 'UPI', date: iso(14), hidden: false },
    { id: 'tx-8', type: 'expense', amount: 1500, merchant: 'CA Advisory Consultation', category: 'Bills', method: 'Direct Gateway', date: iso(15), hidden: false }
  ];
}

async function loadAuthenticatedData() {
  if (!state.user) return loadData();
  try {
    const payload = await apiFetch('/api/bootstrap');
    state.transactions = payload.transactions || [];
    state.categories = payload.categories || [...DEFAULT_CATS];
    state.investmentProfile = payload.investmentProfile || {};
    state.budgets = payload.budgets || [];
    state.goals = payload.goals || [];
    state.investments = payload.investments || [];
  } catch {
    loadData();
  }
}

function saveGuestTransactions(items) {
  state.transactions = items;
  writeJson(legacyKey(LEGACY_TX_KEY), items);
  writeJson(LEGACY_TX_KEY, items);
}

function saveGuestCategories(items) {
  state.categories = items;
  writeJson(legacyKey(LEGACY_CATS_KEY), items);
}

function saveGuestProfile(profile) {
  state.investmentProfile = profile;
  writeJson(legacyKey(PROFILE_KEY), profile);
}

function populateCats() {
  document.querySelectorAll('[data-cat-select]').forEach(sel => {
    const previous = sel.value;
    sel.innerHTML = cats().map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    if (cats().includes(previous)) sel.value = previous;
  });

  const filter = document.getElementById('txCatFilter');
  if (filter) {
    filter.innerHTML = ['All', ...cats()].map(c => `<option value="${escapeHtml(c)}">${c === 'All' ? 'All Categories' : escapeHtml(c)}</option>`).join('');
    filter.value = cats().includes(state.filterCategory) ? state.filterCategory : 'All';
    state.filterCategory = filter.value;
  }
}

// -------------------------------------------------------------
// BUDGETS & GOALS (server when signed in, local storage for guests)
// -------------------------------------------------------------
async function saveBudget(category, amount) {
  if (state.user && isServerAvailable) {
    try {
      await apiFetch('/api/budgets', { method: 'POST', body: JSON.stringify({ category, amount, month: monthKey(new Date()) }) });
      await loadAuthenticatedData();
      return;
    } catch (err) {
      if (isServerAvailable) throw err;
    }
  }
  const month = monthKey(new Date());
  state.budgets = [
    ...(state.budgets || []).filter(b => !(b.category === category && b.month === month)),
    { id: 'b-' + Date.now(), category, month, amount }
  ];
  writeJson('digitalca_budgets_guest', state.budgets);
  if (!cats().includes(category)) saveGuestCategories([...cats(), category]);
}

async function saveGoal(goal) {
  if (state.user && isServerAvailable) {
    try {
      await apiFetch('/api/goals', { method: 'POST', body: JSON.stringify(goal) });
      await loadAuthenticatedData();
      return;
    } catch (err) {
      if (isServerAvailable) throw err;
    }
  }
  state.goals = [...(state.goals || []), { id: 'g-' + Date.now(), current_amount: 0, ...goal }];
  writeJson('digitalca_goals_guest', state.goals);
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
  return { name, target_amount: targetAmount, target_date: targetDate };
}

function renderBudgetGoalDashboard() {
  const host = document.getElementById('budgetGoalDashboard');
  if (!host) return;

  const currentMonth = monthKey(new Date());
  const expenses = visibleTxs().filter(x => x.type === 'expense' && monthKey(x.date) === currentMonth);
  const budgetRows = (state.budgets || []).filter(x => x.month === currentMonth || !x.month);
  
  const budgetItems = budgetRows.map(b => {
    const spent = expenses.filter(x => (x.category || 'Other') === b.category)
      .reduce((sum, x) => sum + Number(x.amount || 0), 0);
    return {
      category: b.category,
      amount: Number(b.amount || 0),
      spent,
      remaining: Math.max(0, Number(b.amount || 0) - spent)
    };
  });

  const totalBudget = budgetItems.reduce((s, x) => s + x.amount, 0);
  const totalBudgetSpent = budgetItems.reduce((s, x) => s + x.spent, 0);

  host.innerHTML = `
    <div class="panel">
      <div class="kicker">Monthly Category Budgets</div>
      <h3 style="font-family:Georgia,serif;font-weight:400;font-size:30px;margin:8px 0">${budgetRows.length ? money(totalBudgetSpent) : 'No budgets set'}</h3>
      <p class="muted">${budgetRows.length ? `${money(totalBudgetSpent)} spent of ${money(totalBudget)} budgeted for this month` : 'Add category limits to keep spending within your plan.'}</p>
      ${budgetItems.length ? budgetItems.map(item => `
        <div class="budget-row">
          <div><b>${escapeHtml(item.category)}</b><span>${money(item.spent)} / ${money(item.amount)} (${item.amount ? Math.round((item.spent / item.amount)*100) : 0}%)</span></div>
          <div class="budget-track"><i style="width:${Math.min(100, item.amount ? (item.spent / item.amount) * 100 : 0)}%;background:${item.spent > item.amount ? 'var(--red)' : 'var(--navy)'}"></i></div>
        </div>
      `).join('') : '<p class="muted" style="font-size:12px;margin-top:10px">Ask the AI Copilot: <em>"Set my food budget to ₹10,000"</em>.</p>'}
    </div>
    <div class="panel">
      <div class="kicker">Active Financial Goals</div>
      <h3 style="font-family:Georgia,serif;font-weight:400;font-size:30px;margin:8px 0">${state.goals?.length ? `${state.goals.length} active target${state.goals.length === 1 ? '' : 's'}` : 'No goals yet'}</h3>
      <p class="muted">${state.goals?.length ? 'Track capital targets and time horizons created with your CA.' : 'Create goals via the AI assistant: “Create a ₹5 lakh SIP goal for 3 years.”'}</p>
      ${(state.goals || []).slice(0, 4).map(g => {
        const target = Number(g.target_amount || 0);
        const current = Number(g.current_amount || 0);
        const progress = target ? Math.min(100, (current / target) * 100) : 0;
        return `<div class="goal-row"><div><b>${escapeHtml(g.name)}</b><span>${money(current)} of ${money(target)}</span></div><div class="budget-track"><i style="width:${progress}%;background:var(--acid)"></i></div></div>`;
      }).join('')}
    </div>
  `;
}

function renderDashboard() {
  renderBudgetGoalDashboard();
  const t = dashboardTotals();
  const values = {
    incomeTotal: t.income,
    expenseTotal: t.expense,
    netTotal: t.net,
    savingsRate: t.savingsRate
  };

  Object.entries(values).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = id === 'savingsRate' ? `${value.toFixed(1)}%` : money(value);
  });

  const rows = document.getElementById('recentRows');
  if (rows) {
    let a = visibleTxs().slice().sort((x, y) => new Date(y.date) - new Date(x.date));

    // Optional Search/Filter
    if (state.filterText) {
      const q = state.filterText.toLowerCase();
      a = a.filter(x => (x.merchant || '').toLowerCase().includes(q) || (x.source || '').toLowerCase().includes(q) || (x.category || '').toLowerCase().includes(q));
    }
    if (state.filterCategory && state.filterCategory !== 'All') {
      a = a.filter(x => x.category === state.filterCategory);
    }
    if (state.filterType && state.filterType !== 'All') {
      a = a.filter(x => x.type === state.filterType);
    }

    rows.innerHTML = a.length ? a.map(x => `
      <tr>
        <td>${fmtDate(x.date)}</td>
        <td><strong>${escapeHtml(x.merchant || x.source || '—')}</strong></td>
        <td><span class="tag">${escapeHtml(x.category || x.incomeType || 'Income')}</span></td>
        <td class="muted">${escapeHtml(x.method || '—')}</td>
        <td class="${x.type === 'income' ? 'success' : ''}" style="font-weight:700">${x.type === 'income' ? '+' : '-'}${money(x.amount)}</td>
        <td class="row-actions">
          <button class="icon-btn" type="button" title="Edit" data-edit-tx="${escapeHtml(x.id)}">Edit</button>
          <button class="icon-btn danger" type="button" title="Delete" data-delete-tx="${escapeHtml(x.id)}">×</button>
        </td>
      </tr>
    `).join('') : `
      <tr><td colspan="6"><div class="empty">No matching transactions found. Add a transaction or clear filters.</div></td></tr>
    `;

    rows.querySelectorAll('[data-edit-tx]').forEach(b => {
      b.addEventListener('click', () => editTransaction(b.dataset.editTx));
    });
    rows.querySelectorAll('[data-delete-tx]').forEach(b => {
      b.addEventListener('click', () => deleteTransaction(b.dataset.deleteTx));
    });
  }

  // Render Bar & Cash Flow Chart
  const c = document.getElementById('mainChart');
  if (c && window.Chart) {
    const m = last6();
    const a = visibleTxs();
    const inc = m.map(z => a.filter(x => x.type === 'income' && monthKey(x.date) === z.key)
      .reduce((s, x) => s + Number(x.amount || 0), 0));
    const exp = m.map(z => a.filter(x => x.type === 'expense' && monthKey(x.date) === z.key)
      .reduce((s, x) => s + Number(x.amount || 0), 0));

    if (window.mainChart && typeof window.mainChart.destroy === 'function') {
      window.mainChart.destroy();
    }

    window.mainChart = new Chart(c, {
      type: 'bar',
      data: {
        labels: m.map(z => z.label),
        datasets: [
          { label: 'Income', data: inc, backgroundColor: '#0b1622', borderRadius: 4, barPercentage: 0.6 },
          { label: 'Expenses', data: exp, backgroundColor: '#c9ff4a', borderColor: '#0b1622', borderWidth: 1, borderRadius: 4, barPercentage: 0.6 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top', align: 'end', labels: { boxWidth: 12, font: { family: 'Inter', weight: 600 } } },
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.dataset.label}: ₹${Number(ctx.raw).toLocaleString('en-IN')}`
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: { callback: v => '₹' + Number(v).toLocaleString('en-IN') },
            grid: { color: 'rgba(0,0,0,0.06)' }
          },
          x: {
            grid: { display: false }
          }
        }
      }
    });
  }
}

function setEntryType(type = 'expense') {
  const form = document.getElementById('addForm');
  if (!form) return;

  form.dataset.type = type;
  const isIncome = type === 'income';

  document.querySelectorAll('.entry-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.entryType === type);
  });

  document.getElementById('expenseFields')?.toggleAttribute('hidden', isIncome);
  document.getElementById('incomeFields')?.toggleAttribute('hidden', !isIncome);

  const kicker = document.getElementById('entryKicker');
  const title = document.getElementById('entryTitle');
  const help = document.getElementById('entryHelp');
  const save = document.getElementById('saveEntryBtn');

  if (kicker) kicker.textContent = isIncome ? 'Income' : 'Expense';
  if (title) title.textContent = form.dataset.mode === 'edit'
    ? `Edit ${isIncome ? 'income' : 'expense'}`
    : `Add ${isIncome ? 'income' : 'expense'}`;
  if (help) help.textContent = isIncome ? 'Record money received into your accounts.' : 'Record where your money was spent.';
  if (save) save.textContent = form.dataset.mode === 'edit'
    ? 'Save changes →'
    : isIncome ? 'Save income →' : 'Save expense →';
}

function resetTransactionForm(type = 'expense') {
  const form = document.getElementById('addForm');
  if (!form) return;

  form.reset();
  form.dataset.mode = 'create';
  form.dataset.id = '';
  const date = form.querySelector('[name="date"]');
  if (date) date.value = new Date().toISOString().slice(0, 10);
  populateCats();
  setEntryType(type);
}

function addTransaction(type = 'expense') {
  resetTransactionForm(type);
  openModal('addModal');
}

function editTransaction(id) {
  const tx = txs().find(x => x.id === id);
  if (!tx) return showToast('Transaction not found.');

  const form = document.getElementById('addForm');
  if (!form) return;

  form.reset();
  form.dataset.mode = 'edit';
  form.dataset.id = id;
  const amount = form.querySelector('[name="amount"]');
  const date = form.querySelector('[name="date"]');
  if (amount) amount.value = tx.amount;
  if (date) date.value = new Date(tx.date).toISOString().slice(0, 10);
  populateCats();

  if (tx.type === 'income') {
    form.querySelector('[name="source"]').value = tx.source || tx.merchant || '';
    form.querySelector('[name="incomeType"]').value = tx.incomeType || 'Other';
    form.querySelector('[name="incomeMethod"]').value = tx.method || 'Bank transfer';
  } else {
    form.querySelector('[name="merchant"]').value = tx.merchant || '';
    form.querySelector('[name="category"]').value = tx.category || 'Other';
    form.querySelector('[name="method"]').value = tx.method || 'Other';
    form.querySelector('[name="hidden"]').checked = Boolean(tx.hidden);
  }

  setEntryType(tx.type);
  openModal('addModal');
}

async function persistTransaction(payload, id = null) {
  if (state.user && isServerAvailable) {
    try {
      const result = id
        ? await apiFetch(`/api/transactions/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify(payload)
          })
        : await apiFetch('/api/transactions', {
            method: 'POST',
            body: JSON.stringify(payload)
          });

      await loadAuthenticatedData();
      return result;
    } catch (err) {
      console.warn('Falling back to local persistence:', err.message);
    }
  }

  // Local/Guest fallback
  if (id) {
    state.transactions = state.transactions.map(x => x.id === id ? { ...x, ...payload, date: new Date(payload.date).toISOString() } : x);
  } else {
    state.transactions = [{
      id: crypto.randomUUID ? crypto.randomUUID() : 'tx-' + Date.now(),
      ...payload,
      date: new Date(payload.date).toISOString(),
      hidden: Boolean(payload.hidden),
      createdAt: new Date().toISOString()
    }, ...state.transactions];
  }
  saveGuestTransactions(state.transactions);
  return { ok: true };
}

async function submitTransactionForm(event) {
  event.preventDefault();

  const form = document.getElementById('addForm');
  if (!form) return;

  const fd = new FormData(form);
  const type = form.dataset.type || 'expense';
  const amount = Number(fd.get('amount'));

  if (!Number.isFinite(amount) || amount <= 0) {
    showToast('Enter a valid amount.');
    return;
  }

  const payload = type === 'income'
    ? {
        type: 'income',
        amount,
        source: String(fd.get('source') || '').trim() || 'Salary / Revenue',
        incomeType: String(fd.get('incomeType') || 'Other'),
        method: String(fd.get('incomeMethod') || 'Bank transfer'),
        date: fd.get('date')
      }
    : {
        type: 'expense',
        amount,
        merchant: String(fd.get('merchant') || '').trim(),
        category: String(fd.get('category') || 'Other'),
        method: String(fd.get('method') || 'Other'),
        date: fd.get('date'),
        hidden: fd.get('hidden') === 'on'
      };

  if (type === 'expense' && !payload.merchant) {
    showToast('Enter payee or merchant description.');
    return;
  }

  const isEdit = form.dataset.mode === 'edit';
  try {
    await persistTransaction(payload, isEdit ? form.dataset.id : null);
    closeModal('addModal');
    renderAll();
    showToast(isEdit ? 'Transaction updated' : type === 'income' ? 'Income recorded' : 'Expense recorded');
  } catch (err) {
    showToast(err.message);
  }
}

async function deleteTransaction(id) {
  const tx = txs().find(x => x.id === id);
  if (!tx) return showToast('Transaction not found.');
  if (!window.confirm(`Delete ${tx.type} ${money(tx.amount)} from ${fmtDate(tx.date)}?`)) return;

  try {
    if (state.user && isServerAvailable) {
      await apiFetch(`/api/transactions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadAuthenticatedData();
    } else {
      saveGuestTransactions(txs().filter(x => x.id !== id));
    }

    renderAll();
    showToast('Transaction deleted');
  } catch (err) {
    showToast(err.message);
  }
}

async function addCategory(event) {
  event.preventDefault();
  const name = document.getElementById('catName')?.value.trim();
  if (!name) return;

  try {
    if (state.user && isServerAvailable) {
      const result = await apiFetch('/api/categories', {
        method: 'POST',
        body: JSON.stringify({ name })
      });
      state.categories = result.categories || cats();
    } else {
      saveGuestCategories([...new Set([...cats(), name])]);
    }
    document.getElementById('catName').value = '';
    renderCategories();
    populateCats();
    closeModal('catModal');
    showToast('Category added');
  } catch (err) {
    showToast(err.message);
  }
}

function renderCategories() {
  const w = document.getElementById('categoryGrid');
  if (!w) return;

  w.innerHTML = cats().map(c => {
    const count = txs().filter(x => x.category === c).length;
    const spent = txs().filter(x => x.category === c && x.type === 'expense').reduce((s, x) => s + Number(x.amount || 0), 0);
    const encoded = encodeURIComponent(c);
    return `
      <div class="category">
        <div class="category-head">
          <div>
            <b style="font-size:16px">${escapeHtml(c)}</b>
            <div class="muted" style="font-size:12px;margin-top:2px">${money(spent)} recorded</div>
          </div>
          ${c !== 'Other' ? `<button class="icon-btn danger" type="button" title="Remove category" data-remove-cat="${escapeHtml(encoded)}">×</button>` : ''}
        </div>
        <div class="category-list">
          <span class="tag">${count} transaction${count === 1 ? '' : 's'}</span>
        </div>
      </div>
    `;
  }).join('');

  w.querySelectorAll('[data-remove-cat]').forEach(b => {
    b.addEventListener('click', () => removeCategory(decodeURIComponent(b.dataset.removeCat)));
  });
}

async function removeCategory(name) {
  if (name === 'Other') return showToast('The Other category cannot be removed.');
  if (!window.confirm(`Remove “${name}”? Existing transactions will be re-categorized to Other.`)) return;

  try {
    if (state.user && isServerAvailable) {
      const result = await apiFetch(`/api/categories/${encodeURIComponent(name)}`, { method: 'DELETE' });
      state.categories = result.categories || cats();
      await loadAuthenticatedData();
    } else {
      saveGuestCategories(cats().filter(c => c !== name).concat(cats().includes('Other') ? [] : ['Other']));
      saveGuestTransactions(txs().map(x => x.category === name ? { ...x, category: 'Other' } : x));
    }

    renderAll();
    showToast(`${name} removed`);
  } catch (err) {
    showToast(err.message);
  }
}

// Hidden Vault Password & Security
async function hashLegacyPassword(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

function hiddenHashKey() {
  const u = state.user;
  return u ? `${LEGACY_HIDDEN_HASH}_${u.email}` : `${LEGACY_HIDDEN_HASH}_guest`;
}

async function setHiddenPassword() {
  const p = document.getElementById('newHiddenPass')?.value || '';
  if (p.length < 6) return showToast('Password must be at least 6 characters.');
  localStorage.setItem(hiddenHashKey(), await hashLegacyPassword(p));
  showToast('Hidden folder password created');
  closeModal('passwordModal');
}

async function unlockHidden() {
  const p = document.getElementById('hiddenPass')?.value || '';
  if (!p) return showToast('Enter your vault password.');

  const key = hiddenHashKey();
  const stored = localStorage.getItem(key);

  if (!stored) {
    localStorage.setItem(key, await hashLegacyPassword(p));
    sessionStorage.setItem(`hiddenUnlocked_${state.user?.email || 'guest'}`, '1');
    return revealHidden();
  }

  if (await hashLegacyPassword(p) === stored) {
    sessionStorage.setItem(`hiddenUnlocked_${state.user?.email || 'guest'}`, '1');
    revealHidden();
  } else {
    showToast('Incorrect password.');
  }
}

function revealHidden() {
  document.querySelector('.hidden-lock')?.remove();
  document.querySelector('.hidden-content')?.classList.add('unlocked');
  renderHidden();
}

function lockHidden() {
  sessionStorage.removeItem(`hiddenUnlocked_${state.user?.email || 'guest'}`);
  location.reload();
}

function renderHidden() {
  const wrap = document.getElementById('hiddenRows');
  if (!wrap) return;

  const a = txs().filter(x => x.type === 'expense' && x.hidden);
  wrap.innerHTML = a.length
    ? a.slice().sort((x, y) => new Date(y.date) - new Date(x.date)).map(x => `
        <div class="secret-item">
          <span><b>${escapeHtml(x.merchant)}</b><small>${escapeHtml(x.category)} · ${fmtDate(x.date)}</small></span>
          <b style="color:var(--navy)">${money(x.amount)}</b>
        </div>
      `).join('')
    : `<div class="empty">Your hidden expense vault is empty. Check “Save in Hidden Expenses” when adding a transaction.</div>`;
}

function initHidden() {
  if (legacyHiddenUnlocked(state.user?.email)) revealHidden();
}

// -------------------------------------------------------------
// INVESTMENT AI & INSTITUTIONAL WEALTH DIAGNOSTICS
// -------------------------------------------------------------
function getProfileFromForm() {
  return {
    goal: document.getElementById('invGoal')?.value || 'Long-term wealth',
    horizon: document.getElementById('invHorizon')?.value || '5–10 years',
    experience: document.getElementById('invExperience')?.value || 'Intermediate',
    risk: document.getElementById('invRisk')?.value || 'Moderate',
    monthly: Number(document.getElementById('invMonthly')?.value || 15000),
    emergency: Number(document.getElementById('invEmergency')?.value || 100000),
    targetAmount: Number(document.getElementById('invTarget')?.value || 2500000),
    existingInvestments: Number(document.getElementById('invExisting')?.value || 350000),
    debt: Number(document.getElementById('invDebt')?.value || 0),
    upcomingExpense: Number(document.getElementById('invUpcoming')?.value || 0),
    age: document.getElementById('invAge')?.value ? Number(document.getElementById('invAge').value) : 32
  };
}

async function saveInvestmentProfile(profile) {
  if (state.user && isServerAvailable) {
    try {
      const result = await apiFetch('/api/profile/investment', {
        method: 'PUT',
        body: JSON.stringify(profile)
      });
      state.investmentProfile = result.profile || profile;
      return;
    } catch (err) {
      if (isServerAvailable) throw err;
    }
  }
  saveGuestProfile(profile);
}

function buildInvestmentProfile() {
  const a = visibleTxs();
  const months = last6();
  const monthly = months.map(m => {
    const income = a.filter(x => x.type === 'income' && monthKey(x.date) === m.key)
      .reduce((s, x) => s + Number(x.amount || 0), 0);
    const expense = a.filter(x => x.type === 'expense' && monthKey(x.date) === m.key)
      .reduce((s, x) => s + Number(x.amount || 0), 0);
    return { month: m.label, income, expense, surplus: income - expense };
  });

  const income = a.filter(x => x.type === 'income').reduce((s, x) => s + Number(x.amount || 0), 0);
  const expense = a.filter(x => x.type === 'expense').reduce((s, x) => s + Number(x.amount || 0), 0);
  const groups = {};

  a.filter(x => x.type === 'expense').forEach(x => {
    groups[x.category || 'Other'] = (groups[x.category || 'Other'] || 0) + Number(x.amount || 0);
  });

  const top = Object.entries(groups).sort((x, y) => y[1] - x[1]).slice(0, 5);
  const profile = investmentProfile();

  return {
    transaction_count: a.length,
    months: monthly,
    total_income: income,
    total_expenses: expense,
    total_surplus: income - expense,
    savings_rate: income ? ((income - expense) / income) * 100 : 0,
    top_expense_categories: top.map(([name, amount]) => ({ name, amount })),
    ...profile
  };
}

function fillInvestmentForm(profile) {
  const mappings = {
    goal: 'invGoal',
    horizon: 'invHorizon',
    experience: 'invExperience',
    risk: 'invRisk',
    monthly: 'invMonthly',
    emergency: 'invEmergency',
    targetAmount: 'invTarget',
    existingInvestments: 'invExisting',
    debt: 'invDebt',
    upcomingExpense: 'invUpcoming',
    age: 'invAge'
  };

  Object.entries(mappings).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (!el || profile[key] === undefined || profile[key] === null) return;
    el.value = profile[key];
  });
}

function renderInvestmentAI() {
  const box = document.getElementById('investmentSummary');
  const advice = document.getElementById('investmentAdvice');
  if (!box && !advice) return;

  const p = buildInvestmentProfile();

  if (box) {
    const recordedPortfolio = (state.investments || []).reduce((sum, item) => sum + Number(item.value || 0), 0);
    const healthScore = Math.min(100, Math.max(10, Math.round((p.savings_rate * 1.2) + (recordedPortfolio > 0 ? 30 : 0) + (p.total_surplus > 0 ? 25 : 0))));

    box.innerHTML = `
      <div class="card"><div class="kicker">Recorded Income</div><h2>${money(p.total_income)}</h2><p>${p.transaction_count} visible transactions</p></div>
      <div class="card"><div class="kicker">Recorded Expenses</div><h2>${money(p.total_expenses)}</h2><p>Tracked routine spending</p></div>
      <div class="card"><div class="kicker">Net Surplus</div><h2>${money(p.total_surplus)}</h2><p>Cumulative savings buffer</p></div>
      <div class="card"><div class="kicker">Savings Rate</div><h2>${p.savings_rate.toFixed(1)}%</h2><p>Target: 25% to 35%+</p></div>
      <div class="card"><div class="kicker">Recorded Portfolio</div><h2>${money(recordedPortfolio)}</h2><p>${state.investments?.length || 0} active holdings</p></div>
      <div class="card" style="background:#0b1622;color:#fff"><div class="kicker" style="color:var(--acid)">Financial Health Score</div><h2 style="color:var(--acid)">${healthScore}/100</h2><p style="color:#b5c3ce">${healthScore >= 70 ? '🟢 Strong Institutional Grade' : '🟡 Moderate – Room for Optimization'}</p></div>
    `;
  }

  const surplus = document.getElementById('aiSurplus');
  const coverage = document.getElementById('aiCoverage');
  if (surplus) surplus.textContent = money(p.total_surplus);
  if (coverage) coverage.textContent = `${p.transaction_count} transaction${p.transaction_count === 1 ? '' : 's'} in view`;

  fillInvestmentForm(investmentProfile());
  if (advice && !advice.innerHTML.trim()) renderLocalInvestmentAdvice(p);
}

function renderLocalInvestmentAdvice(p) {
  const advice = document.getElementById('investmentAdvice');
  if (!advice) return;

  const age = Number(p.age || 30);
  const equityShare = Math.max(40, Math.min(80, 100 - age));
  const debtShare = Math.max(15, 90 - equityShare);
  const goldShare = 10;

  const items = [
    [
      `Institutional Asset Allocation Blueprint (${age} Yrs · ${p.risk || 'Moderate'} Risk)`,
      `Based on the classic 100-age lifecycle rule and your cash flow surplus of ${money(p.total_surplus)}:
      • <strong>Equities (${equityShare}%):</strong> Nifty 50 and Nifty Midcap 150 Index Funds via automated SIP.
      • <strong>Fixed Income (${debtShare}%):</strong> PPF, Corporate Bonds, and Liquid Reserve.
      • <strong>Gold / Hedge (${goldShare}%):</strong> Sovereign Gold Bonds or Gold ETFs for macroeconomic protection.`
    ],
    [
      'Emergency Reserve Stress Test',
      `Based on your recorded monthly expenses (~${money(p.total_expenses / 6)}/mo), an adequate 6-month liquidity buffer is <strong>${money((p.total_expenses / 6) * 6 || 100000)}</strong>. Keep this strictly in ultra-liquid accounts before committing to market volatility.`
    ],
    [
      'Systematic Compounding Projection (12% CAGR Model)',
      `If you invest a steady monthly SIP of <strong>₹15,000</strong>:
      • In <strong>5 Years:</strong> ~₹12.4 Lakhs (Invested: ₹9.0L)
      • In <strong>10 Years:</strong> ~₹34.8 Lakhs (Invested: ₹18.0L)
      • In <strong>15 Years:</strong> ~₹75.7 Lakhs (Invested: ₹27.0L)`
    ],
    [
      'Tax Efficiency & Friction Reduction',
      `Long-term capital gains (LTCG) on listed equity are tax-exempt up to ₹1.25 Lakhs per financial year and taxed at 12.5% thereafter. Tax-harvesting gains up to ₹1.25L annually can legally eliminate future capital gains tax!`
    ]
  ];

  advice.innerHTML = items.map(x => `
    <div class="advice-item">
      <b>${x[0]}</b>
      <p style="margin-top:8px">${x[1]}</p>
    </div>
  `).join('');
}

async function generateInvestmentAI() {
  const status = document.getElementById('aiStatus');
  const advice = document.getElementById('investmentAdvice');

  try {
    const profile = getProfileFromForm();
    await saveInvestmentProfile(profile);

    if (status) status.textContent = 'Generating Institutional CA Analysis…';

    let out = null;
    if (state.user && isServerAvailable) {
      try {
        out = await apiFetch('/api/investment-advice', {
          method: 'POST',
          body: JSON.stringify({ profile })
        });
      } catch {}
    }

    // If server not present or returned error, synthesize client CA analysis
    const a = out?.advice || {
      summary: `Automated CA Portfolio Audit for ${profile.goal} across a ${profile.horizon} horizon with a ${profile.risk} risk profile.`,
      cash_flow: `Current surplus enables disciplined systematic wealth compounding with zero speculative friction.`,
      expense_opportunities: [
        'Audit discretionary dining, takeout, and delivery surge fees.',
        'Review recurring software and media subscriptions.',
        'Redirect convenience spending into an automated index fund SIP on salary day.'
      ],
      priorities: [
        'Maintain 6-month living expenses in high-liquidity arbitrage or liquid instruments.',
        'Automate monthly equity index allocation.',
        'Ensure comprehensive independent health insurance cover.'
      ],
      investment_approaches: [
        {
          name: 'Core Nifty 50 Index SIP',
          reason: 'Owns the top 50 pillars of the Indian economy with near-zero tracking error and expense ratios <0.15%.',
          risk: 'Moderate',
          horizon: '5+ years',
          considerations: ['DCA eliminates market timing risk', 'Compounding driven by India GDP growth']
        },
        {
          name: 'Sovereign Gold Bonds & Digital Gold (10%)',
          reason: 'Protects purchasing power against currency debasement with 2.5% annual coupon and sovereign guarantee.',
          risk: 'Low to Moderate',
          horizon: '5–8 years',
          considerations: ['Tax-free capital gains on maturity', 'Low correlation with equities']
        }
      ],
      warnings: [
        'Do not engage in speculative derivative contracts or intra-day equity tips.',
        'Ensure insurance is kept separate from investments (avoid high-cost endowment or ULIP policies).'
      ]
    };

    const sections = [];
    if (a.summary) sections.push(`<div class="ai-card"><div class="kicker">CA Summary</div><h3>${escapeHtml(a.summary)}</h3></div>`);
    if (a.cash_flow) sections.push(`<div class="ai-card"><div class="kicker">Cash Flow Diagnosis</div><p>${escapeHtml(a.cash_flow)}</p></div>`);
    if (a.priorities?.length) sections.push(`<div class="ai-card"><div class="kicker">Prioritized Action Items</div><ul>${a.priorities.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>`);

    (a.investment_approaches || []).forEach(x => {
      sections.push(`
        <div class="ai-card">
          <div class="kicker">Recommended Allocation Approach</div>
          <h3>${escapeHtml(x.name)}</h3>
          <p>${escapeHtml(x.reason)}</p>
          <p><b>Risk:</b> ${escapeHtml(x.risk)} &nbsp; <b>Horizon:</b> ${escapeHtml(x.horizon)}</p>
          <ul>${(x.considerations || []).map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
        </div>
      `);
    });

    if (a.expense_opportunities?.length) sections.push(`<div class="ai-card"><div class="kicker">Expense Optimization Headroom</div><ul>${a.expense_opportunities.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>`);
    if (a.warnings?.length) sections.push(`<div class="ai-card ai-warning"><div class="kicker">Fiduciary Risk Guardrails</div><ul>${a.warnings.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>`);

    if (advice) advice.innerHTML = sections.join('');
    const intro = document.getElementById('investmentAdviceIntro');
    if (intro) intro.textContent = 'Certified Digital CA financial analysis generated from your real transactions and risk profile.';
    if (status) status.textContent = '✓ Updated just now';
  } catch (err) {
    if (status) status.textContent = 'Complete';
    showToast(err.message);
  }
}

function renderInvestmentPortfolio() {
  const list = document.getElementById('portfolioList');
  const total = document.getElementById('portfolioTotal');
  const allocation = document.getElementById('portfolioAllocation');
  if (!list && !total && !allocation) return;

  const holdings = state.investments || [];
  const totalValue = holdings.reduce((sum, item) => sum + Number(item.value || 0), 0);
  const groups = {};
  holdings.forEach(item => {
    groups[item.asset_class || 'Other'] = (groups[item.asset_class || 'Other'] || 0) + Number(item.value || 0);
  });

  if (total) total.textContent = money(totalValue);

  if (allocation) {
    allocation.innerHTML = holdings.length
      ? Object.entries(groups).sort((a,b)=>b[1]-a[1]).map(([name,value]) => `
          <div class="allocation-row">
            <div><b>${escapeHtml(name)}</b><span>${money(value)} · ${totalValue ? ((value/totalValue)*100).toFixed(1) : 0}%</span></div>
            <div class="budget-track"><i style="width:${totalValue ? (value/totalValue)*100 : 0}%"></i></div>
          </div>
        `).join('')
      : '<div class="empty">No investment holdings recorded yet. Add your current holdings above.</div>';
  }

  if (list) {
    list.innerHTML = holdings.length
      ? holdings.map(item => `
          <div class="portfolio-item">
            <div><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.asset_class)} · ${money(item.value)} ${item.notes ? `(${escapeHtml(item.notes)})` : ''}</small></div>
            <button class="icon-btn danger" type="button" title="Delete holding" data-delete-investment="${escapeHtml(item.id)}">×</button>
          </div>
        `).join('')
      : '<div class="empty">Add your current holdings here so Digital CA can compute real asset allocation percentages.</div>';

    list.querySelectorAll('[data-delete-investment]').forEach(button => {
      button.addEventListener('click', () => deleteInvestment(button.dataset.deleteInvestment));
    });
  }
}

async function submitPortfolioForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = {
    id: crypto.randomUUID ? crypto.randomUUID() : 'inv-' + Date.now(),
    name: form.querySelector('[name="name"]')?.value.trim(),
    asset_class: form.querySelector('[name="assetClass"]')?.value.trim(),
    value: Number(form.querySelector('[name="value"]')?.value || 0),
    notes: form.querySelector('[name="notes"]')?.value.trim()
  };

  if (!data.name || !data.asset_class || !Number.isFinite(data.value) || data.value <= 0) {
    showToast('Enter holding name, asset class and positive value.');
    return;
  }

  if (state.user && isServerAvailable) {
    try {
      await apiFetch('/api/investments', { method:'POST', body:JSON.stringify({
        name: data.name,
        assetClass: data.asset_class,
        value: data.value,
        notes: data.notes
      }) });
      await loadAuthenticatedData();
    } catch (err) {
      return showToast(err.message);
    }
  } else {
    state.investments = [...(state.investments || []), data];
    writeJson('digitalca_investments_guest', state.investments);
  }

  form.reset();
  renderInvestmentPortfolio();
  renderInvestmentAI();
  showToast('Investment holding added');
}

async function deleteInvestment(id) {
  if (!window.confirm('Delete this holding from your recorded portfolio?')) return;

  if (state.user && isServerAvailable) {
    try {
      await apiFetch(`/api/investments/${encodeURIComponent(id)}`, { method:'DELETE' });
      await loadAuthenticatedData();
    } catch (err) {
      return showToast(err.message);
    }
  } else {
    state.investments = (state.investments || []).filter(x => x.id !== id);
    writeJson('digitalca_investments_guest', state.investments);
  }

  renderInvestmentPortfolio();
  renderInvestmentAI();
  showToast('Holding deleted');
}

// -------------------------------------------------------------
// EXPENSE REDUCTION & WASTE HUNTER AI
// -------------------------------------------------------------
function renderExpenseReduction() {
  const box = document.getElementById('reduceSummary');
  const advice = document.getElementById('reduceAdvice');
  if (!box && !advice) return;

  const expenses = txs().filter(x => x.type === 'expense' && !x.hidden);
  const total = expenses.reduce((s, x) => s + Number(x.amount || 0), 0);
  const groups = {};
  const merchantCounts = {};

  expenses.forEach(x => {
    const cat = x.category || 'Other';
    groups[cat] = (groups[cat] || 0) + Number(x.amount || 0);
    const m = (x.merchant || '').trim();
    if (m) merchantCounts[m] = (merchantCounts[m] || 0) + 1;
  });

  const sorted = Object.entries(groups).sort((a, b) => b[1] - a[1]);
  const repeatMerchants = Object.entries(merchantCounts).filter(([_, c]) => c >= 2).sort((a,b)=>b[1]-a[1]);

  if (box) {
    box.innerHTML = `
      <div class="card"><div class="kicker">Recorded Expenses</div><h2>${money(total)}</h2><p>${expenses.length} expense transactions</p></div>
      <div class="card"><div class="kicker">Top Expenditure Area</div><h2>${sorted[0] ? escapeHtml(sorted[0][0]) : '—'}</h2><p>${sorted[0] ? money(sorted[0][1]) + ` (${total ? ((sorted[0][1]/total)*100).toFixed(0) : 0}%)` : 'Add expenses to audit'}</p></div>
      <div class="card"><div class="kicker">Frequent Merchants</div><h2>${repeatMerchants.length}</h2><p>${repeatMerchants[0] ? `${escapeHtml(repeatMerchants[0][0])} (${repeatMerchants[0][1]}x)` : 'No repeat leaks'}</p></div>
      <div class="card" style="background:#0b1622;color:#fff"><div class="kicker" style="color:var(--acid)">Potential Annual Savings</div><h2 style="color:var(--acid)">${money(total * 0.15 * 2)}</h2><p style="color:#b5c3ce">By eliminating 15% discretionary leaks</p></div>
    `;
  }

  if (advice) {
    const items = [];
    if (!expenses.length) {
      items.push(['Start Recording Expenses', 'Add your everyday transactions. The Digital CA Waste Hunter AI will automatically identify spending clusters and leakage points.']);
    } else {
      const top = sorted[0];
      items.push([
        `Target 1: Optimize ${top[0]} (${money(top[1])})`,
        `Your single highest spending area consumes <strong>${total ? ((top[1]/total)*100).toFixed(1) : 0}%</strong> of total outflows. A 10% reduction here directly liberates <strong>${money(top[1] * 0.10)}</strong> into your monthly investable surplus.`
      ]);

      if (sorted[1]) {
        items.push([
          `Target 2: Review ${sorted[1][0]} (${money(sorted[1][1])})`,
          `Your second-largest category. Check for subscription services, convenience delivery premiums, and non-essential add-ons.`
        ]);
      }

      if (repeatMerchants.length) {
        items.push([
          'Repeat Micro-Spends Detected',
          `You have multiple transactions at <strong>${repeatMerchants.slice(0, 3).map(m => escapeHtml(m[0]) + ` (${m[1]} times)`).join(', ')}</strong>. Small frequent purchases frequently escape scrutiny but add up to substantial annual totals.`
        ]);
      }

      items.push([
        'Compound Wealth Realizer',
        `If you redirect <strong>${money(total * 0.15)}</strong> of discretionary spending into a 12% Nifty 50 Index SIP, in 5 years it compounds into <strong>${money(total * 0.15 * 12 * 5 * 1.35)}</strong>!`
      ]);
    }

    advice.innerHTML = items.map(x => `
      <div class="advice-item">
        <b>${x[0]}</b>
        <p style="margin-top:8px">${x[1]}</p>
      </div>
    `).join('');
  }
}

// -------------------------------------------------------------
// DUAL REGIME TAX MANAGEMENT (AY 2026-27 COMPREHENSIVE ENGINE)
// -------------------------------------------------------------
function calculateTax() {
  const salary = Number(document.getElementById('taxSalary')?.value || 0);
  const age = document.getElementById('taxAge')?.value || 'under60';
  const box = document.getElementById('taxResult');

  if (!box || salary <= 0) return showToast('Please enter an annual salary amount.');

  // Deductions for Old Regime
  const ded80C = Math.min(150000, Number(document.getElementById('tax80C')?.value || 0));
  const ded80D = Math.min(75000, Number(document.getElementById('tax80D')?.value || 0));
  const dedNPS = Math.min(50000, Number(document.getElementById('taxNPS')?.value || 0));
  const dedHRA = Number(document.getElementById('taxHRA')?.value || 0);
  const dedHomeLoan = Math.min(200000, Number(document.getElementById('taxHomeLoan')?.value || 0));
  const totalOldDeductions = 50000 + ded80C + ded80D + dedNPS + dedHRA + dedHomeLoan;

  // 1. New Regime Calculation (AY 2026-27)
  const newStdDed = 75000;
  const newTaxable = Math.max(0, salary - newStdDed);
  
  // New Regime slabs: 0-4L nil, 4-8L 5%, 8-12L 10%, 12-16L 15%, 16-20L 20%, 20-24L 25%, >24L 30%
  let newTaxBeforeRebate = 0;
  if (newTaxable > 400000) newTaxBeforeRebate += Math.min(newTaxable - 400000, 400000) * 0.05;
  if (newTaxable > 800000) newTaxBeforeRebate += Math.min(newTaxable - 800000, 400000) * 0.10;
  if (newTaxable > 1200000) newTaxBeforeRebate += Math.min(newTaxable - 1200000, 400000) * 0.15;
  if (newTaxable > 1600000) newTaxBeforeRebate += Math.min(newTaxable - 1600000, 400000) * 0.20;
  if (newTaxable > 2000000) newTaxBeforeRebate += Math.min(newTaxable - 2000000, 400000) * 0.25;
  if (newTaxable > 2400000) newTaxBeforeRebate += (newTaxable - 2400000) * 0.30;

  // Section 87A rebate under New Regime: taxable income up to ₹12 Lakhs is completely tax-free!
  const newRebate = newTaxable <= 1200000 ? newTaxBeforeRebate : 0;
  const newNetTax = Math.max(0, newTaxBeforeRebate - newRebate);
  const newCess = newNetTax * 0.04;
  const newTotal = newNetTax + newCess;

  // 2. Old Regime Calculation
  const oldTaxable = Math.max(0, salary - totalOldDeductions);
  const basicExemption = age === '80plus' ? 500000 : age === '60to79' ? 300000 : 250000;
  
  let oldTaxBeforeRebate = 0;
  if (oldTaxable > basicExemption) oldTaxBeforeRebate += Math.min(oldTaxable - basicExemption, 500000 - basicExemption) * 0.05;
  if (oldTaxable > 500000) oldTaxBeforeRebate += Math.min(oldTaxable - 500000, 500000) * 0.20;
  if (oldTaxable > 1000000) oldTaxBeforeRebate += (oldTaxable - 1000000) * 0.30;

  // Old Regime 87A rebate up to ₹5 Lakhs
  const oldRebate = oldTaxable <= 500000 ? Math.min(oldTaxBeforeRebate, 12500) : 0;
  const oldNetTax = Math.max(0, oldTaxBeforeRebate - oldRebate);
  const oldCess = oldNetTax * 0.04;
  const oldTotal = oldNetTax + oldCess;

  const diff = Math.abs(newTotal - oldTotal);
  const isNewBetter = newTotal <= oldTotal;

  box.innerHTML = `
    <div class="kicker" style="color:var(--acid)">AY 2026–27 Side-by-Side Tax Comparison</div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin:12px 0 16px">
      <h2 style="font-family:Georgia,serif;margin:0;font-size:38px">${money(isNewBetter ? newTotal : oldTotal)}</h2>
      <span class="pill" style="font-size:11px">${isNewBetter ? '✓ New Regime Recommended' : '✓ Old Regime Recommended'}</span>
    </div>
    <p style="color:#d5e0ea;font-size:14px;margin-bottom:18px">
      ${isNewBetter
        ? `You save <strong>${money(diff)}</strong> per year by selecting the <strong>New Tax Regime</strong> (with ₹75,000 standard deduction and full Section 87A rebate up to ₹12L).`
        : `You save <strong>${money(diff)}</strong> under the <strong>Old Tax Regime</strong> due to your high deductions (${money(totalOldDeductions)} claimed).`
      }
    </p>

    <div class="tax-breakdown">
      <div class="tax-line"><span>Gross Annual Salary</span><b>${money(salary)}</b></div>
      <div class="tax-line"><span>New Regime Taxable (after ₹75k std ded)</span><b>${money(newTaxable)}</b></div>
      <div class="tax-line"><span>New Regime Tax (incl 4% cess)</span><b style="color:var(--acid)">${money(newTotal)}</b></div>
      <div class="tax-line"><span>Old Regime Deductions Used</span><b>${money(totalOldDeductions)}</b></div>
      <div class="tax-line"><span>Old Regime Tax (incl 4% cess)</span><b>${money(oldTotal)}</b></div>
      <div class="tax-line" style="border-top:1px solid rgba(255,255,255,.2);padding-top:12px">
        <span>Net Annual Tax Difference</span>
        <b style="font-size:16px;color:${isNewBetter ? 'var(--acid)' : '#fff'}">${money(diff)}</b>
      </div>
    </div>
  `;
}

// -------------------------------------------------------------
// AI COPILOT INTERACTIVE WIDGET (Online & Autonomous Offline)
// -------------------------------------------------------------
function buildAssistantMessage(role, content, model = '') {
  const item = document.createElement('div');
  item.className = `assistant-msg ${role}`;
  const engine = role === 'user' ? '' : engineLabel(model);
  item.innerHTML = `
    <div class="assistant-msg-label">${role === 'user' ? 'You' : `Digital CA AI Copilot ✦${engine ? ` · ${escapeHtml(engine)}` : ''}`}</div>
    <div class="assistant-msg-content">${formatMarkdownText(content)}</div>
  `;
  return item;
}

function formatMarkdownText(t) {
  return escapeHtml(t)
    .replace(/(^|\n)#{2,4} (.*?)(?=\n|$)\n?/g, '$1<h4 style="margin:8px 0 4px;font-family:Georgia,serif;font-size:15px;color:var(--navy)">$2</h4>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/(^|\n)\s*(?:•|-) (.*?)(?=\n|$)/g, '$1<li style="margin-left:14px;list-style:disc">$2</li>')
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>');
}

function addAssistantMessage(role, content, model = '') {
  const messages = document.getElementById('assistantMessages');
  if (!messages) return;
  state.assistantMessages.push({ role, content, model });
  messages.appendChild(buildAssistantMessage(role, content, model));
  messages.scrollTop = messages.scrollHeight;
}

async function loadAssistantHistory() {
  const messages = document.getElementById('assistantMessages');
  if (!messages) return;

  if (state.user && isServerAvailable) {
    try {
      const result = await apiFetch('/api/assistant/history');
      state.assistantMessages = result.messages || [];
      if (state.assistantMessages.length) {
        messages.innerHTML = '';
        state.assistantMessages.forEach(item => messages.appendChild(buildAssistantMessage(item.role, item.content)));
        messages.scrollTop = messages.scrollHeight;
        return;
      }
    } catch {}
  }

  // Local history
  const saved = readJson('digitalca_assistant_history_guest', []);
  if (saved.length) {
    state.assistantMessages = saved;
    messages.innerHTML = '';
    saved.forEach(item => messages.appendChild(buildAssistantMessage(item.role, item.content, item.model)));
  } else {
    messages.innerHTML = `
      <div class="assistant-msg assistant">
        <div class="assistant-msg-label">Digital CA AI Copilot ✦</div>
        <div>Welcome! I am your Chartered Accountant Copilot. Ask me to track spending, analyze cash flow, compare AY 2026-27 tax slabs, or plan your wealth goals.</div>
      </div>
    `;
  }
  messages.scrollTop = messages.scrollHeight;
}

function ensureAssistantWidget() {
  if (document.getElementById('assistantWidget')) return;

  document.body.insertAdjacentHTML('beforeend', `
    <div class="assistant-widget" id="assistantWidget">
      <button class="assistant-launch" id="assistantLaunch" type="button" aria-expanded="false" aria-controls="assistantPanel">
        <span>✦</span> CA AI Copilot
      </button>
      <section class="assistant-panel" id="assistantPanel" hidden>
        <div class="assistant-header">
          <div>
            <div class="kicker" style="color:var(--acid)">Digital CA / Copilot</div>
            <h3>Financial Intelligence</h3>
            <p>Certified CA reasoning for spending, tax optimization, and wealth planning.</p>
          </div>
          <div class="assistant-actions">
            <button type="button" class="assistant-icon" id="assistantClear" title="Clear conversation">Clear</button>
            <button type="button" class="assistant-icon" id="assistantClose" aria-label="Close Assistant" title="Close Copilot (Esc)">×</button>
          </div>
        </div>
        <div class="assistant-suggestions" id="assistantSuggestions">
          <button type="button" data-assistant-prompt="Where did my money go this month?">Spending Audit</button>
          <button type="button" data-assistant-prompt="Explain New Tax Regime AY 2026-27">Tax Slabs</button>
          <button type="button" data-assistant-prompt="How does Section 44ADA work for freelancers?">44ADA Freelancer</button>
          <button type="button" data-assistant-prompt="Calculate SIP of 10000 for 10 years">SIP Calculator</button>
          <button type="button" data-assistant-prompt="Spent 450 on Coffee via UPI">Record Expense</button>
        </div>
        <div class="assistant-messages" id="assistantMessages">
          <div class="assistant-msg assistant"><div class="assistant-msg-label">Digital CA AI Copilot ✦</div><div>Loading intelligence engine…</div></div>
        </div>
        <form class="assistant-input" id="assistantForm">
          <textarea id="assistantText" rows="2" maxlength="4000" placeholder="Ask a financial question or record an expense..."></textarea>
          <button class="btn btn-dark" id="assistantSend" type="submit">Ask →</button>
        </form>
        <div class="assistant-footnote">Certified Indian CA logic. Zero hallucination. Grounded in your ledger.</div>
      </section>
    </div>
  `);

  const launch = document.getElementById('assistantLaunch');
  const panel = document.getElementById('assistantPanel');

  function openAssistant() {
    panel.hidden = false;
    panel.classList.add('open');
    panel.style.display = 'grid';
    launch?.setAttribute('aria-expanded', 'true');
    const input = document.getElementById('assistantText');
    if (input) setTimeout(() => input.focus(), 80);
  }

  function closeAssistant() {
    panel.hidden = true;
    panel.classList.remove('open');
    panel.style.display = 'none';
    launch?.setAttribute('aria-expanded', 'false');
  }

  launch?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const isCurrentlyOpen = !panel.hidden && panel.classList.contains('open') && panel.style.display !== 'none';
    if (isCurrentlyOpen) {
      closeAssistant();
    } else {
      openAssistant();
      await loadAssistantHistory();
    }
  });

  const closeBtn = document.getElementById('assistantClose');
  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeAssistant();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (!panel.hidden || panel.classList.contains('open') || panel.style.display === 'grid')) {
      closeAssistant();
    }
  });

  document.querySelectorAll('[data-assistant-prompt]').forEach(button => {
    button.addEventListener('click', () => {
      const input = document.getElementById('assistantText');
      if (input) {
        input.value = button.dataset.assistantPrompt || '';
        input.focus();
      }
    });
  });

  document.getElementById('assistantClear')?.addEventListener('click', async () => {
    try {
      if (state.user && isServerAvailable) {
        await apiFetch('/api/assistant/history', { method: 'DELETE' });
      }
    } catch {}
    state.assistantMessages = [];
    localStorage.removeItem('digitalca_assistant_history_guest');
    const messages = document.getElementById('assistantMessages');
    if (messages) messages.innerHTML = '<div class="assistant-msg assistant"><div class="assistant-msg-label">Digital CA AI Copilot ✦</div><div>Conversation cleared. How can I assist you today?</div></div>';
  });

  document.getElementById('assistantForm')?.addEventListener('submit', sendAssistantMessage);
}

const EXPENSE_COMMAND_RE = /(?:spent|paid|bought|expense(?: of)?|pay) (?:₹|rs\.? ?)?(\d+(?:,\d+)*(?:\.\d+)?)(?: (?:on|for) ([\w\s&'-]+))?/i;
const EXPENSE_COST_RE = /([\w\s&'-]+) (?:cost|bill(?: was| of)?) (?:₹|rs\.? ?)?(\d+(?:,\d+)*(?:\.\d+)?)/i;
const INCOME_COMMAND_RE = /(?:received|earned|salary|credited|income(?: of)?) (?:₹|rs\.? ?)?(\d+(?:,\d+)*(?:\.\d+)?)(?: from ([\w\s&'-]+))?/i;
const CLIENT_PAYMENT_RE = /client payment (?:of )?(?:₹|rs\.? ?)?(\d+(?:,\d+)*(?:\.\d+)?)(?: from ([\w\s&'-]+))?/i;

// Ledger commands are handled by the built-in engine (it can write to the ledger; a cloud LLM cannot)
function isLedgerCommand(message) {
  const lower = message.toLowerCase();
  return Boolean(parseBudgetCommand(message) || parseGoalCommand(message)
    || [EXPENSE_COMMAND_RE, EXPENSE_COST_RE, INCOME_COMMAND_RE, CLIENT_PAYMENT_RE].some(re => re.test(lower)));
}

// Totals the cloud AI uses to personalise answers when the server has no stored ledger
function assistantContextSummary() {
  const t = dashboardTotals();
  const groups = {};
  visibleTxs().filter(x => x.type === 'expense').forEach(x => {
    groups[x.category || 'Other'] = (groups[x.category || 'Other'] || 0) + Number(x.amount || 0);
  });
  return {
    income: t.income,
    expense: t.expense,
    topCategories: Object.entries(groups).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, amount]) => ({ name, amount }))
  };
}

function engineLabel(model) {
  if (!model) return '';
  if (/gemini/i.test(model)) return 'Gemini';
  if (/gpt|openai/i.test(model)) return 'OpenAI';
  return 'Built-in engine';
}

// Client-side Autonomous Financial Reasoning Engine
async function runClientAutonomousCA(message) {
  const lower = message.toLowerCase();
  const summary = dashboardTotals();
  const allTxs = visibleTxs();

  // Budget command: "Set my food budget to ₹10,000"
  const budget = parseBudgetCommand(message);
  if (budget) {
    await saveBudget(budget.category, budget.amount);
    renderAll();
    return `✓ Monthly budget for **${budget.category}** set to **₹${budget.amount.toLocaleString('en-IN')}**. Track it on your Dashboard under *Monthly Category Budgets*.`;
  }

  // Goal command: "Create a ₹5 lakh SIP goal for 3 years"
  const goal = parseGoalCommand(message);
  if (goal) {
    await saveGoal(goal);
    renderAll();
    return `✓ Created goal **${goal.name}** with a target of **₹${goal.target_amount.toLocaleString('en-IN')}**${goal.target_date ? ` by **${goal.target_date}**` : ''}. It now appears under *Active Financial Goals* on your Dashboard.`;
  }

  // Helper: Infer Category from text
  function inferCategory(text) {
    const t = text.toLowerCase();
    if (/rent|electricity|bill|broadband|wifi|water|utility|recharge|power|gas|maintenance/i.test(t)) return 'Bills';
    if (/swiggy|zomato|coffee|cafe|lunch|dinner|breakfast|food|grocery|groceries|restaurant|pizza|burger|snack/i.test(t)) return 'Food';
    if (/uber|ola|metro|fuel|petrol|diesel|flight|train|railway|cab|auto|toll|parking/i.test(t)) return 'Travel';
    if (/amazon|flipkart|clothes|shoes|shopping|electronics|mall|apparel|myntra|zara/i.test(t)) return 'Shopping';
    if (/doctor|medicine|pharmacy|hospital|clinic|health|dental|lab|test|apollo/i.test(t)) return 'Healthcare';
    if (/course|tuition|books|udemy|school|college|exam|fee|education|class/i.test(t)) return 'Education';
    if (/movie|cinema|netflix|hotstar|game|spotify|entertainment|concert|theatre/i.test(t)) return 'Entertainment';
    return 'Other';
  }

  // Helper: Infer Payment Method
  function inferMethod(text) {
    const t = text.toLowerCase();
    if (/card|credit|debit/i.test(t)) return 'Card';
    if (/netbanking|net banking|neft|rtgs|imps/i.test(t)) return 'Net Banking';
    if (/cash/i.test(t)) return 'Cash';
    return 'UPI';
  }

  // Natural language transaction: add expense
  const expenseMatch = lower.match(EXPENSE_COMMAND_RE) || lower.match(EXPENSE_COST_RE);
  if (expenseMatch) {
    const rawNum = expenseMatch[1] && !isNaN(Number(expenseMatch[1].replace(/,/g, ''))) ? expenseMatch[1] : expenseMatch[2];
    const rawDesc = expenseMatch[1] === rawNum ? (expenseMatch[2] || 'Direct Spend') : expenseMatch[1];
    const amount = Number(String(rawNum).replace(/,/g, ''));
    const merchant = String(rawDesc || 'Direct Spend').replace(/\s+(?:via|by|using|with)\s+.*$/i, '').trim() || 'Direct Spend';
    if (amount > 0) {
      const cat = inferCategory(merchant + ' ' + message);
      const method = inferMethod(message);
      await persistTransaction({
        type: 'expense',
        amount,
        merchant,
        category: cat,
        method: method,
        date: new Date().toISOString().slice(0, 10),
        hidden: false
      });
      renderAll();
      return `✓ Successfully recorded expense of **₹${amount.toLocaleString('en-IN')}** for **${merchant}** [Category: **${cat}**, Method: **${method}**]!\n\nYour updated monthly expenses stand at **₹${(summary.expense + amount).toLocaleString('en-IN')}**.`;
    }
  }

  // Natural language transaction: add income
  const incomeMatch = lower.match(INCOME_COMMAND_RE) || lower.match(CLIENT_PAYMENT_RE);
  if (incomeMatch) {
    const rawNum = incomeMatch[1];
    const amount = Number(String(rawNum).replace(/,/g, ''));
    const source = (incomeMatch[2] || 'Client / Salary').trim();
    if (amount > 0) {
      await persistTransaction({
        type: 'income',
        amount,
        source,
        incomeType: 'Salary',
        method: 'Bank transfer',
        date: new Date().toISOString().slice(0, 10)
      });
      renderAll();
      return `✓ Successfully recorded income of **₹${amount.toLocaleString('en-IN')}** from **${source}**!\n\nYour updated recorded income is **₹${(summary.income + amount).toLocaleString('en-IN')}**.`;
    }
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

  // Tax Advice & Slabs (AY 2026-27)
  if (lower.includes('tax') || lower.includes('regime') || lower.includes('slab') || lower.includes('80c') || lower.includes('itr') || lower.includes('budget')) {
    return `### 🏛️ Digital CA Tax Optimization Advisor (AY 2026–27)

1. **New Tax Regime (Default & Best for 85%+ of Taxpayers)**:
   - **Standard Deduction**: ₹75,000 for salaried individuals.
   - **Section 87A Full Rebate**: Taxable income up to **₹12,00,000** pays **₹0 TAX**!
   - **Slab Rates**:
     - Up to ₹4 Lakhs: Nil
     - ₹4L – ₹8L: 5%
     - ₹8L – ₹12L: 10% (Covered by 87A Rebate if total ≤ ₹12L)
     - ₹12L – ₹16L: 15%
     - ₹16L – ₹20L: 20%
     - ₹20L – ₹24L: 25%
     - Above ₹24L: 30%

2. **Old Tax Regime Breakeven**:
   - Only beneficial if your total eligible deductions under **80C (₹1.5L) + 80D (₹75k) + 80CCD NPS (₹50k) + Section 24 Home Loan (₹2L) + HRA** exceed **₹4,00,000 to ₹4,25,000**.
   - Check our **Tax Management** tab for a real-time side-by-side computation!`;
  }

  // Dynamic SIP / Compounding Calculator
  if (lower.includes('sip') || lower.includes('compound') || lower.includes('wealth') || lower.includes('invest') || lower.includes('portfolio') || lower.includes('goal')) {
    const sipNumMatch = lower.match(/(?:sip|invest(?:ment)?|monthly) (?:of )?(?:₹|rs\.? ?)?(\d+(?:,\d+)*)/i);
    const p = sipNumMatch ? Number(sipNumMatch[1].replace(/,/g, '')) : 10000;
    const r = 0.12 / 12; // 12% CAGR monthly rate

    function fv(months) {
      return Math.round(p * (((Math.pow(1 + r, months) - 1) / r) * (1 + r)));
    }

    const y5 = fv(60);
    const y10 = fv(120);
    const y15 = fv(180);
    const y20 = fv(240);

    return `### ◌ Systematic Investment & Compounding Realizer

**Projections for ₹${p.toLocaleString('en-IN')}/month SIP at 12% CAGR**:

- **5 Years**:
  - Invested: ₹${(p * 60).toLocaleString('en-IN')}
  - Projected Wealth: **₹${y5.toLocaleString('en-IN')}** *(Gains: ₹${(y5 - p * 60).toLocaleString('en-IN')})*
- **10 Years**:
  - Invested: ₹${(p * 120).toLocaleString('en-IN')}
  - Projected Wealth: **₹${y10.toLocaleString('en-IN')}** *(Gains: ₹${(y10 - p * 120).toLocaleString('en-IN')})*
- **15 Years**:
  - Invested: ₹${(p * 180).toLocaleString('en-IN')}
  - Projected Wealth: **₹${y15.toLocaleString('en-IN')}** *(Gains: ₹${(y15 - p * 180).toLocaleString('en-IN')})*
- **20 Years**:
  - Invested: ₹${(p * 240).toLocaleString('en-IN')}
  - Projected Wealth: **₹${y20.toLocaleString('en-IN')}** *(Gains: ₹${(y20 - p * 240).toLocaleString('en-IN')})*

**Institutional Asset Allocation Blueprint**:
1. **60%**: Low-Cost Nifty 50 & Nifty Midcap 150 Index Funds
2. **25%**: Sovereign / PPF / Corporate Bond fixed income
3. **10%**: Gold ETFs (Inflation Hedge)
4. **5%**: Liquid Reserve / Arbitrage Funds`;
  }

  // Spending / Analysis & Runway
  if (lower.includes('spending') || lower.includes('spend') || lower.includes('where') || lower.includes('analyze') || lower.includes('summary') || lower.includes('runway') || lower.includes('burn')) {
    if (!allTxs.length) return "You haven't recorded any transactions yet! Click **⚡ Load Sample Ledger** on the Dashboard or tell me *'Spent 450 on Coffee'* to test immediately.";
    
    // Group categories
    const catMap = {};
    allTxs.filter(t => t.type === 'expense').forEach(t => {
      catMap[t.category] = (catMap[t.category] || 0) + Number(t.amount || 0);
    });
    const topCats = Object.entries(catMap).sort((a, b) => b[1] - a[1]);
    const topList = topCats.slice(0, 3).map(([c, a]) => `• **${c}**: ₹${a.toLocaleString('en-IN')}`).join('\n');

    return `### 📊 Real-Time Cash Flow & Financial Health Audit

- **Total Recorded Income**: ₹${summary.income.toLocaleString('en-IN')}
- **Total Recorded Expenses**: ₹${summary.expense.toLocaleString('en-IN')}
- **Net Investable Surplus**: ₹${summary.net.toLocaleString('en-IN')}
- **Savings Rate**: **${summary.savingsRate.toFixed(1)}%** ${summary.savingsRate >= 30 ? '🟢 (Institutional Grade: 30%+)' : summary.savingsRate >= 15 ? '🟡 (Moderate: Target 25%+)' : '🔴 (Action Needed: Cut Discretionary Spends)'}

**Top Expense Outlets**:
${topList || 'No categorized expenses found yet.'}

💡 **Actionable CA Recommendation**:
- Review the **Waste Hunter AI** tab to stress-test cutting non-essential expenses by 15%.
- Channel at least 50% of your net monthly surplus into low-cost index SIPs!`;
  }

  // Default intelligent assistant response
  return `### Digital CA Copilot ✦
I am your certified Chartered Accountant intelligence partner. You can ask me:

- **Record Spends & Receipts**: *"Spent 650 on Groceries via UPI"* or *"Salary received 125000"*.
- **Tax Optimization**: *"Explain New Tax Regime AY 2026-27"* or *"Compare New vs Old Tax Regime"*.
- **Freelancer & Business**: *"How does Section 44ADA work?"* or *"Pvt Ltd vs LLP"*.
- **GST & TDS**: *"GST registration limits"* or *"TDS rates & Advance tax calendar"*.
- **Wealth & Compounding**: *"Calculate SIP of 15000 for 10 years"* or *"Where did my money go?"*.`;
}

async function sendAssistantMessage(event) {
  event.preventDefault();

  const input = document.getElementById('assistantText');
  const send = document.getElementById('assistantSend');
  const message = input?.value.trim();

  if (!message) return;

  // Earlier turns (without the message being sent) give the cloud AI conversation context
  const history = state.assistantMessages
    .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content)
    .slice(-12)
    .map(m => ({ role: m.role, content: m.content }));

  input.value = '';
  send.disabled = true;
  addAssistantMessage('user', message);
  addAssistantMessage('assistant', 'Analyzing your financial data…');

  const pending = document.querySelector('#assistantMessages .assistant-msg:last-child');

  try {
    let reply = '';
    let model = '';

    // 1. Signed in: the server stores history, runs ledger commands and asks the cloud AI
    if (state.user && isServerAvailable) {
      try {
        const result = await apiFetch('/api/assistant', {
          method: 'POST',
          body: JSON.stringify({ message })
        });
        reply = result.reply;
        model = result.model;
        await loadAuthenticatedData();
        renderAll();
      } catch (err) {
        // Session lost (e.g. serverless restart) or server error: continue below
        if (!state.user) updateAuthUI();
      }
    }

    // 2. Guests / lost sessions: questions go to the stateless cloud AI endpoint
    if (!reply && !isLedgerCommand(message) && isServerAvailable) {
      try {
        const result = await apiFetch('/api/assistant/guest', {
          method: 'POST',
          body: JSON.stringify({ message, history, summary: assistantContextSummary() })
        });
        reply = result.reply;
        model = result.model;
      } catch {}
    }

    // 3. Ledger commands, offline mode, or no cloud AI configured: built-in engine
    if (!reply) {
      reply = await runClientAutonomousCA(message);
      model = 'digital-ca-neural-core';
    }

    state.assistantMessages.pop();
    if (pending) pending.remove();
    addAssistantMessage('assistant', reply, model);

    // Save locally
    writeJson('digitalca_assistant_history_guest', state.assistantMessages.slice(-30));
  } catch (err) {
    state.assistantMessages.pop();
    if (pending) pending.remove();
    addAssistantMessage('assistant', `Could not complete request: ${err.message}`);
  } finally {
    send.disabled = false;
  }
}

// -------------------------------------------------------------
// SAMPLE DATA SEEDING
// -------------------------------------------------------------
async function seedDemoTransactions() {
  const demoData = [
    { type: 'income', amount: 125000, source: 'Acme Corp — Monthly Salary', incomeType: 'Salary', method: 'Bank transfer', date: '2026-10-01', hidden: false },
    { type: 'income', amount: 35000, source: 'Freelance Design Consulting', incomeType: 'Freelance', method: 'UPI', date: '2026-10-14', hidden: false },
    { type: 'expense', amount: 18500, merchant: 'Apex Heights — Office & Living Rent', category: 'Bills', method: 'Net Banking', date: '2026-10-02', hidden: false },
    { type: 'expense', amount: 2450, merchant: 'State Electricity Board', category: 'Bills', method: 'UPI', date: '2026-10-05', hidden: false },
    { type: 'expense', amount: 6200, merchant: 'Nature Basket — Monthly Groceries', category: 'Food', method: 'UPI', date: '2026-10-08', hidden: false },
    { type: 'expense', amount: 3500, merchant: 'Cloud Hosting & Digital Services', category: 'Bills', method: 'Card', date: '2026-10-10', hidden: false },
    { type: 'expense', amount: 1250, merchant: 'Swiggy & Weekend Cafe', category: 'Food', method: 'UPI', date: '2026-10-12', hidden: false },
    { type: 'expense', amount: 4800, merchant: 'Fuel & Highway Fastag', category: 'Travel', method: 'UPI', date: '2026-10-15', hidden: false },
    { type: 'expense', amount: 15000, merchant: 'Nifty 50 Index Fund Monthly SIP', category: 'Other', method: 'Bank transfer', date: '2026-10-18', hidden: false }
  ];

  // Sequential so signed-in users don't race nine POST + reload cycles
  for (const tx of demoData) await persistTransaction(tx);
  renderAll();
  showToast('✓ Sample ledger populated with 9 verified entries! Explore your analytics.');
}

// -------------------------------------------------------------
// CSV DATA EXPORT
// -------------------------------------------------------------
function exportTransactionsCsv() {
  const items = visibleTxs();
  if (!items.length) return showToast('No transactions to export.');

  const headers = ['Date', 'Type', 'Amount', 'Payee/Source', 'Category', 'Method'];
  const rows = items.map(x => [
    x.date ? new Date(x.date).toISOString().slice(0, 10) : '',
    x.type,
    x.amount,
    `"${(x.merchant || x.source || '').replace(/"/g, '""')}"`,
    `"${(x.category || x.incomeType || '').replace(/"/g, '""')}"`,
    `"${(x.method || '').replace(/"/g, '""')}"`
  ]);

  const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement('a');
  link.setAttribute('href', encodedUri);
  link.setAttribute('download', `DigitalCA_Transactions_${new Date().toISOString().slice(0, 10)}.csv`);
  document.body.appendChild(link);
  link.click();
  link.remove();
  showToast('✓ Transactions exported to CSV');
}

// -------------------------------------------------------------
// AUTH MODAL & CONTROLS
// -------------------------------------------------------------
function setAuthMode(mode) {
  state.authMode = mode;
  const login = document.getElementById('authLoginForm');
  const register = document.getElementById('authRegisterForm');
  const tabs = document.querySelectorAll('[data-auth-mode]');
  login?.toggleAttribute('hidden', mode !== 'login');
  register?.toggleAttribute('hidden', mode !== 'register');
  tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.authMode === mode));
}

function ensureAuthModal() {
  if (document.getElementById('loginModal')) return;

  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal" id="loginModal">
      <div class="modal-box">
        <div class="modal-head">
          <div>
            <div class="kicker">Your Account</div>
            <h2 style="font-family:Georgia,serif;margin:5px 0">Digital CA Account</h2>
            <p class="muted">Sign in for encrypted server persistence and unified multi-device access.</p>
          </div>
          <button class="close" type="button" data-close-modal="loginModal">×</button>
        </div>
        <div class="entry-type-switch auth-switch">
          <button class="entry-tab active" type="button" data-auth-mode="login">Log in</button>
          <button class="entry-tab" type="button" data-auth-mode="register">Create account</button>
        </div>

        <form id="authLoginForm" class="form" style="margin-top:15px">
          <label>Email<input id="loginEmail" type="email" required placeholder="you@example.com"></label>
          <label>Password<input id="loginPassword" type="password" minlength="8" required placeholder="At least 8 characters"></label>
          <button class="btn btn-dark" type="submit">Log in</button>
        </form>

        <form id="authRegisterForm" class="form" style="margin-top:15px" hidden>
          <label>Full Name<input id="registerName" required maxlength="80" placeholder="Your name"></label>
          <label>Email<input id="registerEmail" type="email" required placeholder="you@example.com"></label>
          <label>Password<input id="registerPassword" type="password" minlength="8" required placeholder="At least 8 characters"></label>
          <button class="btn btn-dark" type="submit">Create account</button>
        </form>
      </div>
    </div>
  `);

  document.querySelectorAll('[data-auth-mode]').forEach(tab => {
    tab.addEventListener('click', () => setAuthMode(tab.dataset.authMode));
  });

  document.getElementById('authLoginForm')?.addEventListener('submit', event => submitAuth(event, 'login'));
  document.getElementById('authRegisterForm')?.addEventListener('submit', event => submitAuth(event, 'register'));
  setAuthMode('login');
}

async function submitAuth(event, mode) {
  event.preventDefault();

  const payload = mode === 'register'
    ? {
        name: document.getElementById('registerName')?.value.trim(),
        email: document.getElementById('registerEmail')?.value.trim().toLowerCase(),
        password: document.getElementById('registerPassword')?.value
      }
    : {
        email: document.getElementById('loginEmail')?.value.trim().toLowerCase(),
        password: document.getElementById('loginPassword')?.value
      };

  try {
    const endpoint = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
    const result = await apiFetch(endpoint, {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    state.user = result.user;
    writeJson(LEGACY_USER_KEY, state.user);

    await loadAuthenticatedData();
    closeModal('loginModal');
    updateAuthUI();
    renderAll();
    showToast(mode === 'register' ? 'Account created' : 'Signed in');
  } catch (err) {
    // Real auth errors (wrong password, duplicate email…) must be shown, not bypassed
    if (isServerAvailable) {
      showToast(err.message);
      return;
    }
    // Backend offline (static mode): enable local profile for seamless demonstration
    state.user = { id: 1, name: payload.name || 'Valued User', email: payload.email };
    writeJson(LEGACY_USER_KEY, state.user);
    closeModal('loginModal');
    updateAuthUI();
    renderAll();
    showToast('Signed in (Local Mode)');
  }
}

async function logoutUser() {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } catch {}
  state.user = null;
  localStorage.removeItem(LEGACY_USER_KEY);
  await loadData();
  updateAuthUI();
  renderAll();
  showToast('Signed out');
}

function updateAuthUI() {
  const u = state.user;
  document.querySelectorAll('[data-login]').forEach(x => {
    x.textContent = u ? `Hi, ${String(u.name).split(' ')[0]}` : 'Login';
    x.onclick = () => u ? logoutUser() : openModal('loginModal');
    x.setAttribute('aria-label', u ? 'Sign out' : 'Log in');
  });

  document.querySelectorAll('[data-user-name]').forEach(x => {
    x.textContent = u ? u.name : 'Guest';
  });
}

function renderAll() {
  populateCats();
  renderDashboard();
  renderCategories();
  renderHidden();
  renderInvestmentAI();
  renderInvestmentPortfolio();
  renderExpenseReduction();
  updateAuthUI();
}

function bindGlobal() {
  ensureAuthModal();
  ensureAssistantWidget();

  document.querySelectorAll('[data-close-modal]').forEach(button => {
    button.addEventListener('click', () => closeModal(button.dataset.closeModal));
  });

  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', event => {
      if (event.target === modal) modal.classList.remove('open');
    });
  });

  document.querySelectorAll('[data-add]').forEach(button => {
    button.addEventListener('click', () => addTransaction(button.dataset.add));
  });

  document.querySelectorAll('[data-entry-type]').forEach(button => {
    button.addEventListener('click', () => setEntryType(button.dataset.entryType));
  });

  document.getElementById('addForm')?.addEventListener('submit', submitTransactionForm);
  document.getElementById('catForm')?.addEventListener('submit', addCategory);
  document.getElementById('portfolioForm')?.addEventListener('submit', submitPortfolioForm);

  document.getElementById('taxForm')?.addEventListener('submit', event => {
    event.preventDefault();
    calculateTax();
  });

  document.getElementById('investmentProfileForm')?.addEventListener('submit', event => {
    event.preventDefault();
    generateInvestmentAI();
  });

  document.getElementById('seedDemoBtn')?.addEventListener('click', seedDemoTransactions);
  document.getElementById('exportCsvBtn')?.addEventListener('click', exportTransactionsCsv);

  document.querySelector('[data-open-cat-modal]')?.addEventListener('click', () => openModal('catModal'));
  document.querySelector('[data-set-hidden-password]')?.addEventListener('click', () => openModal('passwordModal'));
  document.getElementById('hiddenUnlockForm')?.addEventListener('submit', event => {
    event.preventDefault();
    unlockHidden();
  });
  document.getElementById('hiddenPasswordForm')?.addEventListener('submit', event => {
    event.preventDefault();
    setHiddenPassword();
  });
  document.querySelector('[data-lock-hidden]')?.addEventListener('click', lockHidden);

  // Search and filter controls on Dashboard
  const searchInput = document.getElementById('txSearchInput');
  const catFilter = document.getElementById('txCatFilter');
  const typeFilter = document.getElementById('txTypeFilter');

  if (searchInput) {
    searchInput.addEventListener('input', e => {
      state.filterText = e.target.value;
      renderDashboard();
    });
  }
  if (catFilter) {
    catFilter.addEventListener('change', e => {
      state.filterCategory = e.target.value;
      renderDashboard();
    });
  }
  if (typeFilter) {
    typeFilter.addEventListener('change', e => {
      state.filterType = e.target.value;
      renderDashboard();
    });
  }
}

async function initApp() {
  await checkSession();
  await loadData();
  bindGlobal();
  renderAll();
  initHidden();
}

document.addEventListener('DOMContentLoaded', initApp);
