import type { JournalEntry } from "./types.js"

/**
 * Append-only store. It exposes no update and no delete, by design: once an entry
 * is appended it cannot be changed. That is the whole point of a ledger, so the
 * guarantee lives in the type, not in a convention the next caller has to remember.
 * (db/schema.sql shows the same guarantee enforced by the database itself.)
 */
export interface LedgerStore {
  append(entry: Omit<JournalEntry, "sequence" | "id" | "postedAt">): JournalEntry
  get(id: string): JournalEntry | undefined
  byIdempotencyKey(key: string): JournalEntry | undefined
  /** The reversal entry that reverses `id`, if one exists. */
  reversalOf(id: string): JournalEntry | undefined
  all(): readonly JournalEntry[]
  /** Highest sequence posted so far; a statement pins to this. */
  head(): number
}

let counter = 0
function newId(prefix: string): string {
  counter += 1
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`
}

export function createInMemoryStore(): LedgerStore {
  const entries: JournalEntry[] = []
  const byKey = new Map<string, JournalEntry>()
  const byReverses = new Map<string, JournalEntry>()
  let sequence = 0

  return {
    append(partial) {
      // Deep-copy and freeze on the way in, so neither the caller's retained
      // reference nor a later careless mutation can rewrite posted history.
      const lines = partial.lines.map((l) => Object.freeze({ ...l })) as JournalEntry["lines"]
      const entry: JournalEntry = {
        ...partial,
        lines,
        id: newId("je"),
        sequence: ++sequence,
        postedAt: new Date().toISOString(),
      }
      Object.freeze(lines)
      Object.freeze(entry)
      entries.push(entry)
      byKey.set(entry.idempotencyKey, entry)
      if (entry.reversesEntryId) byReverses.set(entry.reversesEntryId, entry)
      return entry
    },
    get: (id) => entries.find((e) => e.id === id),
    byIdempotencyKey: (key) => byKey.get(key),
    reversalOf: (id) => byReverses.get(id),
    all: () => entries.slice(),
    head: () => sequence,
  }
}
