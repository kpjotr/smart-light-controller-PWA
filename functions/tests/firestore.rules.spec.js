const fs = require("fs");
const path = require("path");
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require("@firebase/rules-unit-testing");
const {
  doc,
  setDoc,
  updateDoc,
  arrayRemove,
  deleteField,
  serverTimestamp,
  Timestamp,
} = require("firebase/firestore");

const projectId = "demo-smart-light-audit";
const rules = fs.readFileSync(
  path.resolve(__dirname, "../../firestore.rules"),
  "utf8"
);

/** Seeds a device document that rules tests may read and update. */
async function seedDevice(env) {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "devices/SmartLight-0001"), {
      espUid: "001122334455",
      allowedUsers: ["alice", "bob", "001122334455"],
      customNames: {alice: "Alice lamp", bob: "Bob lamp"},
      threshold: 50,
      sensitivity: 50,
      duration: 60,
      safety_off_min: 0,
      lamp_wattage_w: 0,
      total_on_seconds: 0,
      remote_lamp_on: false,
      restart_requested: false,
      updatedAt: Timestamp.now(),
    });
  });
}

/** Runs the Firestore Rules emulator assertions. */
async function run() {
  const env = await initializeTestEnvironment({
    projectId,
    firestore: {rules},
  });
  try {
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();

    await seedDevice(env);
    await assertSucceeds(updateDoc(doc(alice, "devices/SmartLight-0001"), {
      "allowedUsers": arrayRemove("alice"),
      "customNames.alice": deleteField(),
      "updatedAt": serverTimestamp(),
    }));

    await env.clearFirestore();
    await seedDevice(env);
    await assertFails(updateDoc(doc(alice, "devices/SmartLight-0001"), {
      allowedUsers: ["bob", "001122334455", "mallory"],
      updatedAt: serverTimestamp(),
    }));

    const expiresAt = Timestamp.fromDate(new Date(Date.now() + 60_000));
    await assertFails(setDoc(doc(alice, "pairing_requests/SmartLight-0001"), {
      userId: "alice",
      requesterUid: "alice",
      pin: "ABCDEFGHIJ",
      attempts: 0,
      expiresAt,
      customName: "Alice lamp",
    }));
    await assertFails(setDoc(doc(bob, "pairing_requests/SmartLight-0001"), {
      userId: "bob",
      requesterUid: "bob",
      pin: "ABCDEFGHIJ",
      attempts: 0,
      expiresAt,
      customName: "Bob lamp",
    }));
    console.log("Rules tests passed.");
  } finally {
    await env.cleanup();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
