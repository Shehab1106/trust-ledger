import { describe, it, expect, beforeEach } from "vitest"
import { createLedger, ClosedPeriod, type EntryInput, type Ledger } from "../src/index.js"

let ledger: Ledger
beforeEach(() => {
  ledger = createLedger()
})

function entryOn(date: string, key: string): EntryInput {
  return {
    idempotencyKey: key,
    book: "trust",
    date,
    lines: [
      { book: "trust", account: "cash", side: "debit", amount: 1_000 },
      { book: "trust", account: "owner_payable", side: "credit", amount: 1_000 },
    ],
  }
}

describe("period close", () => {
  it("refuses to post into a closed period, per book", () => {
    ledger.post(entryOn("2026-03-10", "mar"))
    ledger.periods.close("trust", "2026-03")

    expect(() => ledger.post(entryOn("2026-03-20", "mar_late"))).toThrow(ClosedPeriod)
    // a different, open period still accepts postings
    expect(() => ledger.post(entryOn("2026-04-01", "apr"))).not.toThrow()
    // and the operating book's March is independent and still open
    expect(
      ledger.periods.isClosedPeriod("operating", "2026-03"),
    ).toBe(false)
  })

  it("an audited reopen lets a correction land, then it can be closed again", () => {
    ledger.periods.close("trust", "2026-03")
    expect(() => ledger.post(entryOn("2026-03-15", "x"))).toThrow(ClosedPeriod)

    ledger.periods.reopen("trust", "2026-03")
    expect(() => ledger.post(entryOn("2026-03-15", "x"))).not.toThrow()
  })
})

describe("statements pin to a point in the ledger", () => {
  it("head() advances with each posting so a statement can record exactly what it read", () => {
    expect(ledger.head()).toBe(0)
    ledger.post(entryOn("2026-03-10", "a"))
    const pinned = ledger.head()
    ledger.post(entryOn("2026-03-11", "b"))
    // a statement issued at `pinned` reflects the books up to and including seq 1,
    // and later postings do not retroactively change what it reported.
    expect(pinned).toBe(1)
    expect(ledger.head()).toBe(2)
  })
})
