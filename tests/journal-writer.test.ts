import { describe, it, expect, beforeEach } from "vitest"
import {
  createLedger,
  CrossBookLine,
  EmptyEntry,
  UnbalancedEntry,
  type EntryInput,
  type Ledger,
} from "../src/index.js"

let ledger: Ledger
beforeEach(() => {
  ledger = createLedger()
})

/** A balanced trust posting: a guest's rent recognised to the owner's payable. */
function rent(key = "evt_1"): EntryInput {
  return {
    idempotencyKey: key,
    book: "trust",
    date: "2026-03-10",
    lines: [
      { book: "trust", account: "cash", side: "debit", amount: 50_000, reservationId: "r_1" },
      { book: "trust", account: "owner_payable", side: "credit", amount: 50_000, reservationId: "r_1" },
    ],
  }
}

describe("the single write door", () => {
  it("posts a balanced entry and stamps a monotonic sequence", () => {
    const e = ledger.post(rent())
    expect(e.sequence).toBe(1)
    expect(ledger.head()).toBe(1)
    expect(ledger.isConserved()).toBe(true)
  })

  it("refuses an unbalanced entry", () => {
    const bad = rent()
    bad.lines[1]!.amount = 49_999
    expect(() => ledger.post(bad)).toThrow(UnbalancedEntry)
    expect(ledger.head()).toBe(0) // nothing committed
  })

  it("refuses non-positive or fractional amounts", () => {
    const zero = rent("z")
    zero.lines[0]!.amount = 0
    expect(() => ledger.post(zero)).toThrow()

    const frac = rent("f")
    frac.lines[0]!.amount = 50_000.5
    frac.lines[1]!.amount = 50_000.5
    expect(() => ledger.post(frac)).toThrow(/integer minor units/)
  })

  it("refuses a line whose book differs from the entry's book", () => {
    const mixed = rent("m")
    mixed.lines[1]!.book = "operating"
    expect(() => ledger.post(mixed)).toThrow(CrossBookLine)
  })

  it("refuses an entry with fewer than two lines", () => {
    const single: EntryInput = { ...rent("s"), lines: [rent().lines[0]!] }
    expect(() => ledger.post(single)).toThrow(EmptyEntry)
  })

  it("is idempotent: replaying the same key returns the original, never double-posts", () => {
    const first = ledger.post(rent("same"))
    const again = ledger.post(rent("same"))
    expect(again.id).toBe(first.id)
    expect(again.sequence).toBe(first.sequence)
    expect(ledger.store.all()).toHaveLength(1)
  })

  it("keeps posted entries immutable (append-only)", () => {
    const input = rent()
    const e = ledger.post(input)

    // the store kept its own copy: mutating the input after posting changes nothing
    input.lines[0]!.amount = 999
    expect(ledger.balances("trust").get("trust:cash")).toBe(50_000)

    // the posted entry itself is frozen; posted history cannot be rewritten
    expect(Object.isFrozen(e)).toBe(true)
    expect(Object.isFrozen(e.lines)).toBe(true)
    expect(Object.isFrozen(e.lines[0])).toBe(true)

    // and the store exposes no update or delete, by design
    expect("update" in ledger.store).toBe(false)
    expect("delete" in ledger.store).toBe(false)
  })
})
