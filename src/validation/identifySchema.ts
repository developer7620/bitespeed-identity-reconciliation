import { z } from "zod";
import { IdentifyInput } from "../types/contact";

// ─────────────────────────────────────────────────────────────────────────────
// Zod schema for POST /identify request body
// ─────────────────────────────────────────────────────────────────────────────

const phoneRegex = /^\+?[1-9]\d{4,14}$/; // E.164-ish: optional +, 5–15 digits

export const identifySchema = z
  .object({
    email: z
      .string()
      .trim()
      .email("Invalid email format")
      .nullable()
      .optional(),

    phoneNumber: z
      .union([
        z.string().trim().regex(phoneRegex, "Invalid phone number format"),
        z.number().int().positive().transform(String), // accept numeric input too
      ])
      .nullable()
      .optional(),
  })
  // At least one field must be a non-empty, non-null value
  .refine(
    (data) =>
      (data.email != null && data.email !== "") ||
      (data.phoneNumber != null && data.phoneNumber !== ""),
    {
      message: "At least one of 'email' or 'phoneNumber' must be provided",
      path: [], // top-level error
    }
  );

export type IdentifySchema = z.infer<typeof identifySchema>;

/**
 * Parse + validate raw request body.
 * Returns { success, data } or { success: false, errors }.
 */
export function parseIdentifyRequest(body: unknown):
  | { success: true; data: IdentifyInput }
  | { success: false; errors: z.ZodIssue[] } {
  const result = identifySchema.safeParse(body);
  if (!result.success) {
    return { success: false, errors: result.error.issues };
  }
  return {
    success: true,
    data: {
      email: result.data.email ?? null,
      phoneNumber: result.data.phoneNumber ?? null,
    },
  };
}
