/**
 * The database half of the ledger, actually executed.
 *
 * The TypeScript reference in ../src enforces the invariants in application code;
 * db/schema.sql claims to enforce the same ones in Postgres itself. Prose is not
 * proof, so this suite stands up a real Postgres (via testcontainers), applies
 * the schema, and shows the guarantees hold against the live database: a balanced
 * entry commits, an unbalanced or single-line or cross-book one is refused,
 * posted history can't be updated or deleted, amounts must be positive, a journal
 * line can reference a booking that doesn't exist (the no-foreign-key decision),
 * and the idempotency key refuses a double-post even under a concurrent race.
 *
 * Needs Docker. It is excluded from the default `npm test` (which stays fast and
 * dependency-free) and runs via `npm run test:db`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { Pool } from "pg"

const here = dirname(fileURLToPath(import.meta.url))
const SCHEMA = readFileSync(join(here, "../db/schema.sql"), "utf8")

let container: StartedPostgreSqlContainer
let pool: Pool

type Line = { account: string; side: "debit" | "credit"; amount: number; book?: string; reservationId?: string }

/** Post an entry + its lines in one transaction. Rejects if the commit is refused. */
async function post(opts: { key: string; book?: string; date?: string; lines: Line[] }): Promise<string> {
  const book = opts.book ?? "trust"
  const client = await pool.connect()
  try {
    await client.query("begin")
    const { rows } = await client.query(
      "insert into journal_entry (idempotency_key, book, entry_date, memo) values ($1,$2,$3,$4) returning id",
      [opts.key, book, opts.date ?? "2026-03-10", "test"],
    )
    const entryId = rows[0].id as string
    for (const l of opts.lines) {
      await client.query(
        "insert into journal_line (entry_id, book, account, side, amount, reservation_id) values ($1,$2,$3,$4,$5,$6)",
        [entryId, l.book ?? book, l.account, l.side, l.amount, l.reservationId ?? null],
      )
    }
    await client.query("commit")
    return entryId
  } catch (e) {
    await client.query("rollback").catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

const balanced = (amount: number): Line[] => [
  { account: "cash", side: "debit", amount },
  { account: "owner_payable", side: "credit", amount },
]

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start()
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 12 })
  await pool.query(SCHEMA)
}, 180_000)

afterAll(async () => {
  await pool?.end()
  await container?.stop()
})

describe("db/schema.sql, enforced by Postgres", () => {
  it("accepts a balanced entry", async () => {
    const id = await post({ key: "ok_1", lines: balanced(50_000) })
    const { rows } = await pool.query("select side, amount from journal_line where entry_id = $1 order by side", [id])
    expect(rows).toHaveLength(2)
    expect(Number(rows[0].amount)).toBe(50_000)
  })

  it("refuses an unbalanced entry at commit (deferred balance trigger)", async () => {
    await expect(
      post({
        key: "bad_balance",
        lines: [
          { account: "cash", side: "debit", amount: 50_000 },
          { account: "owner_payable", side: "credit", amount: 40_000 },
        ],
      }),
    ).rejects.toThrow(/does not balance/)
  })

  it("refuses a single-line entry (an entry must have at least two lines)", async () => {
    await expect(
      post({ key: "one_line", lines: [{ account: "cash", side: "debit", amount: 10_000 }] }),
    ).rejects.toThrow(/at least two lines/)
  })

  it("refuses a line that crosses into the other book (deferred book trigger)", async () => {
    await expect(
      post({
        key: "cross_book",
        book: "trust",
        lines: [
          { account: "cash", side: "debit", amount: 10_000 },
          { account: "owner_payable", side: "credit", amount: 10_000, book: "operating" },
        ],
      }),
    ).rejects.toThrow(/does not match entry book/)
  })

  it("refuses a non-positive amount (check constraint)", async () => {
    await expect(post({ key: "zero_amt", lines: [{ account: "cash", side: "debit", amount: 0 }, { account: "owner_payable", side: "credit", amount: 0 }] })).rejects.toThrow()
    await expect(post({ key: "neg_amt", lines: [{ account: "cash", side: "debit", amount: -1 }, { account: "owner_payable", side: "credit", amount: -1 }] })).rejects.toThrow()
  })

  it("refuses an UPDATE or DELETE of a posted entry (append-only)", async () => {
    const id = await post({ key: "append_entry", lines: balanced(20_000) })
    await expect(pool.query("update journal_entry set memo = 'edited' where id = $1", [id])).rejects.toThrow(/append-only/)
    await expect(pool.query("delete from journal_entry where id = $1", [id])).rejects.toThrow(/append-only/)
  })

  it("refuses an UPDATE or DELETE of a posted line (append-only)", async () => {
    const id = await post({ key: "append_line", lines: balanced(20_000) })
    const { rows } = await pool.query("select id from journal_line where entry_id = $1 limit 1", [id])
    const lineId = rows[0].id
    await expect(pool.query("update journal_line set amount = 999 where id = $1", [lineId])).rejects.toThrow(/append-only/)
    await expect(pool.query("delete from journal_line where id = $1", [lineId])).rejects.toThrow(/append-only/)
  })

  it("lets a journal line remember a booking that doesn't exist (the no-foreign-key decision)", async () => {
    // There is no reservations table; a foreign key would make this fail. The
    // line stores the id as a plain fact, so a regenerated booking can never
    // orphan posted history.
    const id = await post({
      key: "no_fk",
      lines: [
        { account: "cash", side: "debit", amount: 30_000, reservationId: "r_regenerated_and_gone" },
        { account: "owner_payable", side: "credit", amount: 30_000 },
      ],
    })
    const { rows } = await pool.query("select reservation_id from journal_line where entry_id = $1 and reservation_id is not null", [id])
    expect(rows[0].reservation_id).toBe("r_regenerated_and_gone")
  })

  it("refuses a double-post of the same idempotency key under a concurrent race", async () => {
    const key = "race_key"
    const results = await Promise.allSettled([post({ key, lines: balanced(5_000) }), post({ key, lines: balanced(5_000) })])
    const ok = results.filter((r) => r.status === "fulfilled")
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[]
    expect(ok).toHaveLength(1)
    expect(failed).toHaveLength(1)
    // 23505 = unique_violation
    const reason = failed[0]?.reason as { code?: string } | undefined
    expect(reason?.code).toBe("23505")
  })

  it("keeps the whole ledger balanced under concurrent posts (conservation)", async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => post({ key: `conc_${i}`, book: i % 2 ? "operating" : "trust", lines: balanced(1_000 * (i + 1)) })),
    )
    // Across every committed line in the database, debits must still equal credits.
    const { rows } = await pool.query(
      "select coalesce(sum(amount) filter (where side='debit'),0) as d, coalesce(sum(amount) filter (where side='credit'),0) as c from journal_line",
    )
    expect(rows[0].d).toBe(rows[0].c)
  })
})
