import { test } from 'vitest';
// Just a simple script to verify logic
import { resolveTerminalShortcutKeydown } from '../../src/renderer/src/terminal-shortcut-dispatch.ts';

// Test case: 
// - terminal.sigint rebound to Ctrl+Q
// - browser.devTools bound to Ctrl+C
