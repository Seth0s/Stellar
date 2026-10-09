import Database from 'better-sqlite3';
import { rebuildDerivedVerdictsTable, compareDerivedAgainstStored } from '../src/main/task-verdict-derivation.ts';

const db = new Database('/tmp/rev-fase4/agent-canvas.bak.db');

const rebuild = rebuildDerivedVerdictsTable(db);
console.log('Rebuild stats:', rebuild);

const summary = compareDerivedAgainstStored(db);
console.log('Summary:', summary);
