## ADDED Requirements

### Requirement: Streaming, bounded-memory archive access

`lib/waImport.ts` SHALL read a WhatsApp export ZIP incrementally and SHALL NOT load the whole
archive into memory. Peak additional memory SHALL be bounded by one read chunk plus the
inflated transcript, independent of archive size.

The parser SHALL inflate only the transcript entry. Media entries SHALL be enumerated by name
and size without being decompressed.

The parser SHALL NOT write the archive's contents to disk during parsing.

#### Scenario: Large archive

- **WHEN** a 2 GB export containing a 400 KB transcript is parsed
- **THEN** the parse SHALL complete
- **AND** the process SHALL NOT allocate a buffer proportional to the archive size

#### Scenario: Media entries are enumerated, not inflated

- **WHEN** an archive containing media entries is parsed
- **THEN** each media entry's name and declared size SHALL be available to the caller
- **AND** no media entry's bytes SHALL have been decompressed during the parse

### Requirement: Archive input is untrusted

The parser SHALL treat the archive as untrusted input. It SHALL validate archive structure and
entry names, and SHALL refuse malformed or hostile archives without crashing the application.

Entry paths SHALL be validated with `safeEntryPath()` from `lib/archive.ts` before any
filesystem use. Absolute paths, drive-qualified paths, paths containing `..`, and paths
containing NUL SHALL be refused.

The parser SHALL refuse a transcript entry whose declared uncompressed size exceeds 64 MB, or
whose compression ratio exceeds 200:1. The parser SHALL abort if actual inflated bytes exceed
the entry's declared uncompressed size.

Nothing from the archive SHALL be executed, evaluated, or used to construct a filesystem path
without validation.

#### Scenario: Path traversal entry

- **WHEN** an archive contains an entry named `../../secrets.txt`
- **THEN** that entry SHALL be refused
- **AND** no file SHALL be written outside the import destination directory

#### Scenario: Decompression bomb

- **WHEN** an archive's transcript entry declares a small compressed size but inflates beyond
  its declared uncompressed size, or exceeds the 64 MB ceiling
- **THEN** the parse SHALL abort with an invalid-export result
- **AND** the application SHALL NOT crash or run out of memory

#### Scenario: Corrupted archive

- **WHEN** the selected file is truncated, is not a ZIP, or has an unreadable central directory
- **THEN** the parser SHALL return an invalid-export result naming the problem
- **AND** SHALL NOT throw an unhandled error

### Requirement: Transcript format detection

The parser SHALL detect the transcript's line format from a sample of the export rather than
assuming one, covering at least: 12-hour and 24-hour clocks; `DD/MM/YY`, `MM/DD/YY` and
`YYYY-MM-DD` date orders; bracketed and unbracketed timestamp headers; and Unicode directional
marks or narrow no-break spaces adjacent to AM/PM markers.

Day-versus-month order SHALL be resolved by finding a day component greater than 12 within the
sample. When the sample is genuinely ambiguous, the parser SHALL report the ambiguity to the
caller rather than choosing, so the user can be asked.

Lines that do not begin with a recognised timestamp header SHALL be treated as continuations
of the preceding message.

#### Scenario: Unambiguous DD/MM export

- **WHEN** a transcript sample contains a date whose first component is greater than 12
- **THEN** the parser SHALL select the corresponding date order
- **AND** SHALL apply it to every line in the export

#### Scenario: Ambiguous date order

- **WHEN** every sampled date has both components 12 or lower
- **THEN** the parser SHALL report the date order as ambiguous
- **AND** SHALL NOT silently pick an order

#### Scenario: Multi-line message

- **WHEN** a message body spans several lines
- **THEN** all continuation lines SHALL be joined into one message preserving their line breaks
- **AND** SHALL NOT be emitted as separate messages

#### Scenario: Unrecognised format

- **WHEN** no known header format matches the transcript
- **THEN** the parser SHALL return an unsupported-format result
- **AND** SHALL NOT emit partially-parsed messages as if they were complete

### Requirement: Fidelity of parsed output

Parsed messages SHALL preserve original ordering, original timestamps, and the original sender
label from the export. Message bodies SHALL be preserved byte-for-byte as exported; the parser
SHALL NOT rewrite, annotate, prefix, or normalise the body text.

The parser SHALL retain the raw exported timestamp string alongside the resolved value.

Supported media references SHALL retain their filename and, where the export provides it, the
declared size and the caption attached to the media message.

Lines that cannot be parsed SHALL be counted and reported as unsupported items. They SHALL NOT
be silently discarded, and SHALL NOT be emitted as messages.

#### Scenario: Timestamps preserved

- **WHEN** a message exported at a given local date and time is parsed
- **THEN** the emitted message's timestamp SHALL represent that same local wall-clock time
- **AND** the raw exported timestamp string SHALL also be retained

#### Scenario: Body not rewritten

- **WHEN** a message body is parsed
- **THEN** the emitted body SHALL equal the exported body exactly, with no added attribution,
  prefix or suffix

#### Scenario: Unsupported lines counted

- **WHEN** a transcript contains lines the parser cannot interpret
- **THEN** the parser SHALL report their count
- **AND** the count SHALL be surfaced to the user as unsupported items

### Requirement: Group exports are refused

The parser SHALL detect an export originating from a group conversation and SHALL refuse it,
because importing it into a 1:1 chat would place third parties' messages into a two-person
conversation.

#### Scenario: Group export selected

- **WHEN** a parsed transcript contains three or more distinct sender identities
- **THEN** the parser SHALL report it as a group export
- **AND** the flow SHALL stop before preview, with no messages written

### Requirement: Edge-case exports

The parser SHALL handle an export with no messages, and an export with exactly one message,
without error.

#### Scenario: Empty export

- **WHEN** an export contains a transcript with no parseable messages
- **THEN** the parser SHALL return an empty result reported as such
- **AND** the flow SHALL inform the user that there was nothing to import, with no messages written

#### Scenario: Single-message export

- **WHEN** an export contains exactly one message
- **THEN** the parser SHALL emit exactly that one message with its correct timestamp and sender

### Requirement: The parser is pure and has no network reach

`lib/waImport.ts` SHALL be a pure module: it SHALL NOT import `react-native`, the app's API
client, the socket layer, or any upload path, and SHALL NOT reference `fetch`, `XMLHttpRequest`
or `WebSocket`. It SHALL be executable and testable under Node.

#### Scenario: Source scan

- **WHEN** the self-test scans `lib/waImport.ts`
- **THEN** it SHALL find no reference to `fetch(`, `lib/api`, `socket`, `upload`, `XMLHttpRequest`
  or `WebSocket`
- **AND** the test SHALL fail if any is introduced later
