import { useState } from "react";

/** A validator returns an error message for an invalid value, or `null`
 * when the value is fine. */
export type Validator = (value: string) => string | null;

/**
 * DESIGN-BACKLOG.md item 21, ponto 6 — generic, reusable field-validation
 * primitive instead of each form reinventing its own touched/error
 * bookkeeping (the reported case: `SessionModal`'s "nome" field had no
 * validation at all — submitting empty just silently did nothing, no red
 * border, no message). Any input wires this up the same way:
 *
 *   const nameField = useFieldValidation(name, required("nome"));
 *   <input className={nameField.invalid ? "resume-input invalid" : "resume-input"}
 *          onBlur={nameField.onBlur} ... />
 *   {nameField.invalid && <span className="field-error-msg">{nameField.error}</span>}
 *
 * Errors only show once the field is "touched" — blurred at least once,
 * or a submit attempt forced it via `touch()` — never on the very first
 * keystroke into an empty required field. Pairs with the `.invalid`/
 * `.field-error-msg` CSS in `styles/layout.css`.
 */
export function useFieldValidation(value: string, validate: Validator) {
  const [touched, setTouched] = useState(false);
  const error = validate(value);
  return {
    error,
    invalid: touched && error !== null,
    onBlur: () => setTouched(true),
    /** Force the error to show even if the field was never blurred — call
     * this on a submit attempt so an untouched-but-invalid field still
     * gets flagged instead of silently blocking submit with no feedback. */
    touch: () => setTouched(true),
  };
}

/** Common validator: value must be non-empty after trimming whitespace. */
export const required: (label: string) => Validator = (label) => (value) =>
  value.trim() ? null : `${label} é obrigatório`;
