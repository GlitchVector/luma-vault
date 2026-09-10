/**
 * The error taxonomy. Four kinds, because they mean four different things to
 * whoever is looking at the terminal at 2am.
 *
 * Fields are assigned in the constructor body rather than declared as parameter
 * properties: the CLI runs these files through Node's `--experimental-strip-types`,
 * which erases annotations and cannot synthesise the assignment a parameter
 * property implies.
 */

/**
 * A piece of the protocol has not been captured yet.
 *
 * This is the load-bearing error of the whole project. Constraint 4 of the
 * brief: a plausible-looking guessed endpoint is worse than no code, because it
 * fails *silently* against a live account. So every place that would need a
 * captured endpoint, field name or payload shape throws this instead of
 * guessing, and says which fixture would fill the hole.
 */
export class NotCapturedError extends Error {
  readonly what: string
  readonly fixture: string

  constructor(what: string, fixture: string) {
    super(
      `${what} has not been captured yet.\n` +
        `Run the "${fixture}" capture fixture (see packages/patreon-harness/README.md), ` +
        `then regenerate src/endpoints.generated.ts.`,
    )
    this.name = 'NotCapturedError'
    this.what = what
    this.fixture = fixture
  }
}

/** The browser is not where we need it to be — not attached, not logged in. */
export class SessionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionError'
  }
}

/** A call reached Patreon and Patreon said no. Carries the body: the internal API explains itself in it. */
export class ApiError extends Error {
  readonly status: number
  readonly body: string

  constructor(message: string, status: number, body: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

/** The manifest is wrong. Reported all at once, never one field per run. */
export class ManifestError extends Error {
  readonly path: string
  readonly problems: readonly string[]

  constructor(path: string, problems: readonly string[]) {
    super(`${path}\n${problems.map((problem) => `  - ${problem}`).join('\n')}`)
    this.name = 'ManifestError'
    this.path = path
    this.problems = problems
  }
}
