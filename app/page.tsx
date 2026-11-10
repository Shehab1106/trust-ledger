"use client"

import { useReducer, useRef } from "react"
import { createLedger, type Ledger, type JournalEntry, type Book } from "../src/index"

const fmt = (m: number) =>
  (m / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })

type Flash = { kind: "idle" | "ok" | "bad"; msg: string; detail?: string }

const BOOKING = "2026-03-10"
const PAYOUT = "2026-03-31"

export default function Console() {
  const ledgerRef = useRef<Ledger | null>(null)
  if (ledgerRef.current === null) ledgerRef.current = createLedger()
  const ledger = ledgerRef.current

  const c = useRef({ booking: 0, transfer: 0, rev: 0, bad: 0 })
  const closedRef = useRef(false)
  const [, force] = useReducer((x: number) => x + 1, 0)
  const flashRef = useRef<Flash>({ kind: "idle", msg: "Every button below drives the real reference ledger. Try to break it." })

  function setFlash(f: Flash) {
    flashRef.current = f
    force()
  }
  function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
  }

  function recordBooking() {
    const n = ++c.current.booking
    try {
      const e = ledger.post({
        idempotencyKey: `bk_${n}`,
        book: "trust",
        date: BOOKING,
        memo: `Booking BK-${String(n).padStart(3, "0")}`,
        lines: [
          { book: "trust", account: "cash", side: "debit", amount: 50_000, reservationId: `r_${n}` },
          { book: "trust", account: "owner_payable", side: "credit", amount: 44_000, reservationId: `r_${n}` },
          { book: "trust", account: "tax_payable", side: "credit", amount: 6_000, reservationId: `r_${n}` },
        ],
      })
      setFlash({ kind: "ok", msg: `Posted entry #${e.sequence}: a $500.00 booking split into the owner's revenue and tax held in trust.` })
    } catch (e) {
      c.current.booking--
      setFlash({ kind: "bad", msg: "Refused.", detail: errText(e) })
    }
  }

  function disburse() {
    const n = ++c.current.transfer
    const tid = `t_${n}`
    try {
      ledger.post({
        idempotencyKey: `pay_${n}`, book: "trust", date: PAYOUT, transferId: tid, memo: `Owner payout #${n}`,
        lines: [
          { book: "trust", account: "owner_payable", side: "debit", amount: 44_000 },
          { book: "trust", account: "cash", side: "credit", amount: 44_000 },
        ],
      })
      ledger.post({
        idempotencyKey: `fee_${n}`, book: "operating", date: PAYOUT, transferId: tid, memo: `Management fee #${n}`,
        lines: [
          { book: "operating", account: "cash", side: "debit", amount: 5_000 },
          { book: "operating", account: "mgmt_fee_income", side: "credit", amount: 5_000 },
        ],
      })
      setFlash({ kind: "ok", msg: "Disbursed to the owner: two linked legs, one in the trust book and one in the operating book." })
    } catch (e) {
      c.current.transfer--
      setFlash({ kind: "bad", msg: "Refused.", detail: errText(e) })
    }
  }

  function reverseLast() {
    const all = ledger.store.all()
    const candidate = [...all].reverse().find((e) => !e.reversesEntryId && !ledger.store.reversalOf(e.id))
    if (!candidate) {
      setFlash({ kind: "bad", msg: "Nothing left to reverse." })
      return
    }
    try {
      if (candidate.transferId) {
        ledger.reverseTransfer(candidate.transferId, { date: "2026-04-01", idempotencyKeyPrefix: `rev_${++c.current.rev}` })
        setFlash({ kind: "ok", msg: "Reversed both legs of the transfer together. A single leg can't be reversed on its own." })
      } else {
        const r = ledger.reverse(candidate.id, { idempotencyKey: `rev_${++c.current.rev}`, date: "2026-04-01" })
        setFlash({ kind: "ok", msg: `Corrected entry #${candidate.sequence} with a reversing entry #${r.sequence}. The mistake and the fix both stay on the record.` })
      }
    } catch (e) {
      setFlash({ kind: "bad", msg: "Refused.", detail: errText(e) })
    }
  }

  function closeMonth() {
    ledger.periods.close("trust", "2026-03")
    ledger.periods.close("operating", "2026-03")
    closedRef.current = true
    setFlash({ kind: "ok", msg: "Closed the period 2026-03. New postings dated in March are now refused. Record a booking to see it." })
  }

  function brokenEntry() {
    try {
      ledger.post({
        idempotencyKey: `bad_${++c.current.bad}`,
        book: "trust",
        date: "2026-03-15",
        memo: "(deliberately broken)",
        lines: [
          { book: "trust", account: "cash", side: "debit", amount: 50_000 },
          { book: "trust", account: "owner_payable", side: "credit", amount: 40_000 },
        ],
      })
      setFlash({ kind: "bad", msg: "That should never have posted. (It did; that's a bug.)" })
    } catch (e) {
      setFlash({ kind: "bad", msg: "Refused, exactly as it should be. Nothing was written.", detail: errText(e) })
    }
  }

  function reset() {
    ledgerRef.current = createLedger()
    c.current = { booking: 0, transfer: 0, rev: 0, bad: 0 }
    closedRef.current = false
    setFlash({ kind: "idle", msg: "Fresh ledger." })
  }

  // ---- reads (straight off the books) ----
  const entries = ledger.store.all()
  const bookAccounts = (book: Book) =>
    [...ledger.balances(book).entries()]
      .map(([key, net]) => ({ account: key.slice(book.length + 1), net }))
      .sort((a, b) => a.account.localeCompare(b.account))
  const bookTotal = (book: Book) => bookAccounts(book).reduce((s, a) => s + a.net, 0)
  const flash = flashRef.current

  return (
    <main className="wrap">
      <div className="top">
        <div className="brand">
          <span className="glyph" aria-hidden />
          <div>
            <h1><span className="mono">trust-ledger</span></h1>
            <div className="sub">live console</div>
          </div>
          <span className="chip" style={{ marginLeft: 8 }}>in-browser</span>
        </div>
        <div className="top-links">
          <a href="https://github.com/Shehab1106/trust-ledger" target="_blank" rel="noopener noreferrer">Code &amp; write-up</a>
          <a href="https://github.com/Shehab1106/trust-ledger#readme" target="_blank" rel="noopener noreferrer">The decisions</a>
        </div>
      </div>

      <p className="lede">
        This runs the real <b>reference ledger</b> in your browser, the same code the test suite checks.
        Post a booking, pay an owner, reverse an entry, close the month, then try to slip in a broken one.
        Every write goes through <b>one door</b>: it balances to the cent, it can't be edited after, and a
        bad entry is refused outright.
      </p>

      <div className="grid">
        <aside className="panel-card">
          <h2>Actions</h2>
          <div className="actions">
            <button className="btn btn-primary" onClick={recordBooking}>Record a booking <span className="n">trust</span></button>
            <button className="btn" onClick={disburse}>Disburse to owner <span className="n">transfer</span></button>
            <button className="btn" onClick={reverseLast}>Reverse last entry <span className="n">correction</span></button>
            <button className="btn" onClick={closeMonth}>Close the month <span className="n">lock 2026-03</span></button>
            <button className="btn btn-danger" onClick={brokenEntry}>Attempt a broken entry <span className="n">unbalanced</span></button>
            <button className="btn btn-ghost" onClick={reset}>Reset</button>
          </div>
          <div className={`flash ${flash.kind === "idle" ? "" : flash.kind}`}>
            {flash.msg}
            {flash.detail ? <><br /><span className="mono">{flash.detail}</span></> : null}
          </div>
        </aside>

        <section>
          <div className="books">
            {(["trust", "operating"] as Book[]).map((book) => {
              const accts = bookAccounts(book)
              return (
                <div className={`book ${book}`} key={book}>
                  <h3><span className="dot" /> {book} book</h3>
                  {accts.length === 0 ? (
                    <div className="empty">no postings yet</div>
                  ) : (
                    accts.map((a) => (
                      <div className="acct" key={a.account}>
                        <span className="k">{a.account}</span>
                        <span className={`v ${a.net < 0 ? "neg" : ""}`}>{fmt(a.net)}</span>
                      </div>
                    ))
                  )}
                  <div className="foot">
                    <span>book balances to</span>
                    <span className="bal">{fmt(bookTotal(book))} ✓</span>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="journal-head">
            <h2>Journal</h2>
            <span className="seq">append-only · {entries.length} {entries.length === 1 ? "entry" : "entries"} · head #{ledger.head()}</span>
          </div>
          <div className="journal">
            {entries.length === 0 && (
              <div className="panel-card" style={{ color: "var(--muted)", fontSize: 13 }}>
                The journal is empty. Record a booking to post the first entry.
              </div>
            )}
            {[...entries].reverse().map((e: JournalEntry) => {
              const isReversed = Boolean(ledger.store.reversalOf(e.id))
              const reverses = e.reversesEntryId ? entries.find((x) => x.id === e.reversesEntryId) : undefined
              return (
                <article className={`entry ${isReversed ? "reversed" : ""}`} key={e.id}>
                  <div className="entry-head">
                    <span className="seqbadge">#{e.sequence}</span>
                    <span className={`bookbadge ${e.book}`}>{e.book}</span>
                    <span className="entry-memo">{e.memo}</span>
                    {reverses ? <span className="rev-tag">reverses #{reverses.sequence}</span> : null}
                    <span className="entry-date">{e.date}</span>
                  </div>
                  <div className="lines">
                    {e.lines.map((l, i) => (
                      <div className="line" key={i}>
                        <span className="acct-name">{l.account}</span>
                        <span className={`side ${l.side}`}>{l.side}</span>
                        <span className="amt">{fmt(l.amount)}</span>
                      </div>
                    ))}
                  </div>
                </article>
              )
            })}
          </div>

          <p className="footnote">
            Nothing here is a mock: the buttons call a real double-entry ledger (single write boundary,
            append-only store, correction by reversal, locked periods, trust/operating separation). The
            same code ships with a <a href="https://github.com/Shehab1106/trust-ledger" target="_blank" rel="noopener noreferrer">passing test suite and a Postgres schema</a> that
            enforces the invariants at the database layer, including the no-foreign-key decision on the journal lines.
          </p>
        </section>
      </div>
    </main>
  )
}
