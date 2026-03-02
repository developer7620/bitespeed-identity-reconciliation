# BiteSpeed Identity Reconciliation

A production-grade backend service that identifies and consolidates customer identity across multiple purchases, even when different email addresses and phone numbers are used per order.

**Live endpoint:** `https://YOUR_APP.onrender.com/identify`

---

## Table of Contents

- [Architecture](#architecture)
- [Identity Merging Logic](#identity-merging-logic)
- [Transaction Design](#transaction-design)
- [Concurrency Strategy](#concurrency-strategy)
- [API Reference](#api-reference)
- [Running Locally](#running-locally)
- [Running Tests](#running-tests)
- [Deployment](#deployment)
- [Example curl Requests](#example-curl-requests)

---

## Architecture

```
src/
├── index.ts                   # Server startup (port binding only)
├── app.ts                     # Express app, middleware, routes
├── logger/
│   └── index.ts               # Winston structured logger
├── validation/
│   └── identifySchema.ts      # Zod input validation + parsing
├── controllers/
│   └── identifyController.ts  # HTTP concerns: parse → call service → respond
├── services/
│   └── identityService.ts     # Business logic + transaction orchestration
├── repositories/
│   └── contactRepository.ts   # All DB access (Prisma) isolated here
├── routes/
│   └── identify.ts            # DI wiring: repo → service → controller → router
├── types/
│   └── contact.ts             # Shared TypeScript interfaces
└── lib/
    └── prisma.ts              # Prisma client singleton
```

**Separation of concerns:**

| Layer | Responsibility |
|---|---|
| Validation | Reject malformed input before it reaches the service |
| Controller | HTTP parsing, calling service, mapping errors to status codes |
| Service | All business logic, transaction management |
| Repository | All Prisma queries — the only layer that touches the DB |

This structure makes every layer independently unit-testable and means DB changes are isolated to the repository.

---

## Identity Merging Logic

### Core Rules (from BiteSpeed spec)

1. A `Contact` row is `primary` if it is the oldest anchor for a cluster.
2. All other rows in the cluster are `secondary` and carry a `linkedId` pointing to the primary's `id`.
3. Two clusters are merged when an incoming request provides a value (email or phone) that exists in each cluster — the older primary wins; the newer primary is demoted.

### Step-by-step flow

```
POST /identify { email, phoneNumber }
        │
        ▼
1. Find all active contacts matching email OR phone
        │
        ├─ No matches ──► Create new primary → return
        │
        ▼
2. Collect root primary IDs from all matched rows
   (a primary if linkPrecedence="primary", else follow linkedId)
        │
        ▼
3. Fetch all primaries, sort by createdAt ASC
   primaries[0] = truePrimary (oldest = stable anchor)
        │
        ├─ More than one primary? ──► MERGE:
        │       • Demote newer primaries to secondary under truePrimary
        │       • Re-point their existing secondaries to truePrimary
        │
        ▼
4. Fetch full cluster (truePrimary + all its secondaries)
        │
        ▼
5. Does the request introduce new email/phone not yet in cluster?
        │
        ├─ Yes ──► Create new secondary linked to truePrimary → re-fetch cluster
        │
        ├─ No  ──► Idempotent: return existing cluster unchanged
        │
        ▼
6. Build response (primary values first, secondaries sorted by id ASC)
```

**Why oldest = true primary?**
The spec mandates it, and it gives a stable, monotonically consistent choice. Any two concurrent requests that both observe the same two primaries will always agree on which one to keep — the one with the smaller `createdAt`.

---

## Transaction Design

The entire identify flow runs inside a single `SERIALIZABLE` PostgreSQL transaction via `prisma.$transaction`.

**Why a transaction is critical:**

Without it, steps 1–5 above are separate DB round-trips. Between any two steps, a concurrent request can:
- Insert a duplicate secondary (same email+phone, different `id`)
- Merge a cluster that the current request has already read (split-brain)
- Observe a half-demoted primary (one `updateMany` committed, the other not)

`SERIALIZABLE` isolation means PostgreSQL guarantees the net effect is identical to serial execution. Any conflicting concurrent transaction is aborted and must retry. This eliminates all of the above races.

**Last-resort guard:** The schema carries a unique constraint on `(email, phoneNumber)`. Even if two identical requests somehow both pass the idempotency check simultaneously, only one `INSERT` will succeed at the DB level. The loser receives a Prisma `P2002` error, which the controller surfaces as HTTP 409.

---

## Concurrency Strategy

| Scenario | How it is handled |
|---|---|
| Two requests merge different clusters simultaneously | `SERIALIZABLE` transaction aborts one; it retries and sees the already-merged state |
| Two identical requests hit at the same time | Idempotency check inside transaction; DB unique constraint as fallback |
| One request inserts while another reads the cluster | Transaction isolation prevents dirty reads |

No application-level mutexes or Redis locks are needed — PostgreSQL's MVCC + serializable isolation is sufficient for this workload.

---

## API Reference

### `POST /identify`

**Request** (JSON body):
```json
{
  "email": "string (optional)",
  "phoneNumber": "string or number (optional)"
}
```
At least one field must be non-null. Email must be a valid format. Phone must be 5–15 digits (E.164-ish), with optional leading `+`.

**Response 200:**
```json
{
  "contact": {
    "primaryContatctId": 1,
    "emails": ["primary@example.com", "other@example.com"],
    "phoneNumbers": ["123456", "789012"],
    "secondaryContactIds": [2, 3]
  }
}
```

**Response 400** (validation failure):
```json
{
  "error": "Validation failed",
  "details": [
    { "path": "email", "message": "Invalid email format" }
  ]
}
```

**Response 409** (rare concurrent conflict — safe to retry):
```json
{ "error": "Concurrent request conflict. Please retry." }
```

### `GET /`
Health check. Returns `{ "status": "ok" }`.

---

## Running Locally

### Prerequisites
- Node.js ≥ 18
- PostgreSQL (local install, or free cloud: [neon.tech](https://neon.tech))

### Steps

```bash
# 1. Clone
git clone https://github.com/YOUR_USERNAME/bitespeed-identity-reconciliation.git
cd bitespeed-identity-reconciliation

# 2. Install
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env — set DATABASE_URL to your PostgreSQL connection string

# 4. Push schema to DB + generate Prisma client
npm run db:push
npm run db:generate

# 5. Start development server (hot-reload)
npm run dev
# → Server running on http://localhost:3000

# 6. Build + start production server
npm run build
npm start
```

---

## Running Tests

```bash
# Run all tests
npm test

# Run with coverage report
npm run test:coverage
```

Tests are unit tests only — they mock the repository layer and run without a DB connection. Every major code path is covered:

| Test | What it verifies |
|---|---|
| New contact creation | New primary created when no matches |
| Only email | Null phone handled correctly |
| Only phone | Null email handled correctly |
| Secondary creation | New secondary when new info arrives |
| Idempotency | No duplicate rows for repeated requests |
| Primary-to-primary merge | Older cluster wins, newer demoted |
| Response ordering | Primary values first, IDs sorted |
| Validation — valid inputs | Email, phone, both, numeric phone |
| Validation — invalid inputs | Missing both, bad email, short phone |

---

## Deployment

### Render (free tier) — recommended

1. Push repo to GitHub.
2. Go to [render.com](https://render.com) → **New Web Service** → connect repo.
3. Configure:
   - **Build Command:** `npm install && npm run db:generate && npm run build`
   - **Start Command:** `npm start`
4. Add Environment Variables:
   - `DATABASE_URL` — from [neon.tech](https://neon.tech) (free PostgreSQL)
   - `NODE_ENV` = `production`
   - `LOG_LEVEL` = `info`
5. Deploy → copy the public URL into this README.

### After deploying

Run the migration against your production DB once:
```bash
DATABASE_URL="<your-prod-url>" npx prisma db push
```

---

## Example curl Requests

### New customer
```bash
curl -X POST https://YOUR_APP.onrender.com/identify \
  -H "Content-Type: application/json" \
  -d '{"email":"lorraine@hillvalley.edu","phoneNumber":"123456"}'
```

### Same phone, new email → creates secondary
```bash
curl -X POST https://YOUR_APP.onrender.com/identify \
  -H "Content-Type: application/json" \
  -d '{"email":"mcfly@hillvalley.edu","phoneNumber":"123456"}'
```

### Lookup by email only
```bash
curl -X POST https://YOUR_APP.onrender.com/identify \
  -H "Content-Type: application/json" \
  -d '{"email":"lorraine@hillvalley.edu"}'
```

### Trigger cluster merge
```bash
# First create two independent contacts
curl -X POST https://YOUR_APP.onrender.com/identify \
  -d '{"email":"george@hillvalley.edu","phoneNumber":"919191"}' \
  -H "Content-Type: application/json"

curl -X POST https://YOUR_APP.onrender.com/identify \
  -d '{"email":"biff@hillvalley.edu","phoneNumber":"717171"}' \
  -H "Content-Type: application/json"

# Now bridge them — this merges the two clusters
curl -X POST https://YOUR_APP.onrender.com/identify \
  -d '{"email":"george@hillvalley.edu","phoneNumber":"717171"}' \
  -H "Content-Type: application/json"
```

### Validation error
```bash
curl -X POST https://YOUR_APP.onrender.com/identify \
  -H "Content-Type: application/json" \
  -d '{}'
# → 400 { "error": "Validation failed", "details": [...] }
```
