/** Split short-wide boards from their scrolling controls; input is the safe viewport. */
export function chessTttLayout(width: number, height: number, portraitSize: number) {
  const wide = width >= 600 && width > height;
  const size = wide ? Math.floor(Math.max(200, Math.min(height - 32, width - 304))) : portraitSize;
  return { wide, size, controlsWidth: wide ? width - size - 64 : size };
}
