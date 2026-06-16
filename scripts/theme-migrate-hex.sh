#!/usr/bin/env bash
# Theme a pure-inline-hex screen (no palette object) by PROPERTY-AWARE hex
# mapping. Structural neutrals (black/gray/white) only map inside the CSS
# property where their meaning is unambiguous, so we never invert a light
# surface into dark text or vice-versa. Brand hues (green/cyan/purple/red) are
# semantic regardless of property, so they map anywhere. Everything else is
# left literal (preserved -> dark mode unchanged for those).
#
# Mapping rules (neutrals):
#   backgroundColor: <near-black>      -> bg
#   backgroundColor: <dark gray-blue>  -> card
#   borderColor:     <any dark gray>   -> border
#   color:           <white/off-white> -> text
#   color:           <mid gray>        -> textDim
#   shadowColor stays literal; '#fff' label-on-fill stays literal.
#
# tsc gate (caller) validates produced keys. Diffs still worth a glance.
f="$1"
grep -qE "useTheme|makeStyles\(" "$f" && { echo "SKIP(themed) $f"; exit 0; }
[ "$(grep -cE '^export default function' "$f")" = "1" ] || { echo "MANUAL(comps) $f"; exit 3; }
[ "$(grep -cE 'StyleSheet\.create\(\{' "$f")" = "1" ] || { echo "MANUAL(ss!=1) $f"; exit 3; }
ss=$(grep -nE "^const [A-Za-z]+ = StyleSheet\.create\(\{" "$f" | head -1 | cut -d: -f1)
[ -z "$ss" ] && { echo "MANUAL(nostyle) $f"; exit 3; }
svar=$(sed -n "${ss}p" "$f" | grep -oE "^const [A-Za-z]+" | sed "s/^const //")

NEARBLACK="#0[AaBb]0[AaBb]0[Ff]|#0[Bb]0[Ff]1[0-9A-Fa-f]|#0[Dd]111[0-9A-Fa-f]|#0[Ff]172[Aa]|#000000|#000|#0[Aa]0[Aa]0[Aa]|#0[Cc]0[Cc]1[0-9A-Fa-f]|#0[Ee]0[Ee]14"
DARKCARD="#1[0-9A-Fa-f]1[0-9A-Fa-f]1[0-9A-Fa-f]|#1[Aa]1[Aa]2[Ee]|#16213[Ee]|#1[Ee]293[Bb]|#1[Ff]2937|#15161[Dd]|#14141[Bb]|#192233|#1[Cc]1[Cc]1[Ee]|#222|#202020|#23232[0-9A-Fa-f]"
GRAYBORDER="#374151|#334155|#2[Dd]3748|#283548|#283039|#30363[Dd]|#3[Ff]3[Ff]46|#2[Aa]2[Aa]35|#333|#444|#2[Cc]2[Cc]2[Ee]"
MIDGRAY="#9[Cc][Aa]3[Aa][Ff]|#6[Bb]7280|#94[Aa]3[Bb]8|#64748[Bb]|#8[Ee]8[Ee]93|#[Aa]1[Aa]1[Aa][Aa]|#[Aa][Aa][Aa]|#888|#999|#777|#[Cc]9[Cc][Aa][Dd]4|#[Dd]1[Dd]5[Dd][Bb]|#6[Bb]6[Bb]6[Bb]|#808080"
WHITE="#[Ff]9[Ff][Aa][Ff][Bb]|#[Ff]3[Ff]4[Ff]6|#[Ee]5[Ee]7[Ee][Bb]|#[Ee][Dd][Ee][Ee][Ff]1|#[Ff]5[Ff]5[Ff]5|#[Ee][Ee][Ee]|#[Ff][Ff][Ff][Ff][Ff][Ff]|#[Ff][Ff][Ff]"

map() { # $1 file  $2 prefix(c. | colors.)
  local F="$1" P="$2"
  # --- brand hues: property-independent ---
  sed -i -E "s/'(#10[Bb]981|#22[Cc]55[Ee]|#34[Dd]399|#059669|#16[Aa]34[Aa]|#4[Aa][Dd][Ee]80)'/${P}primary/g" "$F"
  sed -i -E "s/'(#06[Bb]6[Dd]4|#00[Dd]9[Ff][Ff]|#0[Ee][Aa]5[Ee]9|#3[Bb]82[Ff]6|#2563[Ee][Bb]|#38[Bb][Dd][Ff]8|#60[Aa]5[Ff][Aa])'/${P}accent/g" "$F"
  sed -i -E "s/'(#8[Bb]5[Cc][Ff]6|#[Aa]855[Ff]7|#7[Cc]3[Aa][Ee][Dd]|#6366[Ff]1|#[Aa]78[Bb][Ff][Aa])'/${P}purple/g" "$F"
  sed -i -E "s/'(#[Ee][Ff]4444|#[Dd][Cc]2626|#[Ff]87171|#[Ff][Ff]3[Bb]30|#[Ee]11[Dd]48|#[Ff]56565)'/${P}danger/g" "$F"
  # --- neutrals: only inside their natural property ---
  sed -i -E "s/(backgroundColor: )'(${NEARBLACK})'/\1${P}bg/g" "$F"
  sed -i -E "s/(backgroundColor: )'(${DARKCARD})'/\1${P}card/g" "$F"
  sed -i -E "s/(borderColor: )'(${GRAYBORDER}|${DARKCARD})'/\1${P}border/g" "$F"
  sed -i -E "s/(borderBottomColor: )'(${GRAYBORDER}|${DARKCARD})'/\1${P}border/g" "$F"
  sed -i -E "s/(borderTopColor: )'(${GRAYBORDER}|${DARKCARD})'/\1${P}border/g" "$F"
  sed -i -E "s/(color: )'(${WHITE})'/\1${P}text/g" "$F"
  sed -i -E "s/(color: )'(${MIDGRAY})'/\1${P}textDim/g" "$F"
}
head -n $((ss-1)) "$f" > /tmp/_hh; tail -n +$ss "$f" > /tmp/_ht
map /tmp/_hh "colors."
map /tmp/_ht "c."
cat /tmp/_hh /tmp/_ht > "$f"

sed -i "s/^const ${svar} = StyleSheet.create(/const makeStyles = (c: Palette) => StyleSheet.create(/" "$f"
depth="../"; grep -qE "from '\.\./\.\./" "$f" && depth="../../"
grep -q "constants/theme'" "$f" || perl -0pi -e "s#(from 'react-native';\n)#\${1}import { type Palette } from '${depth}constants/theme';\n#" "$f"
grep -q "lib/theme'" "$f"      || perl -0pi -e "s#(from 'react-native';\n)#\${1}import { useTheme } from '${depth}lib/theme';\n#" "$f"
grep -qE "\buseMemo\b" "$f" || perl -0pi -e "s/(import (?:React, )?\{[^}]*?)\} from 'react';/\$1, useMemo} from 'react';/s" "$f"
grep -qE "\buseMemo\b" "$f" || perl -0pi -e "s#(from 'react-native';\n)#\${1}import { useMemo } from 'react';\n#" "$f"
perl -0pi -e 's/\nexport default function /\nfunction useS() {\n  const { colors } = useTheme();\n  return useMemo(() => makeStyles(colors), [colors]);\n}\n\nexport default function /' "$f"
perl -0pi -e "s/(export default function \w+\([^)]*\) \{\n)/\${1}  const { colors } = useTheme();\n  const ${svar} = useS();\n/" "$f"
echo "DONE $f (\$$svar @$ss)"
