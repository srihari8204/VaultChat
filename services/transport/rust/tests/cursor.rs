use transport_core::body::{
    decode_cursor_batch, decode_cursor_sync, encode_cursor_sync, Cursor, CursorSync,
};
use transport_core::parse::Limits;

#[test]
fn mutation_continuation_round_trips_and_old_peers_default_empty() {
    let sync = CursorSync {
        cursors: vec![Cursor {
            chat_id: "c1",
            kind: 3,
            position: 9_007_199_254_740_993,
            updated_at_ms: 42,
            unknown: vec![],
        }],
        mutation_continuation: "2026-09-15T00:00:00Z|7",
        unknown: vec![],
    };
    let bytes = encode_cursor_sync(&sync);
    let got = decode_cursor_sync(&bytes, &Limits::default(), 1).unwrap();
    assert_eq!(got, sync);

    let old = decode_cursor_sync(&[0x0a, 0x00], &Limits::default(), 1).unwrap();
    assert_eq!(old.mutation_continuation, "");

    // CursorBatch: cursor c1@8, more=true, mutation_continuation field 4.
    let batch = [
        0x0a, 0x08, 0x0a, 0x02, b'c', b'1', 0x10, 0x03, 0x18, 0x08, 0x10, 0x01, 0x22, 0x16, b'2',
        b'0', b'2', b'6', b'-', b'0', b'9', b'-', b'1', b'5', b'T', b'0', b'0', b':', b'0', b'0',
        b':', b'0', b'1', b'Z', b'|', b'8',
    ];
    let got = decode_cursor_batch(&batch, &Limits::default(), 1).unwrap();
    assert!(got.more);
    assert_eq!(got.cursors[0].position, 8);
    assert_eq!(got.mutation_continuation, "2026-09-15T00:00:01Z|8");
}
