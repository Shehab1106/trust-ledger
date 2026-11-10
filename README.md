# Designing a trust-accounting ledger money can't leak out of

A short architecture case study on a double-entry trust ledger I built in production for a
property-management platform. The point is how the system makes a wrong number impossible to
represent, not just unlikely.

It is pattern level on purpose, but it is not only prose. A clean-room reference implementation
of these ideas ships alongside it, so the claims below are runnable.

**Live demo: [trust-ledger-shehab14.vercel.app](https://trust-ledger-shehab14.vercel.app)** — post
bookings, disburse to owners across both books, reverse entries, close a period, and watch the
books stay correct to the cent, then try to slip in a broken entry and watch it get refused.

```bash
npm install
npm test        # 15 tests: the invariants below, in the TypeScript engine
npm run test:db # the same rules, enforced by a real Postgres (needs Docker)
npm run dev     # the interactive console, at localhost:3000
```

`src/` is a double-entry trust ledger in TypeScript (a single write door, append-only store,
correction by reversal, locked periods); `app/` is the interactive console that drives it;
`tests/` proves each invariant below. `db/schema.sql` enforces the same rules in Postgres itself
(append-only triggers, a deferred balance-and-single-book check, the no-foreign-key decision on the
journal lines), and it is not just prose: `npm run test:db` stands up a real database with
testcontainers, applies the schema, and shows an update/delete of posted history refused, an
unbalanced or cross-book entry refused, a line remembering a booking that no longer exists, and the
idempotency key refusing a double-post under a concurrent race. It is a reference implementation of
standard double-entry and trust-accounting principles with invented example data, not production
code and not anyone's proprietary system.

## The problem

A property manager holds money that is not theirs. A guest pays for a stay; some of that is the
owner's revenue, some is the manager's commission, some is tax, some is a cleaning fee owed to a
third party. Until it is paid out, the manager is holding other people's funds in trust. Get a
number wrong and it is not a cosmetic bug: it is someone's money, and in most places trust money
carries legal and regulatory weight.

So the ledger is not a reporting feature bolted onto the app. It is the financial source of truth,
and it has one job: never lose or invent money, and always be able to prove where every cent sits.

## The one idea everything follows from

**The ledger is permanent; everything around it is disposable.**

Bookings get re-synced from the channel, edited, cancelled, and regenerated constantly. Prices get
recomputed. Business terms change. None of that churn is allowed to touch the record of what was
actually posted. The operational tables serve today's view; the ledger remembers what happened.
Once you accept that hierarchy, most of the hard decisions make themselves.

## The accounting chain

Each layer has exactly one responsibility, and money only moves in one direction through them:

![The accounting chain: money moves one direction through seven layers. The operational layers (facts, transactions and categories, business model, dated split grid) are regenerated freely; the trust and operating ledger is the permanent, append-only record; statements, payout runs and bank reconciliation read the books downstream.](docs/accounting-chain.svg)

The split between "author the agreement" and "record the event" matters. A business model is
edited freely. But assigning it to a property compiles it into a dated, versioned grid, and the
terms are frozen at that moment. Historical accounting reads the version that was in force on the
transaction's date, so editing a deal today can never silently restate last quarter's books.

## The invariants, and how they are enforced

A principle you only enforce in code review is a principle you have already lost. Each of these is
enforced structurally.

### One door in

Every posting goes through a single journal-writer service. Nothing else writes to the books.
That one door:

- locks the team's books for the write,
- checks the caller actually owns every resource referenced,
- refuses to post into a closed period,
- validates that the entry balances, in integer minor units, with positive line amounts and a
  stated side (debit or credit),
- is idempotent: a posting is keyed by its source, so replaying the same event never
  double-posts,
- commits the whole entry or nothing.

Because there is one door, every one of these guarantees holds for every write, with no
per-caller discipline required.

### Append-only, enforced by the database

Journal entries and lines are append-only, and that is enforced at the database layer, not by
application convention. The database itself rejects updates, deletes, unbalanced entries, and
lines that cross between two books. If a bug or a careless query tries to mutate posted history,
the write fails. The record is immutable because it is physically not allowed to change.

### Correction by reversal, never by edit

You never fix a posted entry. A correction is a new entry that reverses the original and points
back at it. The mistake and its fix both stay on the record, which is what an auditor expects and
what a regulator requires. Cross-book movements are linked, and reversing one leg alone is
refused, so the two books can never drift apart.

### The decision I am most proud of: no foreign keys on the journal lines

A journal line records which property, reservation, transaction, and party it related to. The
obvious move is a foreign key on each of those. I deliberately did not add them, and this is the
sharpest example of "the ledger is permanent, everything else is disposable."

Think about what a foreign key actually promises: the referenced row must exist, and the database
enforces a rule when it is deleted. Postgres gives three options, and in a ledger every one is
wrong:

- `CASCADE`: re-syncing a booking would delete its posted journal history. Money records vanish.
  Catastrophic.
- `SET NULL`: the posting survives but forgets which booking it was. Statements group by exactly
  that link. You have kept the money and lost its meaning.
- `RESTRICT`: the database now forbids ever regenerating a reservation that has a posting against
  it. The entire re-sync and healing machinery seizes.

Every option lets a disposable table dictate terms to the permanent one. That is the hierarchy
inverted. The insight is that a foreign key models the wrong relationship here: the journal line
does not *depend on* the reservation, it *remembers* it. It is a historical fact ("this posting
related to that booking, as it was at the time"), not a live pointer. So the ids are plain columns
with no referential constraint, and source rows are free to be deleted and regenerated while the
financial record stays whole. (I reached for the same pattern elsewhere, for records that must
outlive the subjects they refer to.)

### Trust money is kept separate

Every team keeps two books, trust and operating, and they are never commingled. Guest and owner
funds live in the trust book; the manager's own revenue and costs live in the operating book. A
single line can never span both. This is the accounting shape of the legal rule that you do not
mix other people's money with your own.

### Reports read the books, not a parallel calculation

Before a team is live on the ledger, owner reports are composed from transactions and the active
grid. Once the trust book is active, statements, owner balances, and payout availability read the
posted journal lines instead. They do not recalculate a second answer from the raw data, because
two code paths computing "the truth" is how two different truths are born. A period that would
straddle the go-live date is refused rather than mixing the two sources into one document.

### Statements are frozen, and pinned

An issued statement is an immutable, versioned snapshot. Re-issuing supersedes rather than
overwrites, and the prior version stays retrievable. Each ledger-backed statement is pinned to the
highest journal sequence it read, so you can always say exactly which state of the books a given
PDF reflects.

### Bank reconciliation clears money, it does not author it

Importing a bank statement never posts to the ledger. Reconciliation only matches real bank lines
to already-posted cash lines, and a confirmed match must sum exactly to the cent. Matching marks a
line as cleared; it never creates or moves money. The bank feed is evidence, not a source of
truth.

### A UUID is never authorization

Everything is tenant-scoped. Every read and write reaches a team through an ownership path and
validates membership first. Holding an id is never, by itself, permission to see or touch the
thing it names.

## What ties it together

None of these are clever individually. The discipline is that they all express the same one idea,
and each is enforced by structure (a single boundary, a database constraint, a frozen version, a
reversal-only rule) rather than by hoping the next change remembers the rule. That is what lets the
system hold its integrity while everything feeding it churns.

A ledger is not hard because double-entry is hard. It is hard because the world around the money
will not hold still, and the money has to anyway.
