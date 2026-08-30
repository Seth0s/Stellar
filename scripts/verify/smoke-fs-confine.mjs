// Pre-release audit S1 — `confine()` is the ONLY thing standing between a
// board's `root` and the rest of the filesystem: `fs:read`/`fs:write` from
// FilesCard, the chat's `read_file`/`write_file` tools and both searches
// all funnel through it. It is also pure, synchronous and takes two
// strings — so unlike everything else in this directory it does not need a
// running Electron instance to be verified, just the real function.
//
// No test framework exists in this repo (deliberately — see README.md), so
// this follows the same shape as the CDP smoke scripts: `check()` per
// assertion, non-zero exit when any of them fails. It imports the REAL
// `src/main/fs-tools.ts` (Node 22 strips the types natively) rather than
// the bundled `out/` build, so it never drifts from the source and needs
// no `npm run build` first.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeChecker } from "./cdp-client.mjs";
import { confine, PathEscapeError, readFile } from "../../src/main/fs-tools.ts";

const { check, finish } = makeChecker();

// realpath'd up front: on some systems the OS temp dir is itself a symlink
// (macOS's /tmp -> /private/tmp), and this test is precisely about not
// confusing a symlink with its target.
const base = realpathSync(mkdtempSync(join(tmpdir(), "stellar-confine-")));
const root = join(base, "root");
const outside = join(base, "outside");

try {
  mkdirSync(join(root, "sub"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "inside.txt"), "in");
  writeFileSync(join(root, "sub", "nested.txt"), "nested");
  writeFileSync(join(outside, "secret.txt"), "SECRET");

  // The bug itself: a symlink CREATED INSIDE the root (by anything at all —
  // a checked-out repo, an agent running in a terminal card, npm) whose
  // target is outside it. Lexically it is `<root>/link.txt`, so the old
  // `startsWith(root)` check waved it through and the read that followed
  // returned the contents of a file the board never had access to.
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
  symlinkSync(outside, join(root, "linkdir"));
  // A symlink is not automatically an escape — one pointing back INSIDE
  // the root has to keep working, or every node_modules-style internal
  // link would break.
  symlinkSync(join(root, "sub"), join(root, "innerlink"));

  const throws = (fn) => {
    try {
      fn();
      return "did not throw";
    } catch (err) {
      return err instanceof PathEscapeError ? "PathEscapeError" : `other: ${err.message}`;
    }
  };

  // --- normal paths, must keep working ---------------------------------
  check("plain file inside root", confine(root, "inside.txt"), join(root, "inside.txt"));
  check("nested file inside root", confine(root, "sub/nested.txt"), join(root, "sub", "nested.txt"));
  check("the root itself", confine(root, ""), root);
  check("leading slash is stripped, not treated as absolute", confine(root, "/inside.txt"), join(root, "inside.txt"));

  // --- explicit traversal ----------------------------------------------
  check("explicit .. escapes", throws(() => confine(root, "../outside/secret.txt")), "PathEscapeError");
  check("deep .. escapes", throws(() => confine(root, "sub/../../outside/secret.txt")), "PathEscapeError");

  // --- the audit S1 bug -------------------------------------------------
  check("symlink inside root pointing at a file outside", throws(() => confine(root, "link.txt")), "PathEscapeError");
  check("symlink inside root pointing at a dir outside", throws(() => confine(root, "linkdir")), "PathEscapeError");
  check(
    "path THROUGH a symlinked dir that leaves the root",
    throws(() => confine(root, "linkdir/secret.txt")),
    "PathEscapeError",
  );
  check("symlink pointing back inside the root still resolves", confine(root, "innerlink/nested.txt"), join(root, "sub", "nested.txt"));

  // --- files that do not exist yet (createEntry / writeFile) ------------
  check("new file in an existing dir", confine(root, "brand-new.txt"), join(root, "brand-new.txt"));
  check("new file in an existing subdir", confine(root, "sub/brand-new.txt"), join(root, "sub", "brand-new.txt"));
  check(
    "new file under a parent that does not exist either",
    confine(root, "not/created/yet/file.txt"),
    join(root, "not", "created", "yet", "file.txt"),
  );
  check(
    "new file under a symlinked dir that leaves the root still escapes",
    throws(() => confine(root, "linkdir/brand-new.txt")),
    "PathEscapeError",
  );
  check("'..' that lands back on the root is allowed (it IS the root)", confine(root, "sub/.."), root);

  // End to end, not just the path math: the read that used to succeed
  // through `link.txt` is what made this a leak rather than a lint.
  const leaked = await readFile(root, "link.txt").then(
    (r) => ("content" in r ? `LEAKED: ${r.content}` : "tooLarge"),
    (err) => (err instanceof PathEscapeError ? "PathEscapeError" : `other: ${err.message}`),
  );
  check("fs readFile through the symlink is refused", leaked, "PathEscapeError");
} finally {
  rmSync(base, { recursive: true, force: true });
}

finish();
