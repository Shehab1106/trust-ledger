"use client"

import { useReducer, useRef, useState } from "react"
import { createLedger, type Ledger, type JournalEntry, type Book, type JournalLine } from "../src/index"

const fmt = (m: number) =>
  (m / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })

const toMinor = (s: string) => Math.round((parseFloat(s) || 0) * 100)

type Flash = { kind: "idle" | "ok" | "bad"; msg: string; detail?: string }
type Model = "management" | "arbitrage"

const BOOKING_DATE = "2026-03-10"
const PAY_DATE = "2026-03-31"

export default function Console() {
  const ledgerRef = useRef<Ledger | null>(null)
  if (ledgerRef.current === null) ledgerRef.current = createLedger()
  const ledger = ledgerRef.current

  const c = useRef({ booking: 0, pay: 0, sweep: 0, rev: 0, bad: 0 })
  const [, force] = useReducer((x: number) => x + 1, 0)
  const flashRef = useRef<Flash>({
    kind: "idle",
    msg: "Set the agreement, then record a booking. Every button drives the real reference ledger.",
  })
  const setFlash = (f: Flash) => {
    flashRef.current = f
    force()
  }
  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

  const [model, setModel] = useState<Model>("management")
  const [bookingAmt, setBookingAmt] = useState("500.00")
  const [feePct, setFeePct] = useState("15")
  const [vatPct, setVatPct] = useState("5")
  const [rent, setRent] = useState("300.00")

  function switchModel(next: Model) {
    if (next === model) return
    setModel(next)
    ledgerRef.current = createLedger()
    c.current = { booking: 0, pay: 0, sweep: 0, rev: 0, bad: 0 }
    setFlash({
      kind: "idle",
      msg:
        next === "management"
          ? "Management model: the owner's money is held in the trust book; you only earn the commission."
          : "Arbitrage model: you keep the revenue in the operating book and pay the owner a fixed rent. The trust book stays empty.",
    })
  }

  // amount owed on a credit-normal account (balance is negative)
  const owed = (book: Book, account: string) =>
    -(ledger.balances(book).get(`${book}:${account}`) ?? 0)

  function keep(lines: JournalLine[]) {
    return lines.filter((l) => l.amount > 0)
  }

  function recordBooking() {
    const gross = toMinor(bookingAmt)
    if (gross <= 0) {
      setFlash({ kind: "bad", msg: "Enter a booking amount first." })
      return
    }
    const vat = Math.max(0, gross - Math.round(gross / (1 + (parseFloat(vatPct) || 0) / 100)))
    const nri = gross - vat
    const n = ++c.current.booking
    try {
      if (model === "management") {
        const commission = Math.round((nri * (parseFloat(feePct) || 0)) / 100)
        const ownerNet = nri - commission
        ledger.post({
          idempotencyKey: `bk_${n}`,
          book: "trust",
          date: BOOKING_DATE,
          memo: `Booking BK-${String(n).padStart(3, "0")}`,
          lines: keep([
            { book: "trust", account: "cash", side: "debit", amount: gross, reservationId: `r_${n}` },
            { book: "trust", account: "owner_payable", side: "credit", amount: ownerNet },
            { book: "trust", account: "due_to_operating", side: "credit", amount: commission },
            { book: "trust", account: "tax_payable", side: "credit", amount: vat },
          ]),
        })
        setFlash({
          kind: "ok",
          msg: `Booking ${fmt(gross)} held in trust — NRI ${fmt(nri)}, owner ${fmt(ownerNet)}, your commission ${fmt(commission)}, VAT ${fmt(vat)}.`,
        })
      } else {
        ledger.post({
          idempotencyKey: `bk_${n}`,
          book: "operating",
          date: BOOKING_DATE,
          memo: `Booking BK-${String(n).padStart(3, "0")}`,
          lines: keep([
            { book: "operating", account: "cash", side: "debit", amount: gross, reservationId: `r_${n}` },
            { book: "operating", account: "rental_income", side: "credit", amount: nri },
            { book: "operating", account: "tax_payable", side: "credit", amount: vat },
          ]),
        })
        setFlash({
          kind: "ok",
          msg: `Booking ${fmt(gross)} is your revenue — NRI ${fmt(nri)} in the operating book, VAT ${fmt(vat)} held as a pass-through.`,
        })
      }
    } catch (e) {
      c.current.booking--
      setFlash({ kind: "bad", msg: "Refused.", detail: errText(e) })
    }
  }

  function payOwner() {
    const n = ++c.current.pay
    try {
      if (model === "management") {
        const amount = owed("trust", "owner_payable")
        if (amount <= 0) {
          c.current.pay--
          setFlash({ kind: "bad", msg: "Nothing owed to the owner yet. Record a booking first." })
          return
        }
        ledger.post({
          idempotencyKey: `pay_${n}`,
          book: "trust",
          date: PAY_DATE,
          memo: `Owner payout #${n}`,
          lines: [
            { book: "trust", account: "owner_payable", side: "debit", amount },
            { book: "trust", account: "cash", side: "credit", amount },
          ],
        })
        setFlash({ kind: "ok", msg: `Paid the owner ${fmt(amount)} out of the trust book.` })
      } else {
        const amount = toMinor(rent)
        if (amount <= 0) {
          c.current.pay--
          setFlash({ kind: "bad", msg: "Set the owner's rent first." })
          return
        }
        ledger.post({
          idempotencyKey: `rent_${n}`,
          book: "operating",
          date: PAY_DATE,
          memo: `Owner rent #${n}`,
          lines: [
            { book: "operating", account: "rent_expense", side: "debit", amount },
            { book: "operating", account: "cash", side: "credit", amount },
          ],
        })
        setFlash({ kind: "ok", msg: `Paid the owner ${fmt(amount)} fixed rent — your cost, from the operating book.` })
      }
    } catch (e) {
      c.current.pay--
      setFlash({ kind: "bad", msg: "Refused.", detail: errText(e) })
    }
  }

  function sweepFee() {
    const amount = owed("trust", "due_to_operating")
    if (amount <= 0) {
      setFlash({ kind: "bad", msg: "No commission to sweep. Record a booking first." })
      return
    }
    const n = ++c.current.sweep
    const tid = `sweep_${n}`
    try {
      ledger.post({
        idempotencyKey: `sweep_t_${n}`,
        book: "trust",
        date: PAY_DATE,
        transferId: tid,
        memo: `Fee sweep #${n}`,
        lines: [
          { book: "trust", account: "due_to_operating", side: "debit", amount },
          { book: "trust", account: "cash", side: "credit", amount },
        ],
      })
      ledger.post({
        idempotencyKey: `sweep_o_${n}`,
        book: "operating",
        date: PAY_DATE,
        transferId: tid,
        memo: `Commission earned #${n}`,
        lines: [
          { book: "operating", account: "cash", side: "debit", amount },
          { book: "operating", account: "commission_income", side: "credit", amount },
        ],
      })
      setFlash({ kind: "ok", msg: `Swept ${fmt(amount)} commission out of trust into operating — two linked legs.` })
    } catch (e) {
      c.current.sweep--
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
        setFlash({ kind: "ok", msg: "Reversed both legs of the transfer together. A single leg can't be reversed alone." })
      } else {
        const r = ledger.reverse(candidate.id, { idempotencyKey: `rev_${++c.current.rev}`, date: "2026-04-01" })
        setFlash({ kind: "ok", msg: `Corrected entry #${candidate.sequence} with a reversing entry #${r.sequence}. Both stay on the record.` })
      }
    } catch (e) {
      setFlash({ kind: "bad", msg: "Refused.", detail: errText(e) })
    }
  }

  function closeMonth() {
    ledger.periods.close("trust", "2026-03")
    ledger.periods.close("operating", "2026-03")
    setFlash({ kind: "ok", msg: "Closed the period 2026-03. New postings dated in March are now refused — record a booking to see it." })
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
    c.current = { booking: 0, pay: 0, sweep: 0, rev: 0, bad: 0 }
    setFlash({ kind: "idle", msg: "Fresh ledger." })
  }

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
        This runs the real <b>reference ledger</b> in your browser. Set a management agreement, record a
        booking, pay the owner, sweep your fee, reverse an entry, close the month, then try to slip in a
        broken one. Every write goes through <b>one door</b>: it balances to the cent, it can&apos;t be
        edited after, and a bad entry is refused.
      </p>

      <div className="panel-card agreement">
        <h2>Agreement</h2>
        <div className="row">
          <div className="field">
            <label>Model</label>
            <div className="seg" role="radiogroup" aria-label="Model">
              <button type="button" className={model === "management" ? "on" : ""} aria-pressed={model === "management"} onClick={() => switchModel("management")}>Management</button>
              <button type="button" className={model === "arbitrage" ? "on" : ""} aria-pressed={model === "arbitrage"} onClick={() => switchModel("arbitrage")}>Arbitrage</button>
            </div>
          </div>
          <div className="field">
            <label>Booking amount</label>
            <input value={bookingAmt} onChange={(e) => setBookingAmt(e.target.value)} inputMode="decimal" aria-label="Booking amount" />
          </div>
          {model === "management" ? (
            <div className="field pct">
              <label>Management fee %</label>
              <input value={feePct} onChange={(e) => setFeePct(e.target.value)} inputMode="decimal" aria-label="Management fee percent" />
            </div>
          ) : (
            <div className="field">
              <label>Owner rent</label>
              <input value={rent} onChange={(e) => setRent(e.target.value)} inputMode="decimal" aria-label="Owner rent" />
            </div>
          )}
          <div className="field pct">
            <label>VAT %</label>
            <input value={vatPct} onChange={(e) => setVatPct(e.target.value)} inputMode="decimal" aria-label="VAT percent" />
          </div>
        </div>
        <p className="assume">
          Assumption: the guest payment is <b>NRI + VAT</b>, and VAT is a <b>pass-through</b> held for the authority.
          A few assumptions, not a full business model.
        </p>
      </div>

      <div className="grid">
        <aside className="panel-card">
          <h2>Actions</h2>
          <div className="actions">
            <button className="btn btn-primary" onClick={recordBooking}>Record a booking <span className="n">{model === "management" ? "trust" : "operating"}</span></button>
            <button className="btn" onClick={payOwner}>Pay the owner <span className="n">{model === "management" ? "from trust" : "fixed rent"}</span></button>
            {model === "management" && (
              <button className="btn" onClick={sweepFee}>Sweep the fee <span className="n">trust → operating</span></button>
            )}
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
              const emptyHint =
                book === "trust" && model === "arbitrage"
                  ? "empty — arbitrage revenue is yours, not held in trust"
                  : book === "operating" && model === "management"
                    ? "empty — until you sweep the fee"
                    : "no postings yet"
              return (
                <div className={`book ${book}`} key={book}>
                  <h3><span className="dot" /> {book} book</h3>
                  {accts.length === 0 ? (
                    <div className="empty">{emptyHint}</div>
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
