package realtime

// Room is a fan-out address: "chat:<id>", "call:<id>", "user:<id>", "admin".
//
// It was socket.Room, from the Socket.IO library, even though both transports
// used it — CC-Wire's eventPeer joins and leaves the same names. Defining it
// here is what lets the Socket.IO dependency leave without touching a single
// room name or any routing behaviour.
type Room string
