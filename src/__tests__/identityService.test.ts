import { IdentityService } from "../services/identityService";
import { ContactRepository } from "../repositories/contactRepository";
import { ContactRow, IdentifyInput } from "../types/contact";

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for IdentityService
//
// Strategy: mock the ContactRepository so tests run without a DB connection.
// Each test controls exactly what the repo returns, letting us verify service
// logic in isolation.
//
// The $transaction wrapper in the service calls the callback with `tx`.
// We mock prisma.$transaction to be a pass-through that calls the callback
// with `undefined` as tx — the repo mock ignores the tx argument anyway.
// ─────────────────────────────────────────────────────────────────────────────

// ── Prisma mock ──────────────────────────────────────────────────────────────
jest.mock("../lib/prisma", () => ({
  prisma: {
    $transaction: jest.fn(
      async (fn: (tx: undefined) => Promise<unknown>) => fn(undefined)
    ),
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────────────
function makeContact(overrides: Partial<ContactRow> = {}): ContactRow {
  return {
    id: 1,
    email: "test@example.com",
    phoneNumber: "1234567890",
    linkedId: null,
    linkPrecedence: "primary",
    createdAt: new Date("2023-01-01"),
    updatedAt: new Date("2023-01-01"),
    deletedAt: null,
    ...overrides,
  };
}

function makeRepo(overrides: Partial<ContactRepository> = {}): ContactRepository {
  const base: Partial<ContactRepository> = {
    findByEmailOrPhone: jest.fn().mockResolvedValue([]),
    findPrimarysByIds: jest.fn().mockResolvedValue([]),
    findCluster: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    demoteToPrimary: jest.fn().mockResolvedValue(undefined),
    repointSecondaries: jest.fn().mockResolvedValue(undefined),
  };
  return { ...base, ...overrides } as unknown as ContactRepository;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("IdentityService.identify", () => {
  // ── Test 1: Brand-new customer ─────────────────────────────────────────────
  it("creates a new primary contact when no matches exist", async () => {
    const created = makeContact({ id: 42, email: "new@test.com", phoneNumber: "9999999999" });
    const repo = makeRepo({
      findByEmailOrPhone: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue(created),
    });
    const service = new IdentityService(repo);

    const result = await service.identify({ email: "new@test.com", phoneNumber: "9999999999" });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ linkPrecedence: "primary", linkedId: null }),
      undefined
    );
    expect(result.contact.primaryContatctId).toBe(42);
    expect(result.contact.emails).toEqual(["new@test.com"]);
    expect(result.contact.phoneNumbers).toEqual(["9999999999"]);
    expect(result.contact.secondaryContactIds).toEqual([]);
  });

  // ── Test 2: Only email provided ────────────────────────────────────────────
  it("handles identify with only email", async () => {
    const primary = makeContact({ id: 1, email: "only@test.com", phoneNumber: null });
    const repo = makeRepo({
      findByEmailOrPhone: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue(primary),
    });
    const service = new IdentityService(repo);

    const result = await service.identify({ email: "only@test.com", phoneNumber: null });

    expect(result.contact.emails).toEqual(["only@test.com"]);
    expect(result.contact.phoneNumbers).toEqual([]);
  });

  // ── Test 3: Only phone provided ────────────────────────────────────────────
  it("handles identify with only phoneNumber", async () => {
    const primary = makeContact({ id: 1, email: null, phoneNumber: "5555555555" });
    const repo = makeRepo({
      findByEmailOrPhone: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue(primary),
    });
    const service = new IdentityService(repo);

    const result = await service.identify({ email: null, phoneNumber: "5555555555" });

    expect(result.contact.phoneNumbers).toEqual(["5555555555"]);
    expect(result.contact.emails).toEqual([]);
  });

  // ── Test 4: Existing match, new info → create secondary ───────────────────
  it("creates a secondary contact when request has new information", async () => {
    const primary = makeContact({ id: 1, email: "lorraine@hillvalley.edu", phoneNumber: "123456" });
    const secondary = makeContact({
      id: 23,
      email: "mcfly@hillvalley.edu",
      phoneNumber: "123456",
      linkedId: 1,
      linkPrecedence: "secondary",
      createdAt: new Date("2023-04-20"),
    });

    const repo = makeRepo({
      // Initial lookup returns the primary (phone matches)
      findByEmailOrPhone: jest.fn().mockResolvedValue([primary]),
      findPrimarysByIds: jest.fn().mockResolvedValue([primary]),
      // Cluster before insert = just primary
      findCluster: jest.fn()
        .mockResolvedValueOnce([primary])          // step 5: check new info
        .mockResolvedValueOnce([primary, secondary]), // step 6: after insert
      create: jest.fn().mockResolvedValue(secondary),
    });
    const service = new IdentityService(repo);

    const input: IdentifyInput = { email: "mcfly@hillvalley.edu", phoneNumber: "123456" };
    const result = await service.identify(input);

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ linkPrecedence: "secondary", linkedId: 1 }),
      undefined
    );
    expect(result.contact.primaryContatctId).toBe(1);
    expect(result.contact.emails).toContain("mcfly@hillvalley.edu");
    expect(result.contact.secondaryContactIds).toContain(23);
  });

  // ── Test 5: Repeated request — idempotency ────────────────────────────────
  it("does NOT create a new row for an identical repeated request", async () => {
    const primary = makeContact({ id: 1, email: "lorraine@hillvalley.edu", phoneNumber: "123456" });
    const secondary = makeContact({
      id: 23, email: "mcfly@hillvalley.edu", phoneNumber: "123456",
      linkedId: 1, linkPrecedence: "secondary",
    });

    const repo = makeRepo({
      // Both email and phone are already in the cluster
      findByEmailOrPhone: jest.fn().mockResolvedValue([primary, secondary]),
      findPrimarysByIds: jest.fn().mockResolvedValue([primary]),
      findCluster: jest.fn().mockResolvedValue([primary, secondary]),
      create: jest.fn(),
    });
    const service = new IdentityService(repo);

    // Same request as the one that created secondary #23
    await service.identify({ email: "mcfly@hillvalley.edu", phoneNumber: "123456" });

    // Must NOT insert a new row
    expect(repo.create).not.toHaveBeenCalled();
  });

  // ── Test 6: Two primaries get merged ──────────────────────────────────────
  it("merges two primary clusters when request bridges them", async () => {
    const primaryA = makeContact({
      id: 11, email: "george@hillvalley.edu", phoneNumber: "919191",
      createdAt: new Date("2023-04-11"),
    });
    const primaryB = makeContact({
      id: 27, email: "biff@hillvalley.edu", phoneNumber: "717171",
      createdAt: new Date("2023-04-21"),
    });
    // After merge: B is demoted, cluster = [A, B_demoted]
    const bDemoted = { ...primaryB, linkPrecedence: "secondary" as const, linkedId: 11 };

    const repo = makeRepo({
      findByEmailOrPhone: jest.fn().mockResolvedValue([primaryA, primaryB]),
      findPrimarysByIds: jest.fn().mockResolvedValue([primaryA, primaryB]), // oldest first
      demoteToPrimary: jest.fn().mockResolvedValue(undefined),
      repointSecondaries: jest.fn().mockResolvedValue(undefined),
      findCluster: jest.fn().mockResolvedValue([primaryA, bDemoted]),
      create: jest.fn(),
    });
    const service = new IdentityService(repo);

    const result = await service.identify({
      email: "george@hillvalley.edu",
      phoneNumber: "717171",
    });

    // B must be demoted to secondary under A
    expect(repo.demoteToPrimary).toHaveBeenCalledWith([27], 11, undefined);
    expect(repo.repointSecondaries).toHaveBeenCalledWith([27], 11, undefined);

    // A is the true primary
    expect(result.contact.primaryContatctId).toBe(11);
    expect(result.contact.secondaryContactIds).toContain(27);

    // No new row was inserted — the request contained no new info beyond the merge
    expect(repo.create).not.toHaveBeenCalled();
  });

  // ── Test 7: Primary email/phone always first in response ──────────────────
  it("puts primary email and phone first in response arrays", async () => {
    const primary = makeContact({
      id: 1, email: "primary@test.com", phoneNumber: "1111111111",
    });
    const sec1 = makeContact({
      id: 2, email: "sec1@test.com", phoneNumber: "2222222222",
      linkedId: 1, linkPrecedence: "secondary",
      createdAt: new Date("2023-02-01"),
    });
    const sec2 = makeContact({
      id: 3, email: "sec2@test.com", phoneNumber: "3333333333",
      linkedId: 1, linkPrecedence: "secondary",
      createdAt: new Date("2023-03-01"),
    });

    const repo = makeRepo({
      findByEmailOrPhone: jest.fn().mockResolvedValue([primary]),
      findPrimarysByIds: jest.fn().mockResolvedValue([primary]),
      findCluster: jest.fn().mockResolvedValue([primary, sec1, sec2]),
      create: jest.fn(),
    });
    const service = new IdentityService(repo);

    const result = await service.identify({ email: "primary@test.com", phoneNumber: null });

    expect(result.contact.emails[0]).toBe("primary@test.com");
    expect(result.contact.phoneNumbers[0]).toBe("1111111111");
    expect(result.contact.secondaryContactIds).toEqual([2, 3]); // sorted ASC
  });

  // ── Test 8: Secondary contact IDs are always sorted ───────────────────────
  it("returns secondaryContactIds in ascending order", async () => {
    const primary = makeContact({ id: 1 });
    const secondaries = [5, 2, 8, 3].map((id) =>
      makeContact({ id, linkedId: 1, linkPrecedence: "secondary", createdAt: new Date(id * 1000) })
    );

    const repo = makeRepo({
      findByEmailOrPhone: jest.fn().mockResolvedValue([primary]),
      findPrimarysByIds: jest.fn().mockResolvedValue([primary]),
      findCluster: jest.fn().mockResolvedValue([primary, ...secondaries]),
      create: jest.fn(),
    });
    const service = new IdentityService(repo);

    const result = await service.identify({ email: "test@example.com", phoneNumber: null });

    expect(result.contact.secondaryContactIds).toEqual([2, 3, 5, 8]);
  });
});
