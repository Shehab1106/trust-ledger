import type { JournalEntry, JournalLine, Side } from "./types.js"
import type { LedgerStore } from "./store.js"
import type { JournalWriter } from "./journal-writer.js"
import { AlreadyReversed, NotFound, ReverseLegDirectly } from "./errors.js"

function flip(side: Side): Side {
  return side === "debit" ? "credit" : "debit"
}

function mirror(line: JournalLine): JournalLine {
  return { ...line, side: flip(line.side) }
}

/**
 * Correction by reversal, never by edit. You never change a posted entry. A
 * correction is a NEW entry that mirrors the original (every side flipped) and
 * points back at it, so the mistake and its fix both stay on the record, which is
 * what an auditor expects and a regulator requires.
 *
 * The reversal goes through the same single door, so it is itself balanced,
 * period-checked and idempotent. A cross-book transfer's legs cannot be reversed
 * one at a time; you reverse the transfer, so the two books can never drift apart.
 */
export function reverseEntry(
  writer: JournalWriter,
  store: LedgerStore,
  entryId: string,
  opts: { idempotencyKey: string; date: string; memo?: string },
): JournalEntry {
  const original = store.get(entryId)
  if (!original) throw new NotFound(entryId)
  if (original.transferId) throw new ReverseLegDirectly()
  if (store.reversalOf(entryId)) throw new AlreadyReversed(entryId)

  return writer.post({
    idempotencyKey: opts.idempotencyKey,
    book: original.book,
    date: opts.date,
    lines: original.lines.map(mirror),
    memo: opts.memo ?? `reversal of ${entryId}`,
    reversesEntryId: entryId,
  })
}

/**
 * Reverse both legs of a cross-book transfer as one operation. Reversing a single
 * leg is refused (see reverseEntry), so trust and operating stay in lockstep.
 */
export function reverseTransfer(
  writer: JournalWriter,
  store: LedgerStore,
  transferId: string,
  opts: { date: string; idempotencyKeyPrefix: string; memo?: string },
): JournalEntry[] {
  const legs = store.all().filter((e) => e.transferId === transferId && !e.reversesEntryId)
  if (legs.length === 0) throw new NotFound(`transfer:${transferId}`)

  return legs.map((leg) =>
    writer.post({
      idempotencyKey: `${opts.idempotencyKeyPrefix}:${leg.id}`,
      book: leg.book,
      date: opts.date,
      lines: leg.lines.map(mirror),
      memo: opts.memo ?? `reversal of transfer ${transferId}`,
      reversesEntryId: leg.id,
      transferId,
    }),
  )
}
