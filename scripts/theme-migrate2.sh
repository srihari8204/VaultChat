#!/usr/bin/env bash
# Migrate a single-component LOCAL-CONST screen to themed colors, SAFELY:
#  - StyleSheet block: bare-word consts -> c.* (uppercase ids there are only colors)
#  - render block: replace consts ONLY in color contexts (olor={...} / olor: ...),
#    run twice to catch ternaries. Anything missed surfaces as a tsc error to fix.
# tsc is the net; revert + handle manually if a file doesn't come out clean.
f="$1"
grep -qE "useTheme|makeStyles\(" "$f" && { echo "SKIP $f"; exit 0; }
[ "$(grep -cE '^export default function' "$f")" = "1" ] || { echo "MANUAL(comps) $f"; exit 3; }
grep -qE "^const [Ss] = StyleSheet\.create\(\{" "$f" || { echo "MANUAL(nostyle) $f"; exit 3; }
unknown=$(grep -oE "^const [A-Z_]+ *= *'#[0-9A-Fa-f]{3,8}'" "$f" | grep -oE "^const [A-Z_]+" | sed 's/^const //' \
  | grep -vE "^(DARK_BG|DARK|BG|CARD_BG|CARD|BORDER|TEXT|TXT|SUBTLE|SUB|MUTED|ACCENT|GREEN|DANGER|RED|PURPLE|GOLD)$" || true)
[ -n "$unknown" ] && { echo "MANUAL(consts:$unknown) $f"; exit 3; }

sed -i -E "/^const (DARK_BG|DARK|BG|CARD_BG|CARD|BORDER|TEXT|TXT|SUBTLE|SUB|MUTED|ACCENT|GREEN|DANGER|RED|PURPLE|GOLD) *= *'#[0-9A-Fa-f]{3,8}';[[:space:]]*(\/\/.*)?$/d" "$f"
ss=$(grep -nE "^const [Ss] = StyleSheet\.create\(\{" "$f" | head -1 | cut -d: -f1)
svar=$(sed -n "${ss}p" "$f" | grep -oE "^const [Ss]" | grep -oE "[Ss]$")

names="(DARK_BG|DARK|BG|CARD_BG|CARD|BORDER|TEXT|TXT|SUBTLE|SUB|MUTED|ACCENT|GREEN|DANGER|RED|PURPLE|GOLD)"
bareword() { # $1=prefix $2=file  (bare-word; safe only inside StyleSheet)
  sed -i -E "s/\b(DARK_BG|DARK|BG)\b/${1}bg/g; s/\b(CARD_BG|CARD)\b/${1}card/g; s/\bBORDER\b/${1}border/g; \
s/\b(TEXT|TXT)\b/${1}text/g; s/\b(SUBTLE|SUB|MUTED)\b/${1}textDim/g; s/\b(ACCENT|GREEN)\b/${1}primary/g; \
s/\b(DANGER|RED)\b/${1}danger/g; s/\bPURPLE\b/${1}purple/g; s/\bGOLD\b/${1}accent/g" "$2"
}
mapname() { # echo palette key for a const name
  case "$1" in DARK_BG|DARK|BG) echo bg;; CARD_BG|CARD) echo card;; BORDER) echo border;;
    TEXT|TXT) echo text;; SUBTLE|SUB|MUTED) echo textDim;; ACCENT|GREEN) echo primary;;
    DANGER|RED) echo danger;; PURPLE) echo purple;; GOLD) echo accent;; esac
}
anchored() { # $1=prefix $2=file  (color-context only; run twice for ternaries)
  for nm in DARK_BG DARK BG CARD_BG CARD BORDER TEXT TXT SUBTLE SUB MUTED ACCENT GREEN DANGER RED PURPLE GOLD; do
    k=$(mapname "$nm")
    for pass in 1 2; do
      sed -i -E "s/(olor=\{[^}]*)\b${nm}\b/\1${1}${k}/g; s/(olor:[[:space:]]*)\b${nm}\b/\1${1}${k}/g; s/(\?[[:space:]]*)\b${nm}\b/\1${1}${k}/g; s/(:[[:space:]]*)\b${nm}\b([[:space:]]*[,})])/\1${1}${k}\2/g" "$2"
    done
  done
}
head -n $((ss-1)) "$f" > /tmp/_hd; tail -n +$ss "$f" > /tmp/_tl
anchored "colors." /tmp/_hd
bareword "c." /tmp/_tl
cat /tmp/_hd /tmp/_tl > "$f"

sed -i "s/^const [Ss] = StyleSheet.create(/const makeStyles = (c: Palette) => StyleSheet.create(/" "$f"
depth="../"; grep -qE "from '\.\./\.\./" "$f" && depth="../../"
perl -0pi -e "s#(from 'react-native';\n)#\${1}import { type Palette } from '${depth}constants/theme';\nimport { useTheme } from '${depth}lib/theme';\n#" "$f"
grep -qE "\buseMemo\b" "$f" || perl -0pi -e "s/(import (?:React, )?\{[^}]*?)\} from 'react';/\$1, useMemo} from 'react';/s" "$f"
perl -0pi -e 's/\nexport default function /\nfunction useS() {\n  const { colors } = useTheme();\n  return useMemo(() => makeStyles(colors), [colors]);\n}\n\nexport default function /' "$f"
perl -0pi -e "s/(export default function \w+\([^)]*\) \{\n)/\${1}  const { colors } = useTheme();\n  const ${svar} = useS();\n/" "$f"
echo "DONE $f (\$$svar @$ss)"
