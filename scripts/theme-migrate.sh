#!/usr/bin/env bash
# Migrate a single-component, Aurora-based screen to themed colors (U3).
# Mechanical: render Aurora.* -> colors.*, StyleSheet Aurora.* -> c.*, makeStyles,
# import swap, react useMemo, useS() helper + component hooks. Idempotent guard.
set -e
f="$1"
grep -qE "useTheme|makeStyles\(" "$f" && { echo "SKIP $f"; exit 0; }
# Only handle the exact-single-Aurora-import + single default-function shape.
grep -qE "^import \{ Aurora \} from '((\.\./){1,2})constants/theme';" "$f" || { echo "MANUAL(import) $f"; exit 3; }
[ "$(grep -cE '^export default function' "$f")" = "1" ] || { echo "MANUAL(comps) $f"; exit 3; }
ss=$(grep -nE "^const [Ss] = StyleSheet\.create\(\{" "$f" | head -1 | cut -d: -f1)
[ -z "$ss" ] && { echo "MANUAL(nostyle) $f"; exit 3; }
svar=$(sed -n "${ss}p" "$f" | grep -oE "^const [Ss]" | grep -oE "[Ss]$")
sed -i "1,$((ss-1)) s/Aurora\./colors./g" "$f"
sed -i "${ss},\$ s/Aurora\./c./g" "$f"
sed -i "s/^const [Ss] = StyleSheet.create(/const makeStyles = (c: Palette) => StyleSheet.create(/" "$f"
perl -0pi -e "s/import \{ Aurora \} from '((?:\.\.\/){1,2})constants\/theme';/import { type Palette } from '\${1}constants\/theme';\nimport { useTheme } from '\${1}lib\/theme';/g" "$f"
grep -qE "\buseMemo\b" "$f" || perl -0pi -e "s/(import (?:React, )?\{[^}]*?)\} from 'react';/\$1, useMemo} from 'react';/s" "$f"
perl -0pi -e 's/\nexport default function /\nfunction useS() {\n  const { colors } = useTheme();\n  return useMemo(() => makeStyles(colors), [colors]);\n}\n\nexport default function /' "$f"
perl -0pi -e "s/(export default function \w+\([^)]*\) \{\n)/\${1}  const { colors } = useTheme();\n  const ${svar} = useS();\n/" "$f"
echo "DONE $f (\$$svar @$ss)"
