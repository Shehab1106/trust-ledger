-- Trust-accounting ledger: the database half of the write-up.
--
-- This schema is where the invariants stop being conventions and become physics.
-- The TypeScript reference implementation (../src) enforces the same rules in
-- application code; this shows them enforced by Postgres itself, so a bug or a
-- careless query cannot get around them.

begin;

create type book as enum ('trust', 'operating');
create type side as enum ('debit', 'credit');

-- An entry is a balanced set of lines, all in one book.
create table journal_entry (
  id              bigint generated always as identity primary key,
  sequence        bigint generated always as identity, -- monotonic; statements pin to it
  idempotency_key text        not null unique,          -- replay never double-posts
  book            book        not null,
  entry_date      date        not null,                 -- the economic date
  memo            text,
  reverses_entry  bigint,     -- the entry this one reverses (a plain reference, see below)
  transfer_id     text,       -- ties the two legs of a cross-book transfer
  posted_at       timestamptz not null default now()
);

create table journal_line (
  id         bigint generated always as identity primary key,
  entry_id   bigint not null references journal_entry (id),
  book       book   not null,
  account    text   not null,
  side       side   not null,
  -- integer minor units only; no floats, and never negative or zero
  amount     bigint not null check (amount > 0),

  -- THE DECISION THIS REPO IS ABOUT.
  -- property_id, reservation_id, transaction_id and party_id are PLAIN COLUMNS
  -- with NO foreign key, on purpose. The journal line does not depend on those
  -- rows, it remembers them. Source rows are deleted and regenerated elsewhere
  -- (re-sync, healing); a foreign key would let that churn either delete posted
  -- history (CASCADE), orphan its meaning (SET NULL), or block the regeneration
  -- (RESTRICT). All three are wrong for a ledger, so there is no foreign key here.
  property_id    text,
  reservation_id text,
  transaction_id text,
  party_id       text
);

create index on journal_line (entry_id);
create index on journal_line (book, account);
create index on journal_line (reservation_id);

-- A line never crosses into the other book from its entry.
create or replace function enforce_line_book() returns trigger as $$
begin
  if new.book <> (select book from journal_entry where id = new.entry_id) then
    raise exception 'line book % does not match entry book', new.book;
  end if;
  return new;
end;
$$ language plpgsql;

create constraint trigger line_book_matches
  after insert on journal_line
  deferrable initially deferred
  for each row execute function enforce_line_book();

-- Every entry balances: debits = credits, checked once the whole entry is in.
create or replace function enforce_balanced() returns trigger as $$
declare
  d bigint;
  c bigint;
  n int;
begin
  select
    coalesce(sum(amount) filter (where side = 'debit'), 0),
    coalesce(sum(amount) filter (where side = 'credit'), 0),
    count(*)
  into d, c, n
  from journal_line where entry_id = new.entry_id;

  if n < 2 then
    raise exception 'entry % must have at least two lines', new.entry_id;
  end if;
  if d <> c then
    raise exception 'entry % does not balance: debits % != credits %', new.entry_id, d, c;
  end if;
  return new;
end;
$$ language plpgsql;

create constraint trigger entry_balances
  after insert on journal_line
  deferrable initially deferred
  for each row execute function enforce_balanced();

-- APPEND-ONLY, enforced by the database. Posted history is physically read-only:
-- no update, no delete, ever. A correction is a new, reversing entry (see the
-- reference implementation), never an edit.
create or replace function reject_mutation() returns trigger as $$
begin
  raise exception 'journal is append-only: % on %.% is not allowed', tg_op, tg_table_schema, tg_table_name;
end;
$$ language plpgsql;

create trigger journal_entry_append_only
  before update or delete on journal_entry
  for each row execute function reject_mutation();

create trigger journal_line_append_only
  before update or delete on journal_line
  for each row execute function reject_mutation();

commit;

-- Notes
--  * Period close (refusing postings into a closed month) is enforced in the
--    application writer in this reference; in a fuller system it is a closed_period
--    table checked by the same insert path.
--  * reverses_entry is deliberately a plain reference too: a reversal must survive
--    even if the original's surrounding context is regenerated.
