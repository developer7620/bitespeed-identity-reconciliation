// ─────────────────────────────────────────────────────────────────────────────
// Domain types — shared across controller / service / repository layers
// ─────────────────────────────────────────────────────────────────────────────

export type LinkPrecedence = "primary" | "secondary";

export interface ContactRow {
  id: number;
  phoneNumber: string | null;
  email: string | null;
  linkedId: number | null;
  linkPrecedence: LinkPrecedence;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

// Validated, normalised input — produced by the validation layer
export interface IdentifyInput {
  email: string | null;
  phoneNumber: string | null;
}

// API response — must stay stable (BiteSpeed spec)
export interface ContactResponse {
  contact: {
    primaryContatctId: number; // typo preserved intentionally (spec requirement)
    emails: string[];
    phoneNumbers: string[];
    secondaryContactIds: number[];
  };
}
