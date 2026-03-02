import { Request, Response } from "express";
import { parseIdentifyRequest } from "../validation/identifySchema";
import { IdentityService } from "../services/identityService";
import { logger } from "../logger";

// ─────────────────────────────────────────────────────────────────────────────
// IdentifyController
//
// Responsibility: HTTP concerns only.
//   • Parse + validate the request body (via validation layer)
//   • Call the service
//   • Map service result / errors to HTTP responses
//
// No business logic lives here.
// ─────────────────────────────────────────────────────────────────────────────

export class IdentifyController {
  constructor(private readonly service: IdentityService) {}

  handle = async (req: Request, res: Response): Promise<void> => {
    // ── Validate ─────────────────────────────────────────────────────────────
    const parsed = parseIdentifyRequest(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parsed.errors.map((e) => ({
          path: e.path.join(".") || "root",
          message: e.message,
        })),
      });
      return;
    }

    const { email, phoneNumber } = parsed.data;
    logger.info("Identify request received", {
      email: email ?? "(none)",
      phoneNumber: phoneNumber ?? "(none)",
    });

    // ── Execute ───────────────────────────────────────────────────────────────
    try {
      const result = await this.service.identify(parsed.data);
      res.status(200).json(result);
    } catch (error: unknown) {
      // Unique-constraint violation: two concurrent requests tried to insert
      // the exact same (email, phoneNumber) pair simultaneously. The loser
      // should just re-run the identify flow — but since this is rare and
      // Serializable transactions already handle most races, we surface a
      // clean 409 instead of a generic 500.
      if (isPrismaUniqueError(error)) {
        logger.warn("Duplicate insert prevented by unique constraint — concurrent race", {
          email,
          phoneNumber,
        });
        res.status(409).json({
          error: "Concurrent request conflict. Please retry.",
        });
        return;
      }

      logger.error("Unhandled error in identify", { error });
      res.status(500).json({ error: "Internal server error." });
    }
  };
}

function isPrismaUniqueError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "P2002"
  );
}
