const { initializeApp } = require('firebase/app');
const { initializeAuth, createUserWithEmailAndPassword, updateProfile } = require('firebase/auth');
const { getFirestore, doc, setDoc } = require('firebase/firestore');

const firebaseConfig = {
  apiKey: "AIzaSyDKic9s-_fyg4OeAttQgZVBj4mT-4UkGSc",
  authDomain: "vaultchat-ce9e3.firebaseapp.com",
  projectId: "vaultchat-ce9e3",
  storageBucket: "vaultchat-ce9e3.appspot.com",
  messagingSenderId: "207307621485",
  appId: "1:207307621485:android:56aa1a7927a5a77bdeab64"
};

const app = initializeApp(firebaseConfig);
const auth = initializeAuth(app);
const db = getFirestore(app);

async function createTestUser() {
  try {
    console.log("Creating test user...");
    const cred = await createUserWithEmailAndPassword(auth, "test@vaultchat.com", "Vault@1234");
    await updateProfile(cred.user, { displayName: "VaultChat Tester" });
    await setDoc(doc(db, "users", cred.user.uid), {
      uid: cred.user.uid,
      displayName: "VaultChat Tester",
      email: "test@vaultchat.com",
      mobile: "+919999999999",
      vaultId: "VC-TEST-0001-ABCD",
      verified: true,
      createdAt: new Date().toISOString(),
      online: false,
      trustScore: 87,
      securityScore: 94,
      faceEnrolled: false,
    });
    console.log("\n SUCCESS! Test user created!");
    console.log("================================");
    console.log("Email    : test@vaultchat.com");
    console.log("Password : Vault@1234");
    console.log("================================\n");
    process.exit(0);
  } catch (e) {
    if (e.code === "auth/email-already-in-use") {
      console.log("\n User already exists! Use these credentials:");
      console.log("================================");
      console.log("Email    : test@vaultchat.com");
      console.log("Password : Vault@1234");
      console.log("================================\n");
    } else {
      console.error("Error:", e.message);
    }
    process.exit(0);
  }
}

createTestUser();
