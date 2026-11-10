import type { EntryInput, JournalEntry } from "./types.js"
import type { LedgerStore } from "./store.js"
import type { PeriodRegistry } from "./periods.js"
import { assertMinor } from "./money.js"
import { ClosedPeriod, CrossBookLine, EmptyEntry, UnbalancedEntry } from "./errors.js"
import { periodOf } from "./types.js"

/**
 * The single door in. Every posting goes through `post`; nothing else writes to the
 * books. Because there is exactly one door, every guarantee below holds for every
 * write, with no per-caller discipline required:
 *
 *  - idempotent: a posting is keyed by its source event, so replay never double-posts
 *  - every line's book matches the entry's book (a line cannot span two books)
 *  - amounts are positive integer minor units with a stated side
 *  - the entry balances (sum of debits == sum of credits)
 *  - it refuses to post into a closed period
 *  - it commits the whole entry or nothing
 */
export class JournalWriter {
  constructor(
    private readonly store: LedgerStore,
    private readonly periods: PeriodRegistry,
  ) {}

  post(input: EntryInput): JournalEntry {
    // Idempotency first: replaying the same source event returns the original
    // posting untouched, so a retried or duplicated request is always safe.
    const replay = this.store.byIdempotencyKey(input.idempotencyKey)
    if (replay) return replay

    if (input.lines.length < 2) throw new EmptyEntry()

    let debit = 0
    let credit = 0
    for (const line of input.lines) {
      if (line.book !== input.book) throw new CrossBookLine()
      assertMinor(line.amount, "line.amount")
      if (line.amount <= 0) {
        throw new TypeError(`line.amount must be positive, got ${line.amount}`)
      }
      if (line.side === "debit") debit += line.amount
      else credit += line.amount
    }

    if (debit !== credit) throw new UnbalancedEntry(debit, credit)

    const period = periodOf(input.date) // also validates the date shape
    if (this.periods.isClosedPeriod(input.book, period)) {
      throw new ClosedPeriod(input.book, period)
    }

    // Commit the whole entry, or (because any throw above happened first) nothing.
    return this.store.append({
      idempotencyKey: input.idempotencyKey,
      book: input.book,
      date: input.date,
      lines: input.lines,
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
      ...(input.reversesEntryId !== undefined ? { reversesEntryId: input.reversesEntryId } : {}),
      ...(input.transferId !== undefined ? { transferId: input.transferId } : {}),
    })
  }
}
