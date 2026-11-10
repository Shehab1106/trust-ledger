import type { Minor } from "./money.js"

/** Every line is one side of the entry. */
export type Side = "debit" | "credit"

/**
 * Two books per team, never commingled. Guest and owner money lives in `trust`;
 * the manager's own revenue and costs live in `operating`. A single entry's lines
 * all belong to one book, so a line can never span the two.
 */
export type Book = "trust" | "operating"

/**
 * A posted line. The id fields are *remembered, not enforced*: they record which
 * property / reservation / transaction / party this posting related to at the time.
 * In the database they are plain columns with NO foreign key (see db/schema.sql),
 * so a source row can be deleted and regenerated without ever touching the ledger.
 */
export interface JournalLine {
  book: Book
  account: string
  side: Side
  amount: Minor
  propertyId?: string
  reservationId?: string
  transactionId?: string
  partyId?: string
}

export interface EntryInput {
  /** Keyed by its source event. Replaying the same key never double-posts. */
  idempotencyKey: string
  book: Book
  /** The economic date of the event (YYYY-MM-DD), not the time it was recorded. */
  date: string
  lines: JournalLine[]
  memo?: string
  /** Set only when this entry reverses another; links the fix back to the mistake. */
  reversesEntryId?: string
  /** Set only on the two legs of a cross-book transfer; ties them together. */
  transferId?: string
}

/** A committed, immutable entry. Nothing ever updates or deletes one. */
export interface JournalEntry extends EntryInput {
  id: string
  /** Monotonic per ledger. A statement pins to the highest sequence it read. */
  sequence: number
  postedAt: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function periodOf(date: string): string {
  if (!ISO_DATE.test(date)) throw new TypeError(`date must be YYYY-MM-DD, got ${date}`)
  return date.slice(0, 7) // YYYY-MM
}
