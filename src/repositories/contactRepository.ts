import { PrismaClient, Prisma } from "@prisma/client";
import { ContactRow, LinkPrecedence } from "../types/contact";

// ─────────────────────────────────────────────────────────────────────────────
// ContactRepository
//
// All database access is centralised here. The service layer never imports
// Prisma directly — it only calls these methods. This makes:
//   • Unit-testing easy (mock the repo, not Prisma internals)
//   • DB migrations isolated to one file
//   • Query logic readable in one place
//
// Every method accepts an optional `tx` parameter so it can participate in
// a caller-managed transaction without needing its own connection.
// ─────────────────────────────────────────────────────────────────────────────

type Tx = Prisma.TransactionClient;

// Shared select shape — keeps all queries returning the same fields
const contactSelect = {
  id: true,
  phoneNumber: true,
  email: true,
  linkedId: true,
  linkPrecedence: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} as const;

function toRow(raw: {
  id: number;
  phoneNumber: string | null;
  email: string | null;
  linkedId: number | null;
  linkPrecedence: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}): ContactRow {
  return {
    ...raw,
    linkPrecedence: raw.linkPrecedence as LinkPrecedence,
  };
}

export class ContactRepository {
  constructor(private readonly client: PrismaClient) {}

  /**
   * Find all active contacts that match either the given email or phoneNumber.
   * This is the initial "who do we already know?" lookup.
   * Uses the email + phoneNumber indexes for efficient OR lookup.
   */
  async findByEmailOrPhone(
    email: string | null,
    phoneNumber: string | null,
    tx?: Tx
  ): Promise<ContactRow[]> {
    const db = tx ?? this.client;
    const orConditions: Prisma.ContactWhereInput[] = [];
    if (email) orConditions.push({ email });
    if (phoneNumber) orConditions.push({ phoneNumber });

    const rows = await db.contact.findMany({
      select: contactSelect,
      where: { deletedAt: null, OR: orConditions },
    });
    return rows.map(toRow);
  }

  /**
   * Fetch primary contacts by their IDs, ordered oldest-first.
   * Ordering by createdAt ASC ensures [0] is always the true primary
   * (the one that has been in the system longest).
   */
  async findPrimarysByIds(ids: number[], tx?: Tx): Promise<ContactRow[]> {
    const db = tx ?? this.client;
    const rows = await db.contact.findMany({
      select: contactSelect,
      where: { id: { in: ids }, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toRow);
  }

  /**
   * Fetch the entire cluster: the primary + all its secondaries.
   * Ordered by createdAt ASC so primary is always first in the array.
   */
  async findCluster(primaryId: number, tx?: Tx): Promise<ContactRow[]> {
    const db = tx ?? this.client;
    const rows = await db.contact.findMany({
      select: contactSelect,
      where: {
        deletedAt: null,
        OR: [{ id: primaryId }, { linkedId: primaryId }],
      },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toRow);
  }

  /**
   * Create a new contact row.
   */
  async create(
    data: {
      email: string | null;
      phoneNumber: string | null;
      linkedId: number | null;
      linkPrecedence: LinkPrecedence;
    },
    tx?: Tx
  ): Promise<ContactRow> {
    const db = tx ?? this.client;
    const row = await db.contact.create({ select: contactSelect, data });
    return toRow(row);
  }

  /**
   * Demote a set of primary contacts to secondary under a new primary.
   * Called during cluster-merge when two previously independent primaries
   * are discovered to belong to the same person.
   */
  async demoteToPrimary(
    ids: number[],
    newPrimaryId: number,
    tx?: Tx
  ): Promise<void> {
    const db = tx ?? this.client;
    await db.contact.updateMany({
      where: { id: { in: ids } },
      data: {
        linkPrecedence: "secondary",
        linkedId: newPrimaryId,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Re-point secondaries that were linked to a demoted primary.
   * Without this step, those secondaries would dangle — their linkedId
   * would point to a row that is now itself a secondary, breaking the
   * invariant that every secondary points directly to a primary.
   */
  async repointSecondaries(
    fromPrimaryIds: number[],
    toNewPrimaryId: number,
    tx?: Tx
  ): Promise<void> {
    const db = tx ?? this.client;
    await db.contact.updateMany({
      where: { linkedId: { in: fromPrimaryIds }, deletedAt: null },
      data: { linkedId: toNewPrimaryId, updatedAt: new Date() },
    });
  }
}
