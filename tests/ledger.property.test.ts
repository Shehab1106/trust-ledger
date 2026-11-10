/**
 * Property-based tests for the ledger's core promise: it never loses or invents
 * money. Instead of a few scripted bookings, these post hundreds of randomized
 * balanced entries and assert conservation holds every time, and that any
 * unbalanced entry is always refused — the invariant checked across the input
 * space, not one example.
 */
import { describe, it, expect } from "vitest"
import fc from "fast-check"
import { createLedger, type Book } from "../src/index"

const BOOKS: Book[] = ["trust", "operating"]
const ACCOUNTS = ["cash", "owner_payable", "due_to_operating", "tax_payable", "commission_income", "rent_expense", "rental_income"]

describe("ledger conservation (property-based)", () => {
  it("stays conserved and each book nets to zero over any sequence of balanced entries", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            book: fc.constantFrom(...BOOKS),
            debit: fc.constantFrom(...ACCOUNTS),
            credit: fc.constantFrom(...ACCOUNTS),
            amount: fc.integer({ min: 1, max: 10_000_000 }),
          }),
          { maxLength: 40 },
        ),
        (entries) => {
          const ledger = createLedger()
          entries.forEach((e, i) => {
            ledger.post({
              idempotencyKey: `e_${i}`,
              book: e.book,
              date: "2026-03-10",
              memo: `#${i}`,
              lines: [
                { book: e.book, account: e.debit, side: "debit", amount: e.amount },
                { book: e.book, account: e.credit, side: "credit", amount: e.amount },
              ],
            })
          })
          expect(ledger.isConserved()).toBe(true)
          for (const b of BOOKS) {
            const total = [...ledger.balances(b).values()].reduce((s, n) => s + n, 0)
            expect(total).toBe(0)
          }
        },
      ),
    )
  })

  it("refuses any unbalanced entry (debits != credits)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 1, max: 1_000_000 }), (d, c) => {
        fc.pre(d !== c)
        const ledger = createLedger()
        expect(() =>
          ledger.post({
            idempotencyKey: "u",
            book: "trust",
            date: "2026-03-10",
            memo: "unbalanced",
            lines: [
              { book: "trust", account: "cash", side: "debit", amount: d },
              { book: "trust", account: "owner_payable", side: "credit", amount: c },
            ],
          }),
        ).toThrow()
      }),
    )
  })
})
