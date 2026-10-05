#!/usr/bin/env python3
# Kills leftover A8 E2E Electron processes BY READING /proc (never matches its
# own cmdline) and removes the throwaway userData dirs. Adapted from the E v2
# cleanup (docs/backend-v1/integracao/harness/cleanup-e2e.py).
import glob
import os
import shutil
import signal

MARK = "stellar-a8-"
me = os.getpid()
killed = []
for path in glob.glob("/proc/[0-9]*/cmdline"):
    pid = int(path.split("/")[2])
    if pid == me:
        continue
    try:
        with open(path, "rb") as f:
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
for d in glob.glob("/tmp/stellar-a8-A-*") + glob.glob("/tmp/stellar-a8-B-*"):
    try:
        shutil.rmtree(d, ignore_errors=True)
        removed.append(d)
    except Exception:
        pass
print("killed:", killed)
print("removed:", removed)
