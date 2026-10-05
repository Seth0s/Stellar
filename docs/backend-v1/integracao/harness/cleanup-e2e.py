#!/usr/bin/env python3
# Kills leftover E2E Electron processes BY READING /proc (never matches its own
# cmdline). Only touches processes whose args contain the e2e temp prefix.
import os, signal, glob, shutil

MARK = "stellar-e2e-"
me = os.getpid()
killed = []
for p in glob.glob("/proc/[0-9]*/cmdline"):
    pid = int(p.split("/")[2])
    if pid == me:
        continue
    try:
        with open(p, "rb") as f:
            args = f.read().replace(b"\x00", b" ").decode("utf8", "replace")
    except Exception:
        continue
    if MARK in args and ("electron" in args or "out/main/index.js" in args):
        try:
            os.kill(pid, signal.SIGKILL)
            killed.append(pid)
        except Exception:
            pass

removed = []
for d in glob.glob("/tmp/stellar-e2e-A-*") + glob.glob("/tmp/stellar-e2e-B-*"):
    try:
        shutil.rmtree(d, ignore_errors=True)
        removed.append(d)
    except Exception:
        pass
print("killed:", killed)
print("removed:", removed)
