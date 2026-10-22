/** Typed result shape shared by every server action (as in Hall Pass). */
export type ActionResult<T = undefined> =
  | { ok: true; data?: T; message?: string }
  | {
      ok: false;
      error: string;
      fieldErrors?: Record<string, string>;
      /** What was typed, so a form can show it again after React resets it. */
      values?: Record<string, string>;
    };

export function fail(error: string, fieldErrors?: Record<string, string>): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

export function success<T>(data?: T, message?: string): ActionResult<T> {
  return { ok: true, data, message };
}

export function failWith(error: string, values: Record<string, string>): ActionResult<never> {
  return { ok: false, error, values };
}
