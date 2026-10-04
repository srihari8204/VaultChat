// constants/syntaxPalette.ts — the code preview's syntax-highlighting palette
// (app/file-preview.tsx).
//
// WHY THESE COLOURS ARE FIXED. Code is shown on a dark canvas in BOTH app
// themes, the way every code viewer and diff tool does: the token colours are
// a set tuned against that one canvas (they are GitHub's dark scheme), and no
// theme token can stand in for "string" or "keyword". The screen's chrome
// around the canvas still follows the app theme.
//
// constants/syntaxPalette.selftest.ts checks every token colour and the line
// numbers clear WCAG AA (4.5:1) on the canvas they sit on. Change a colour
// here and run it.

export type SyntaxToken = 'keyword' | 'string' | 'comment' | 'number' | 'function' | 'type' | 'operator'
  | 'property' | 'tag' | 'attribute' | 'punctuation' | 'default';

export const SYNTAX_TOKEN_COLORS: Record<SyntaxToken, string> = {
  keyword: '#FF7B72',
  string: '#A5D6FF',
  comment: '#8B949E',
  number: '#79C0FF',
  function: '#D2A8FF',
  type: '#FFA657',
  operator: '#FF7B72',
  property: '#79C0FF',
  tag: '#7EE787',
  attribute: '#79C0FF',
  punctuation: '#C9D1D9',
  default: '#C9D1D9',
};

/** The canvas the tokens are drawn on, and its line-number gutter. */
export const CODE_CANVAS = {
  bg: '#0D1117',
  gutterBg: '#161B22',
  gutterRule: '#21262D',
  lineNum: '#8B949E',
  text: SYNTAX_TOKEN_COLORS.default,
} as const;
