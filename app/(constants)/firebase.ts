// app/(constants)/firebase.ts
// Re-export from root constants for app/ imports

import app, { auth, db } from '../../constants/firebase';

export { auth, db };
export default app;
