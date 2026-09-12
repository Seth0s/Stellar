/**
 * DOM component tests (jsdom + @testing-library/react).
 *
 * LIMIT — jsdom LIES about layout:
 * `getBoundingClientRect` returns zeros (and related geometry APIs are
 * similarly untrustworthy). Hit-testing by screen coordinate — including
 * task drag-and-drop drop targets — is NOT covered here. This environment
 * covers mount, events, render conditionals, and accessibility roles.
 * Geometry still needs smoke CDP (`scripts/verify/*.mjs`) or a human eye.
 *
 * Do not "prove" drag hit-tests in this suite; a green test would be a
 * false promise.
 */
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
