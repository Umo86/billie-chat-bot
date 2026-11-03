/** A problem the person can act on; its message is shown as-is. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

/**
 * An error as one line that's safe to log or store: its name and message,
 * without the query values a database error carries (an email's text, a
 * Teams link), cut to `max` characters.
 */
export function safeError(err: unknown, max = 500): string {
  if (!(err instanceof Error)) return String(err).slice(0, max);
  let message = err.message;
  // Drizzle: "Failed query: <sql>\nparams: <values>". Keep the statement, drop the values.
  const params = message.search(/\n\s*params:/i);
  if (params >= 0) message = `${message.slice(0, params)} (values left out)`;
  // The database's own reason, with any quoted values blanked ("invalid input …: "x"").
  const cause =
    err.cause instanceof Error
      ? ` (${err.cause.name}: ${err.cause.message.replace(/"[^"]*"/g, '"…"')})`
      : "";
  return `${err.name}: ${message}${cause}`.replace(/\s+/g, " ").trim().slice(0, max);
}
