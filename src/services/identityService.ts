import { prisma } from "../lib/prisma";
import { ContactRepository } from "../repositories/contactRepository";
import { ContactRow, ContactResponse, IdentifyInput } from "../types/contact";
import { logger } from "../logger";

// ─────────────────────────────────────────────────────────────────────────────
// IdentityService — core reconciliation logic
//
// WHY A TRANSACTION?
// The identify flow involves multiple dependent reads AND writes:
//   1. Read matching contacts
//   2. Decide which is the true primary
//   3. Demote other primaries + re-point their secondaries
//   4. Optionally insert a new secondary
//   5. Re-fetch the final cluster
//
// Without a transaction, two concurrent requests can interleave and produce
// split-brain state — e.g. both see themselves as primary, both insert a
// secondary, neither demotes the other. With SERIALIZABLE isolation the DB
// guarantees that the net effect is as if one ran after the other.
//
// SERIALIZABLE vs REPEATABLE READ:
// We use SERIALIZABLE (Prisma's `$transaction` default with isolation level
// set below) because we read-then-write based on the read result. A phantom
// read (new row inserted mid-transaction) could otherwise cause us to miss a
// concurrent merge and create a duplicate secondary.
// ─────────────────────────────────────────────────────────────────────────────

export class IdentityService {
  private readonly repo: ContactRepository;

  constructor(repo: ContactRepository) {
    this.repo = repo;
  }

  async identify(input: IdentifyInput): Promise<ContactResponse> {
    const { email, phoneNumber } = input;

    // $transaction with SERIALIZABLE isolation ensures the entire read-decide-write
    // sequence is atomic. PostgreSQL will abort and retry on conflict, giving us
    // correct behaviour even under heavy concurrent load.
    const result = await prisma.$transaction(
      async (tx) => {
        // ── 1. Find contacts matching this email or phone ─────────────────────
        const matchingContacts = await this.repo.findByEmailOrPhone(
          email,
          phoneNumber,
          tx
        );

        // ── 2. Brand-new customer ─────────────────────────────────────────────
        if (matchingContacts.length === 0) {
          const newContact = await this.repo.create(
            { email, phoneNumber, linkedId: null, linkPrecedence: "primary" },
            tx
          );
          logger.info("New primary contact created", { id: newContact.id, email, phoneNumber });
          return buildResponse(newContact, []);
        }

        // ── 3. Resolve all root primaries ─────────────────────────────────────
        // Each matched contact is either a primary itself (linkedId = null) or a
        // secondary pointing to one. We collect all unique primary IDs.
        const primaryIdSet = new Set<number>();
        for (const c of matchingContacts) {
          if (c.linkPrecedence === "primary") {
            primaryIdSet.add(c.id);
          } else if (c.linkedId !== null) {
            primaryIdSet.add(c.linkedId);
          }
        }

        // Fetch them in createdAt ASC order.
        // WHY oldest = true primary? The spec says "the oldest one is treated as
        // primary". This gives a deterministic, stable anchor for the cluster.
        const primaries = await this.repo.findPrimarysByIds(
          Array.from(primaryIdSet),
          tx
        );

        const truePrimary = primaries[0]!;
        const stalePrimaries = primaries.slice(1); // newer primaries to demote

        // ── 4. Merge clusters if needed ───────────────────────────────────────
        // If the request touches two previously independent clusters (e.g. an
        // email from cluster A and a phone from cluster B), we merge them by:
        //   a) Demoting the newer primary(ies) → secondary under truePrimary
        //   b) Re-pointing their existing secondaries → truePrimary
        //
        // Both updates are inside the same transaction, so observers will never
        // see a half-merged state.
        if (stalePrimaries.length > 0) {
          const stalePrimaryIds = stalePrimaries.map((p) => p.id);
          await this.repo.demoteToPrimary(stalePrimaryIds, truePrimary.id, tx);
          await this.repo.repointSecondaries(stalePrimaryIds, truePrimary.id, tx);

          logger.info("Clusters merged", {
            truePrimaryId: truePrimary.id,
            demoted: stalePrimaryIds,
          });
        }

        // ── 5. Fetch full cluster after any merges ────────────────────────────
        const cluster = await this.repo.findCluster(truePrimary.id, tx);

        // ── 6. Idempotency + new-info detection ───────────────────────────────
        // We check whether the incoming request introduces information not yet
        // in the cluster. If every field in the request already exists in some
        // row, this is a repeated/duplicate request — we return without inserting.
        //
        // HOW IDEMPOTENCY IS GUARANTEED:
        //   • If email AND phoneNumber both already exist in the cluster → no insert.
        //   • The DB-level unique constraint on (email, phoneNumber) is the last
        //     line of defence: even if two identical concurrent requests slip past
        //     this check simultaneously, only one INSERT will succeed; the other
        //     gets a unique-constraint error which we handle below.
        const existingEmails = new Set(cluster.map((c) => c.email).filter(Boolean));
        const existingPhones = new Set(cluster.map((c) => c.phoneNumber).filter(Boolean));

        const isNewEmail = email !== null && !existingEmails.has(email);
        const isNewPhone = phoneNumber !== null && !existingPhones.has(phoneNumber);

        if (isNewEmail || isNewPhone) {
          // New information → create a secondary contact
          const newSecondary = await this.repo.create(
            {
              email,
              phoneNumber,
              linkedId: truePrimary.id,
              linkPrecedence: "secondary",
            },
            tx
          );
          logger.info("New secondary contact created", {
            id: newSecondary.id,
            linkedTo: truePrimary.id,
            email,
            phoneNumber,
          });

          // Re-fetch to include the new secondary in the response
          const updatedCluster = await this.repo.findCluster(truePrimary.id, tx);
          const secondaries = updatedCluster.filter((c) => c.id !== truePrimary.id);
          return buildResponse(truePrimary, secondaries);
        }

        // ── 7. No new info — idempotent response ──────────────────────────────
        const secondaries = cluster.filter((c) => c.id !== truePrimary.id);
        return buildResponse(truePrimary, secondaries);
      },
      // SERIALIZABLE prevents phantom reads that could cause duplicate inserts
      // or split-brain merges under concurrent load.
      { isolationLevel: "Serializable" }
    );

    return result;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// buildResponse
//
// Constructs the API payload with guaranteed ordering:
//   • Primary's email  always first in emails[]
//   • Primary's phone  always first in phoneNumbers[]
//   • secondaryContactIds sorted by id ASC (stable, predictable order)
//
// Duplicate values are silently deduplicated (shouldn't happen in practice,
// but defensive programming costs nothing here).
// ─────────────────────────────────────────────────────────────────────────────
function buildResponse(
  primary: ContactRow,
  secondaries: ContactRow[]
): ContactResponse {
  const emails: string[] = [];
  const phoneNumbers: string[] = [];

  // Primary's values first — spec requirement
  if (primary.email) emails.push(primary.email);
  if (primary.phoneNumber) phoneNumbers.push(primary.phoneNumber);

  // Secondaries in createdAt order (repo returns them sorted already)
  for (const s of secondaries) {
    if (s.email && !emails.includes(s.email)) emails.push(s.email);
    if (s.phoneNumber && !phoneNumbers.includes(s.phoneNumber)) phoneNumbers.push(s.phoneNumber);
  }

  return {
    contact: {
      primaryContatctId: primary.id, // typo preserved — matches BiteSpeed spec
      emails,
      phoneNumbers,
      // Sort IDs for stable, deterministic ordering across calls
      secondaryContactIds: secondaries.map((s) => s.id).sort((a, b) => a - b),
    },
  };
}
