import { createInMemoryStore, type LedgerStore } from "./store.js"
import { PeriodRegistry } from "./periods.js"
import { JournalWriter } from "./journal-writer.js"
import { reverseEntry, reverseTransfer } from "./reversal.js"
import type { Book, EntryInput, JournalEntry } from "./types.js"

export * from "./types.js"
export * from "./errors.js"
export { PeriodRegistry } from "./periods.js"
export { JournalWriter } from "./journal-writer.js"
export { reverseEntry, reverseTransfer } from "./reversal.js"
export { createInMemoryStore } from "./store.js"
export type { LedgerStore } from "./store.js"

/**
 * One assembled ledger: an append-only store, a period registry, and the single
 * writer over them, plus a few readers. The readers derive everything from the
 * posted lines, they never recompute "the truth" a second way, because two code
 * paths computing the truth is how two different truths are born.
 */
export function createLedger() {
  const store: LedgerStore = createInMemoryStore()
  const periods = new PeriodRegistry()
  const writer = new JournalWriter(store, periods)

  return {
    store,
    periods,
    writer,
    post: (input: EntryInput) => writer.post(input),
    reverse: (entryId: string, opts: { idempotencyKey: string; date: string; memo?: string }) =>
      reverseEntry(writer, store, entryId, opts),
    reverseTransfer: (
      transferId: string,
      opts: { date: string; idempotencyKeyPrefix: string; memo?: string },
    ) => reverseTransfer(writer, store, transferId, opts),

    /** Net balance per account, read straight from the posted journal lines. */
    balances(book?: Book): Map<string, number> {
      const out = new Map<string, number>()
      for (const entry of store.all()) {
        if (book && entry.book !== book) continue
        for (const line of entry.lines) {
          const key = `${line.book}:${line.account}`
          const signed = line.side === "debit" ? line.amount : -line.amount
          out.set(key, (out.get(key) ?? 0) + signed)
        }
      }
      return out
    },

    /**
     * The books hold money, never lose or invent it. Across every posted line the
     * debits and credits must still sum to zero. This is the conservation check a
     * statement run can assert before it trusts the numbers.
     */
    isConserved(): boolean {
      let net = 0
      for (const entry of store.all()) {
        for (const line of entry.lines) {
          net += line.side === "debit" ? line.amount : -line.amount
        }
      }
      return net === 0
    },

    head: (): number => store.head(),
  }
}

export type Ledger = ReturnType<typeof createLedger>
export type { JournalEntry }
