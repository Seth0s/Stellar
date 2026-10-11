/** Typing for `window.inbox` (account inbox API). */
import type { InboxApi } from "../../preload/index";

declare global {
  interface Window {
    inbox: InboxApi;
  }
}

export {};
