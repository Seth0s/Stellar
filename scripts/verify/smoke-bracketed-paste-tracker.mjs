import { updateBracketedPasteMode } from '../../src/main/type-and-submit-decision.ts';

let state = { enabled: false, carry: "" };
state = updateBracketedPasteMode(state, "\x1b[?2004");
console.log(state);
state = updateBracketedPasteMode(state, "h\x1b[?2004l");
console.log(state);
