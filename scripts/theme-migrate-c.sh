#!/usr/bin/env bash
# Theme a single-component screen that uses a local palette OBJECT
# (const C = { bg:'#..', card:'#..', ... }). Maps C.<key> -> c.<role> (StyleSheet)
# / colors.<role> (render) via a semantic key map, deletes the C object, adds the
# makeStyles/useS boilerplate. SAFE: c.<role> must be a real Palette key, so any
# bad mapping is a tsc error (revert + fix).
f="$1"
grep -qE "useTheme|makeStyles\(" "$f" && { echo "SKIP $f"; exit 0; }
[ "$(grep -cE '^export default function' "$f")" = "1" ] || { echo "MANUAL(comps) $f"; exit 3; }
grep -qE "^const [Ss] = StyleSheet\.create\(\{" "$f" || { echo "MANUAL(nostyle) $f"; exit 3; }
# Palette object var (first const NAME = { with a hex inside).
for cand in C CLR COLORS Colors COLOR THEME PALETTE; do grep -qE "^const ${cand} *= *{" "$f" && { cvar=$cand; break; }; done
[ -z "$cvar" ] && { echo "MANUAL(noCobj) $f"; exit 3; }
ss=$(grep -nE "^const [Ss] = StyleSheet\.create\(\{" "$f" | head -1 | cut -d: -f1)
svar=$(sed -n "${ss}p" "$f" | grep -oE "^const [Ss]" | grep -oE "[Ss]$")

# key -> palette role
roles() { # $1 prefix, $2 file
  local p="$1"; local v="$cvar"
  sed -i -E "s/\b${v}\.(bg|background|dark|base|backdrop)\b/${p}bg/g; \
s/\b${v}\.(surfaceSolid|surface|panel|elevated)\b/${p}surfaceSolid/g; \
s/\b${v}\.(card|cardBg|tile|sheet|box)\b/${p}card/g; \
s/\b${v}\.(border|line|stroke|outline|divider)\b/${p}border/g; \
s/\b${v}\.(separator|sep)\b/${p}separator/g; \
s/\b${v}\.(textFaint|faint|hint|placeholder|ghost)\b/${p}textFaint/g; \
s/\b${v}\.(textDim|sub|subtle|dim|muted|secondary|sub2|label|meta|gray|grey)\b/${p}textDim/g; \
s/\b${v}\.(text|txt|title|fg|foreground|heading|white|ink|primaryText)\b/${p}text/g; \
s/\b${v}\.(primary|green|brand|emerald|mint)\b/${p}primary/g; \
s/\b${v}\.(accent|cyan|teal|blue|gold|amber|warn|warning|link|info)\b/${p}accent/g; \
s/\b${v}\.(purple|violet|indigo|magenta)\b/${p}purple/g; \
s/\b${v}\.(danger|red|error|destructive)\b/${p}danger/g; \
s/\b${v}\.(success|online|ok)\b/${p}success/g" "$2"
}
head -n $((ss-1)) "$f" > /tmp/_hd; tail -n +$ss "$f" > /tmp/_tl
roles "colors." /tmp/_hd
roles "c." /tmp/_tl
cat /tmp/_hd /tmp/_tl > "$f"

# Any leftover (unmapped) cvar.key → substitute its LITERAL value from the C
# object, so non-palette brand colors keep their exact value (dark mode identical;
# they just won't theme in light mode). Only standard roles got tokenised above.
cblock=$(perl -0ne "print \$1 if /const ${cvar} *= *\{(.*?)\n?\}/s" "$f")
echo "$cblock" | grep -oE "[a-zA-Z0-9_]+ *: *('[^']*'|\"[^\"]*\"|rgba?\([^)]*\))" | while IFS= read -r pair; do
  key=$(echo "$pair" | sed -E "s/ *:.*//; s/[^a-zA-Z0-9_]//g")
  val=$(echo "$pair" | sed -E "s/^[^:]*: *//")
  [ -n "$key" ] && sed -i "s|\\b${cvar}\\.${key}\\b|${val}|g" "$f"
done

# Delete the C object definition: single-line, or multi-line up to a line that
# ends the object ("};" or "} as const;").
perl -0pi -e "s/^const ${cvar} *= *\{[^\n]*\};[ \t]*(\/\/[^\n]*)?\n//m" "$f"
perl -0pi -e "s/^const ${cvar} *= *\{.*?\}(?: as const)?;[ \t]*\n//ms" "$f"

sed -i "s/^const [Ss] = StyleSheet.create(/const makeStyles = (c: Palette) => StyleSheet.create(/" "$f"
depth="../"; grep -qE "from '\.\./\.\./" "$f" && depth="../../"
perl -0pi -e "s#(from 'react-native';\n)#\${1}import { type Palette } from '${depth}constants/theme';\nimport { useTheme } from '${depth}lib/theme';\n#" "$f"
grep -qE "\buseMemo\b" "$f" || perl -0pi -e "s/(import (?:React, )?\{[^}]*?)\} from 'react';/\$1, useMemo} from 'react';/s" "$f"
perl -0pi -e 's/\nexport default function /\nfunction useS() {\n  const { colors } = useTheme();\n  return useMemo(() => makeStyles(colors), [colors]);\n}\n\nexport default function /' "$f"
perl -0pi -e "s/(export default function \w+\([^)]*\) \{\n)/\${1}  const { colors } = useTheme();\n  const ${svar} = useS();\n/" "$f"
echo "DONE $f (C=$cvar \$$svar @$ss)"
