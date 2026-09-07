#!/usr/bin/env python3
"""Guard the Ludo auto-play roll so a turn timeout cannot kill the games server.

  --check   verify the base file and report what WOULD change. Writes nothing.
  --apply   write the change (only if the base sha still matches).

Exact-string surgery, not `patch`: the file is Go and indented with TABS, and a
unified diff piped through nested SSH heredocs loses them silently.
"""
import hashlib
import sys

F = "/opt/vaultgames/go-server/internal/realtime/ludorooms.go"
BASE_SHA = "9c6102fe11d699bc5e56fa5e2576234e62019de3c61de1bb520a5fee43a1ec97"

# --- 1. doRoll: the choke point -------------------------------------------
OLD1 = (
    "func (m *LudoRoomManager) doRoll(r *ludoRoom, playerID, clientSeed string) {\n"
    "\tg := r.game\n"
    "\tc := r.commit\n"
    "\tdie, hmac := fair.RollSingleDie(c.serverSeed, clientSeed, c.nonce)\n"
)
NEW1 = (
    "func (m *LudoRoomManager) doRoll(r *ludoRoom, playerID, clientSeed string) {\n"
    "\tg := r.game\n"
    "\tc := r.commit\n"
    "\t// The commitment is SPENT by a roll (r.commit = nil, below) and the turn\n"
    "\t// clock is NOT stopped when a player rolls. So a player who rolls and then\n"
    "\t// runs out of time before MOVING arrives here with c == nil. Roll() guards\n"
    "\t// this for humans; autoPlay() did not, and an unrecovered nil dereference\n"
    "\t// in a timer goroutine takes the whole process down — chess with it.\n"
    "\tif g == nil || c == nil {\n"
    "\t\treturn\n"
    "\t}\n"
    "\tdie, hmac := fair.RollSingleDie(c.serverSeed, clientSeed, c.nonce)\n"
)

# --- 2. autoPlay: the actual behavioural fix -------------------------------
OLD2 = (
    "func (m *LudoRoomManager) autoPlay(r *ludoRoom, playerID string) {\n"
    "\tm.doRoll(r, playerID, randHex(16))\n"
)
NEW2 = (
    "func (m *LudoRoomManager) autoPlay(r *ludoRoom, playerID string) {\n"
    "\t// Only roll when a commitment is still outstanding. A player who already\n"
    "\t// rolled and then ran out of time before MOVING has spent it; the block\n"
    "\t// below plays their move from st.PendingDie, which is what was intended\n"
    "\t// all along and what the crash was hiding.\n"
    "\tif r.commit != nil {\n"
    "\t\tm.doRoll(r, playerID, randHex(16))\n"
    "\t}\n"
)

EDITS = [("doRoll nil-commit guard", OLD1, NEW1), ("autoPlay roll-only-if-committed", OLD2, NEW2)]


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "--check"
    src = open(F, encoding="utf-8").read()
    sha = hashlib.sha256(src.encode()).hexdigest()

    print(f"file : {F}")
    print(f"sha  : {sha}")
    if sha == BASE_SHA:
        print("       matches the patch base -> safe to apply")
    elif all(new in src for _, _, new in EDITS):
        print("       ALREADY PATCHED (both guards present) -> nothing to do")
        return 0
    else:
        print(f"       DOES NOT MATCH base {BASE_SHA}")
        print("       Refusing: re-derive the patch against the current file.")
        return 2

    out = src
    for name, old, new in EDITS:
        n = out.count(old)
        print(f"  edit '{name}': {n} exact match(es)")
        if n != 1:
            print("       Refusing: expected exactly 1.")
            return 3
        out = out.replace(old, new, 1)

    added = len(out.splitlines()) - len(src.splitlines())
    print(f"  would add {added} lines; no other bytes change")

    if mode == "--apply":
        open(F, "w", encoding="utf-8").write(out)
        print(f"  WRITTEN. new sha: {hashlib.sha256(out.encode()).hexdigest()}")
    else:
        print("  DRY RUN — nothing written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
