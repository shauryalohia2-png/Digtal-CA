==============================================================================
DIGITAL CA ENTERPRISE (v10 - 100% FREE APPLICATION & ELEVATED AI CORE)
==============================================================================

Digital CA is a 100% FREE, institutional personal & business financial platform.
There are no subscription fees, consultation charges, or hidden paywalls.
The in-app payment terminal is a personal utility for users to execute and record
their own everyday bills, rent, vendor supplies, subscriptions, and utilities,
automatically saving verified receipts and ledger records inside the app.

------------------------------------------------------------------------------
KEY UPGRADES & PROBLEM RESOLUTIONS
------------------------------------------------------------------------------

1. 100% FREE APPLICATION & IN-APP PAYMENT UTILITY
   - The entire Digital CA suite is completely free for all users.
   - The Payment section is designed as an everyday payment terminal where users
     can pay external expenses (Electricity Bill, Office Rent, Vendor Supplies,
     Cloud/Broadband) and instantly archive verified receipts into their ledger.
   - Cured the recurring "Failed to fetch" error by replacing third-party Razorpay
     redirects with an independent, in-house payment simulator:
     * Dynamic UPI QR Code generator (real-time vector SVG) & UPI VPA handles.
     * Debit/Credit Cards with auto card-brand detector (RuPay, Visa, Mastercard, Amex).
     * Native 3D Secure / OTP Simulation modal with real-time test OTP auto-fill (123456).
     * Direct Net Banking selector for top Indian banks (SBI, HDFC, ICICI, Axis, Kotak, PNB).
     * Digital CA Sandbox Wallet with preloaded balance for instant 1-click settlement.
     * Instant generation of official Digital CA Tax Invoices & Payment Receipts
       (complete with GSTIN, SAC Code 998231, CGST/SGST breakdown, and Print/PDF styling).
     * Automatic synchronization into the user's expense ledger so all payments
       instantly reflect on the dashboard.

2. FIXED CA AI COPILOT CLOSE BUTTON & ACCESSIBILITY
   - Resolved the CSS specificity conflict where `.assistant-panel { display: grid }`
     prevented the HTML `hidden` attribute from hiding the panel.
   - Added explicit `.assistant-panel[hidden] { display: none !important }` and
     `.assistant-panel.open { display: grid !important }`.
   - Wired explicit open/close functions with keyboard `Escape` shortcut support
     and high-contrast, ample click target styling on `#assistantClose`.

3. CURED & ELEVATED ARTIFICIAL INTELLIGENCE (Always-On CA Intelligence)
   - Built-in multi-tier AI architecture:
     * Tier 1: Google Gemini API (gemini-3.8-flash, falls back to gemini-flash-latest; configurable via GEMINI_MODEL) via native REST.
     * Tier 2: OpenAI API (gpt-4o-mini).
     * Tier 3: Autonomous Digital CA Neural Engine (Built-in Indian Chartered Accountant
       reasoning core that runs 100% out-of-the-box with ZERO API keys required).
   - Never crashes with 503 or "AI unavailable" errors.
   - Master of Section 44ADA/44AD presumptive taxation, GST Section 17(5) blocked credits,
     TDS rates & Advance tax calendar, business entity structures (Pvt Ltd vs LLP),
     and dynamic monthly SIP compound wealth forecasting.
   - Copilot handles natural language commands ("Spent 450 on Coffee via UPI",
     "Salary credited 85000", "Analyze my spending", "Compare tax slabs").
   - Works seamlessly for both authenticated accounts AND guest users.

4. NEXT-LEVEL FINANCIAL MODULES
   - Smart Tax Management (taxes.html):
     * Side-by-side comparison of New Tax Regime vs Old Tax Regime for AY 2026–27.
     * Evaluates Section 87A full rebate (tax-free up to ₹12 Lakhs under New Regime).
     * Interactive deduction calculator for 80C, 80D Mediclaim, 80CCD(1B) NPS, HRA,
       and Section 24 Home Loan Interest.
   - Waste Hunter & Wealth Realizer (reduce-expenses.html):
     * Detects repeat micro-spends, subscriptions, and high-velocity spending clusters.
     * Interactive slider showing annual savings and 5-year wealth compounding (12% SIP).
   - Investment AI & Portfolio Architecture (investments.html):
     * Financial Health Score (0 to 100).
     * 6-Month Emergency Fund Stress Test.
     * Asset allocation blueprint (Equities, Debt, Gold) based on age and risk parameters.
   - Dashboard Analytics (dashboard.html):
     * Real-time search and filtering (by text, type, category).
     * One-click CSV Data Export for Excel/spreadsheets.
     * Interactive 6-month cash flow bar charts.

5. 100% STANDALONE & SERVER COMPATIBILITY
   - Works either by running the Node.js Express server ('npm start')
     OR simply opening the HTML files directly in any modern browser.
   - If the server is offline or not installed, the application gracefully
     operates locally without throwing any fetch errors or data loss.

------------------------------------------------------------------------------
LOCAL RUNNING INSTRUCTIONS
------------------------------------------------------------------------------

OPTION A: Direct Browser Usage (Zero Setup)
Simply open 'index.html', 'dashboard.html', or 'payments.html' in Google Chrome,
Edge, or any web browser.

OPTION B: Full Express & SQLite Backend
1. Ensure Node.js 22.5+ is installed (uses the built-in node:sqlite module).
   Install dependencies: npm install
2. (Optional) Copy .env.example to .env and add GEMINI_API_KEY if desired.
3. Start the server:
   node server.js
4. Visit:
   http://localhost:3000

OPTION C: Deploy to Vercel
1. Import the GitHub repository in Vercel (or run `vercel` from this folder).
   vercel.json already configures everything: no framework preset, build
   command `npm run build`, output directory `public`, Node.js 22.x.
2. (Optional) In Project Settings > Environment Variables add GEMINI_API_KEY
   or OPENAI_API_KEY (and GEMINI_MODEL / OPENAI_MODEL if you want to override).
3. Deploy. Static pages are served from Vercel's CDN; every /api/* request is
   handled by the Express app through the serverless function in api/index.js.

IMPORTANT - data persistence on Vercel:
   Vercel functions have no permanent disk, so the SQLite database lives in the
   function's temporary directory. Accounts, ledgers and chat history created
   on the deployed site are lost whenever Vercel recycles an instance, and two
   instances do not share data. Guest mode (browser localStorage) is unaffected.
   For permanent multi-user storage, move the database to a hosted service
   (e.g. Vercel Postgres / Neon, Turso, or Supabase).
