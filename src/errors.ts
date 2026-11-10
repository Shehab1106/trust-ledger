/** All ledger refusals are typed, so callers can tell a policy stop from a bug. */
export class LedgerError extends Error {
  override name = "LedgerError"
}

export class UnbalancedEntry extends LedgerError {
  override name = "UnbalancedEntry"
  constructor(public debit: number, public credit: number) {
    super(`entry does not balance: debits ${debit} != credits ${credit}`)
  }
}

export class CrossBookLine extends LedgerError {
  override name = "CrossBookLine"
  constructor() {
    super("a line's book does not match the entry's book; a line cannot span two books")
  }
}

export class EmptyEntry extends LedgerError {
  override name = "EmptyEntry"
  constructor() {
    super("an entry must have at least two lines")
  }
}

export class ClosedPeriod extends LedgerError {
  override name = "ClosedPeriod"
  constructor(public book: string, public period: string) {
    super(`cannot post into closed period ${period} of the ${book} book`)
  }
}

export class NotFound extends LedgerError {
  override name = "NotFound"
  constructor(id: string) {
    super(`entry ${id} not found`)
  }
}

export class AlreadyReversed extends LedgerError {
  override name = "AlreadyReversed"
  constructor(id: string) {
    super(`entry ${id} has already been reversed`)
  }
}

export class ReverseLegDirectly extends LedgerError {
  override name = "ReverseLegDirectly"
  constructor() {
    super("this entry is one leg of a cross-book transfer; reverse the transfer, not a single leg")
  }
}
