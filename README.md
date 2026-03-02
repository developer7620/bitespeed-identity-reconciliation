# bitespeed-identity-reconciliation

**Live endpoint:** `https://bitespeed-identity-reconciliation-mlak.onrender.com/identify`

Built for the BiteSpeed backend engineering intern assignment. The service links different orders made with different contact info back to the same person.

---

## What it does

When FluxKart gets a checkout event with an email or phone number, it hits `/identify`. The service figures out if this person already exists in the database (maybe under a different email or phone), links everything together, and returns a consolidated view of that contact.

The tricky part is when two previously separate contact clusters turn out to belong to the same person — the service merges them, keeps the oldest one as primary, and re-points everything else underneath it.

---

## Stack

- **Node.js + TypeScript**
- **Express** — HTTP layer
- **Prisma + PostgreSQL** (Neon) — database
- **Zod** — request validation
- **Winston** — structured logging
- **Jest** — unit tests

---

## Project structure
```
src/
├── index.ts                        # starts the server, nothing else
├── app.ts                          # express setup, middleware, routes
├── validation/identifySchema.ts    # zod schema, rejects bad input early
├── controllers/identifyController  # handles http, calls service, maps errors
├── services/identityService.ts     # all the business logic lives here
├── repositories/contactRepository  # every db query in one place
├── logger/index.ts                 # winston, json in prod / readable in dev
└── lib/prisma.ts                   # prisma singleton
```

The idea was to keep each layer doing one thing. The service doesn't know about HTTP. The controller doesn't touch the database. The repository doesn't have any logic. Made testing a lot easier too — the service tests just mock the repo.

---

## How the merging works

1. Incoming request has an email, a phone, or both
2. Look up all existing contacts that match either value
3. From those matches, find all the root primaries (following linkedId if needed)
4. Sort primaries by createdAt — the oldest one wins
5. If there's more than one primary, merge: demote the newer ones to secondary and re-point their children
6. Check if the request has any new info not already in the cluster — if yes, create a new secondary
7. Return the full cluster with primary values first

---

## Transactions

The whole flow runs in a single SERIALIZABLE transaction. Without it, two concurrent requests could both think they're the primary, both insert rows, and leave the database in a broken state. Serializable isolation makes PostgreSQL treat concurrent transactions as if they ran one after the other — if there's a conflict, one gets aborted and retries.

There's also a unique constraint on (email, phoneNumber) as a last line of defence. If two identical requests race past the idempotency check at the same moment, only one insert goes through. The other gets a P2002 from Prisma which the controller surfaces as a 409.

---

## Running locally

You'll need Node 18+ and a PostgreSQL database. neon.tech has a free tier that works fine.
```bash
git clone https://github.com/developer7620/bitespeed-identity-reconciliation.git
cd bitespeed-identity-reconciliation

npm install

cp .env.example .env
# paste your DATABASE_URL into .env

npm run db:push
npm run db:generate

npm run dev
```

---

## Tests
```bash
npm test
```

18 tests, no database needed — the repository layer is mocked. Covers new contact creation, secondary creation, cluster merging, idempotency, response ordering, and input validation edge cases.

---

## API

### POST /identify
```json
{ "email": "mcfly@hillvalley.edu", "phoneNumber": "123456" }
```
```json
{
  "contact": {
    "primaryContatctId": 1,
    "emails": ["lorraine@hillvalley.edu", "mcfly@hillvalley.edu"],
    "phoneNumbers": ["123456"],
    "secondaryContactIds": [23]
  }
}
```

At least one of email or phoneNumber is required. Phone accepts strings or numbers (5-15 digits). Returns 400 with details on validation failure, 409 on rare concurrent conflict.

### GET /

Health check, returns `{ "status": "ok" }`.

---

## Example requests
```bash
# new contact
curl -X POST https://bitespeed-identity-reconciliation-mlak.onrender.com/identify \
  -H "Content-Type: application/json" \
  -d '{"email":"lorraine@hillvalley.edu","phoneNumber":"123456"}'

# same phone, new email — creates a secondary
curl -X POST https://bitespeed-identity-reconciliation-mlak.onrender.com/identify \
  -H "Content-Type: application/json" \
  -d '{"email":"mcfly@hillvalley.edu","phoneNumber":"123456"}'

# merge two clusters — first create them separately, then bridge
curl -X POST https://bitespeed-identity-reconciliation-mlak.onrender.com/identify \
  -H "Content-Type: application/json" \
  -d '{"email":"george@hillvalley.edu","phoneNumber":"919191"}'

curl -X POST https://bitespeed-identity-reconciliation-mlak.onrender.com/identify \
  -H "Content-Type: application/json" \
  -d '{"email":"biff@hillvalley.edu","phoneNumber":"717171"}'

curl -X POST https://bitespeed-identity-reconciliation-mlak.onrender.com/identify \
  -H "Content-Type: application/json" \
  -d '{"email":"george@hillvalley.edu","phoneNumber":"717171"}'
```
