const crypto = require("crypto");
const admin = require("firebase-admin");

const projectId = "demo-smart-light-audit";
const functionUrl =
  `http://127.0.0.1:5001/${projectId}/europe-west1/requestPairing`;
const authUrl =
  "http://127.0.0.1:9099/identitytoolkit.googleapis.com" +
  "/v1/accounts:signUp?key=fake-key";
const deviceId = "SmartLight-0001";
const passkey = "ABCDEF1234";

/** Throws when a test condition is not met. */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Creates the passkey representation expected by the Function. */
function passkeyHash(value) {
  const salt = "0123456789abcdef0123456789abcdef";
  const digest = crypto
    .createHash("sha256")
    .update(`${salt}:${value}`, "utf8")
    .digest("hex");
  return `${salt}:${digest}`;
}

/** Creates and authenticates a user in the Auth emulator. */
async function createUser(email) {
  const response = await fetch(authUrl, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      email,
      password: "emulator-password",
      returnSecureToken: true,
    }),
  });
  assert(
    response.ok,
    `Auth emulator user creation failed: ${response.status}`
  );
  return (await response.json()).idToken;
}

/** Calls the pairing Callable endpoint through the Functions emulator. */
async function callPairing(data, idToken) {
  const headers = {"Content-Type": "application/json"};
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const response = await fetch(functionUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({data}),
  });
  return {status: response.status, body: await response.json()};
}

/** Verifies that a Callable response reports the expected error status. */
function assertError(result, expectedStatus) {
  assert(result.status !== 200, "Expected callable request to fail.");
  assert(
    result.body?.error?.status === expectedStatus,
    `Expected ${expectedStatus}, got ${JSON.stringify(result.body)}`
  );
}

/** Runs authentication, validation, duplicate, and rate-limit test cases. */
async function run() {
  assert(
    process.env.FIRESTORE_EMULATOR_HOST,
    "Set FIRESTORE_EMULATOR_HOST before running this test."
  );
  admin.initializeApp({projectId});
  const firestore = admin.firestore();
  await firestore.collection("devices").doc(deviceId).set({
    allowedUsers: [],
    customNames: {},
    passkeyHash: passkeyHash(passkey),
    failedPairAttempts: 0,
  });

  const unauthenticated = await callPairing({
    deviceId,
    passkey,
    customName: "Lamp",
  });
  assertError(unauthenticated, "UNAUTHENTICATED");

  const aliceToken = await createUser("alice@example.test");
  const malformed = await callPairing(
    {deviceId: "bad", passkey, customName: "Lamp"},
    aliceToken
  );
  assertError(malformed, "INVALID_ARGUMENT");

  const bobToken = await createUser("bob@example.test");
  const wrongPasskey = await callPairing(
    {deviceId, passkey: "WRONG00000", customName: "Lamp"},
    bobToken
  );
  assertError(wrongPasskey, "PERMISSION_DENIED");
  const afterWrongPasskey = await firestore.collection("devices")
    .doc(deviceId).get();
  assert(
    afterWrongPasskey.data().failedPairAttempts === 1,
    "Wrong passkey did not increment the device counter."
  );

  const rateToken = await createUser("rate@example.test");
  const valid = await callPairing(
    {deviceId, passkey, customName: "Rate lamp"},
    rateToken
  );
  assert(
    valid.status === 200 && valid.body?.result?.ok === true,
    "Valid pairing failed."
  );

  const duplicate = await callPairing(
    {deviceId, passkey, customName: "Rate lamp"},
    rateToken
  );
  assert(duplicate.status === 200, "Duplicate pairing should be idempotent.");
  const device = await firestore.collection("devices").doc(deviceId).get();
  assert(
    device.data().allowedUsers.length === 1,
    "Duplicate pairing added another owner."
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const accepted = await callPairing(
      {deviceId, passkey, customName: "Rate lamp"},
      rateToken
    );
    assert(accepted.status === 200, "Rate-limit setup request failed.");
  }
  const rateLimited = await callPairing(
    {deviceId, passkey, customName: "Rate lamp"},
    rateToken
  );
  assertError(rateLimited, "RESOURCE_EXHAUSTED");
  console.log("requestPairing emulator tests passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
