import type { Book } from "./types.js"
import { periodOf } from "./types.js"

/**
 * Which accounting periods are closed, per book. Closing is an explicit act; there
 * is no auto-close. Once a period is closed, nothing new can post into it, which is
 * what makes a published statement for that period trustworthy.
 */
export class PeriodRegistry {
  private closed = new Set<string>()

  private key(book: Book, period: string): string {
    return `${book}:${period}`
  }

  close(book: Book, period: string): void {
    this.closed.add(this.key(book, period))
  }

  /** Audited, deliberate reopen. In a real system this is gated and logged. */
  reopen(book: Book, period: string): void {
    this.closed.delete(this.key(book, period))
  }

  isClosedPeriod(book: Book, period: string): boolean {
    return this.closed.has(this.key(book, period))
  }

  isClosedOn(book: Book, date: string): boolean {
    return this.isClosedPeriod(book, periodOf(date))
  }
}
