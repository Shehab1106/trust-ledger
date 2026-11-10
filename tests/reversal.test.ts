import { describe, it, expect, beforeEach } from "vitest"
import {
  createLedger,
  AlreadyReversed,
  ReverseLegDirectly,
  NotFound,
  type EntryInput,
  type Ledger,
} from "../src/index.js"

let ledger: Ledger
beforeEach(() => {
  ledger = createLedger()
})

function rent(key = "evt_1"): EntryInput {
  return {
    idempotencyKey: key,
    book: "trust",
    date: "2026-03-10",
    lines: [
      { book: "trust", account: "cash", side: "debit", amount: 50_000 },
      { book: "trust", account: "owner_payable", side: "credit", amount: 50_000 },
    ],
  }
}

describe("correction by reversal", () => {
  it("mirrors the original, links back to it, and leaves both on the record", () => {
    const original = ledger.post(rent())
    const reversal = ledger.reverse(original.id, { idempotencyKey: "rev_1", date: "2026-03-12" })

    expect(reversal.reversesEntryId).toBe(original.id)
    // sides are flipped
    expect(reversal.lines[0]!.side).toBe("credit")
    expect(reversal.lines[1]!.side).toBe("debit")
    // both entries are still there; nothing was edited away
    expect(ledger.store.all()).toHaveLength(2)
    // and the money nets back to zero
    expect(ledger.balances("trust").get("trust:cash")).toBe(0)
    expect(ledger.isConserved()).toBe(true)
  })

  it("refuses to reverse the same entry twice", () => {
    const original = ledger.post(rent())
    ledger.reverse(original.id, { idempotencyKey: "rev_1", date: "2026-03-12" })
    expect(() =>
      ledger.reverse(original.id, { idempotencyKey: "rev_2", date: "2026-03-12" }),
    ).toThrow(AlreadyReversed)
  })

  it("throws when reversing an entry that does not exist", () => {
    expect(() => ledger.reverse("nope", { idempotencyKey: "x", date: "2026-03-12" })).toThrow(
      NotFound,
    )
  })
})

describe("cross-book transfers stay in lockstep", () => {
  // A disbursement: owner money leaves the trust book and the management fee is
  // recognised in the operating book. Two linked entries, one per book.
  function disburse(): void {
    ledger.post({
      idempotencyKey: "pay_trust",
      book: "trust",
      date: "2026-03-31",
      transferId: "t_1",
      lines: [
        { book: "trust", account: "owner_payable", side: "debit", amount: 45_000 },
        { book: "trust", account: "cash", side: "credit", amount: 45_000 },
      ],
    })
    ledger.post({
      idempotencyKey: "fee_operating",
      book: "operating",
      date: "2026-03-31",
      transferId: "t_1",
      lines: [
        { book: "operating", account: "cash", side: "debit", amount: 5_000 },
        { book: "operating", account: "management_fee_income", side: "credit", amount: 5_000 },
      ],
    })
  }

  it("refuses to reverse a single leg directly", () => {
    disburse()
    const trustLeg = ledger.store.all().find((e) => e.book === "trust" && e.transferId === "t_1")!
    expect(() =>
      ledger.reverse(trustLeg.id, { idempotencyKey: "oops", date: "2026-04-01" }),
    ).toThrow(ReverseLegDirectly)
  })

  it("reverses both legs together", () => {
    disburse()
    const reversals = ledger.reverseTransfer("t_1", {
      date: "2026-04-01",
      idempotencyKeyPrefix: "rev_t1",
    })
    expect(reversals).toHaveLength(2)
    expect(reversals.every((r) => r.reversesEntryId)).toBe(true)
    // every account nets back to zero across both books
    for (const net of ledger.balances().values()) expect(net).toBe(0)
    expect(ledger.isConserved()).toBe(true)
  })
})
