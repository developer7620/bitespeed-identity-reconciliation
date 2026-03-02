import { PrismaClient } from "@prisma/client";

// Singleton pattern: prevents exhausting the DB connection pool during
// hot-reloads in development (Next.js / ts-node-dev both re-evaluate modules).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["error", "warn"]  // omit "query" in prod to avoid leaking PII in logs
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
