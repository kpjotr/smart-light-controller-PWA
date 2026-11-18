import * as crypto from "crypto";
import {onRequest, Request} from "firebase-functions/v2/https";
import {Response} from "express";
import {
  onDocumentWritten,
  onDocumentUpdated,
  onDocumentDeleted,
} from "firebase-functions/v2/firestore";
import {onValueUpdated, onValueWritten} from "firebase-functions/v2/database";
import * as admin from "firebase-admin";
import {getAuth} from "firebase-admin/auth";
import {getDatabase, ServerValue} from "firebase-admin/database";

const RTDB_URL =
  "https://okospilacsvezerlo-default-rtdb.europe-west1.firebasedatabase.app";
const RTDB_INSTANCE = "okospilacsvezerlo-default-rtdb";
const RTDB_REGION = "europe-west1";

admin.initializeApp({databaseURL: RTDB_URL});
const db = admin.firestore();
const rtdb = getDatabase();

// 1. Védelmi réteg: Statikus Pre-Shared Key
// (később kiszervezhető Secret Managerbe)
const ESP_AUTH_TOKEN = "ESP32_SECRET_TOKEN_998877";
const PASSKEY_REGEX = /^[A-Z0-9]{10}$/;
const DEVICE_ID_REGEX = /^SmartLight-[0-9A-Fa-f]{4}$/;
const ESP_UID_REGEX = /^[0-9A-Fa-f]{12}$/;
const CUSTOM_NAME_REGEX = /^[A-Za-z0-9 _-]{0,32}$/;
const MAX_PAIR_ATTEMPTS = 3;

/**
 * Computes a salted SHA-256 hex digest for a normalized device passkey.
 * @param {string} passkey Normalized uppercase device passkey.
 * @param {string} saltHex Hex-encoded salt string.
 * @return {string} Hex-encoded SHA-256 digest.
 */
function hashPasskeyWithSalt(passkey: string, saltHex: string): string {
  return crypto
    .createHash("sha256")
    .update(`${saltHex}:${passkey}`, "utf8")
    .digest("hex");
}

/**
 * Generates a salted SHA-256 verifier string (`salt:digest`) for a passkey.
 * @param {string} passkey Normalized uppercase device passkey.
 * @return {string} Salted SHA-256 verifier string.
 */
function createSaltedPasskeyHash(passkey: string): string {
  const saltHex = crypto.randomBytes(16).toString("hex");
  const digestHex = hashPasskeyWithSalt(passkey, saltHex);
  return `${saltHex}:${digestHex}`;
}

/**
 * Verifies a passkey against a stored `salt:digest` SHA-256 verifier
 * using constant-time comparison.
 * @param {string} passkey Normalized uppercase candidate passkey.
 * @param {unknown} storedVerifier Stored `salt:digest` string.
 * @return {boolean} True when candidate matches stored verifier.
 */
function verifyPasskeyHash(passkey: string, storedVerifier: unknown): boolean {
  if (typeof storedVerifier !== "string") {
    return false;
  }
  const parts = storedVerifier.split(":");
  if (parts.length !== 2) {
    return false;
  }
  const [saltHex, expectedHex] = parts;
  if (
    !/^[0-9a-f]{16,64}$/i.test(saltHex) ||
    !/^[0-9a-f]{64}$/i.test(expectedHex)
  ) {
    return false;
  }
  const actualHex = hashPasskeyWithSalt(passkey, saltHex);
  const actualBuf = Buffer.from(actualHex, "hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");
  if (actualBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

/**
 * Checks whether a value is an integer within an inclusive range.
 * @param {unknown} val Value to validate.
 * @param {number} min Minimum inclusive integer bound.
 * @param {number} max Maximum inclusive integer bound.
 * @return {boolean} True when val is an integer within [min, max].
 */
function isIntInRange(val: unknown, min: number, max: number): boolean {
  return typeof val === "number" &&
    Number.isInteger(val) &&
    val >= min &&
    val <= max;
}

/**
 * Extracts a deduplicated array of non-empty UID strings from unknown input.
 * @param {unknown} val Candidate list value.
 * @return {string[]} Normalized UID strings.
 */
function toUidList(val: unknown): string[] {
  if (!Array.isArray(val)) {
    return [];
  }
  const unique = new Set<string>();
  for (const item of val) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed.length > 0) {
        unique.add(trimmed);
      }
    }
  }
  return Array.from(unique);
}

/**
 * Checks whether two UID lists contain the same set of strings.
 * @param {string[]} a First UID list.
 * @param {string[]} b Second UID list.
 * @return {boolean} True when both lists have identical membership.
 */
function areStringListsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const setB = new Set(b);
  return a.every((item) => setB.has(item));
}

/**
 * Revokes refresh tokens for an Auth user, ignoring missing user records.
 * @param {string} uid Firebase Auth UID to revoke.
 * @return {Promise<void>} Resolves when revocation finishes or user is absent.
 */
async function safeRevokeRefreshTokens(uid: string): Promise<void> {
  try {
    await getAuth().revokeRefreshTokens(uid);
  } catch (error) {
    const code = (error as {code?: string})?.code;
    if (code !== "auth/user-not-found") {
      throw error;
    }
  }
}

/**
 * Deletes a Firebase Auth user, ignoring missing user records.
 * @param {string} uid Firebase Auth UID to delete.
 * @return {Promise<void>} Resolves when deletion finishes or user is absent.
 */
async function safeDeleteAuthUser(uid: string): Promise<void> {
  try {
    await getAuth().deleteUser(uid);
  } catch (error) {
    const code = (error as {code?: string})?.code;
    if (code !== "auth/user-not-found") {
      throw error;
    }
  }
}

/**
 * Ensures a Firebase Auth user record exists for the given device UID.
 * @param {string} uid Device Firebase Auth UID.
 * @return {Promise<void>} Resolves when the Auth user exists or is created.
 */
async function ensureDeviceAuthUser(uid: string): Promise<void> {
  try {
    await getAuth().getUser(uid);
  } catch (error) {
    const code = (error as {code?: string})?.code;
    if (code !== "auth/user-not-found") {
      throw error;
    }
    try {
      await getAuth().createUser({uid});
    } catch (createErr) {
      const createCode = (createErr as {code?: string})?.code;
      if (createCode !== "auth/uid-already-exists") {
        throw createErr;
      }
    }
  }
}

/**
 * Revokes refresh tokens and deletes Auth records for candidate device UIDs.
 * @param {string[]} candidates Candidate device Auth UIDs.
 * @return {Promise<void>} Resolves when all unique non-empty UIDs finish.
 */
async function revokeAndDeleteDeviceAuthUsers(
  candidates: string[]
): Promise<void> {
  const uniqueUids = new Set<string>();
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      uniqueUids.add(trimmed);
    }
  }
  await Promise.all(
    Array.from(uniqueUids).map(async (uid) => {
      await safeRevokeRefreshTokens(uid);
      await safeDeleteAuthUser(uid);
    })
  );
}

/**
 * Deletes live and acl RTDB subtrees for a device.
 * @param {string} deviceId Device identifier.
 * @return {Promise<void>} Resolves when both RTDB nodes are removed.
 */
async function removeDeviceRtdbNodes(deviceId: string): Promise<void> {
  await Promise.all([
    rtdb.ref(`live/${deviceId}`).remove(),
    rtdb.ref(`acl/${deviceId}`).remove(),
  ]);
}

/**
 * Zero-Touch device self-registration handler for ESP32 boot/Wi-Fi setup.
 * Persists passkeyHash and default settings, ensures device Auth user and
 * RTDB live subtree exist, and returns a customToken.
 * @param {Request} req Incoming HTTPS request.
 * @param {Response} res Express-compatible response object.
 * @return {Promise<void>} Resolves once response is sent.
 */
async function handleRegisterDevice(
  req: Request,
  res: Response
): Promise<void> {
  // Pre-Shared Key ellenőrzése
  if (req.header("X-Esp-Auth-Token") !== ESP_AUTH_TOKEN) {
    res.status(401).send("Unauthorized");
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const deviceId = typeof body.deviceId === "string" ?
    body.deviceId.trim() : "";
  const espUid = typeof body.espUid === "string" ?
    body.espUid.trim() : "";
  const rawPasskey = typeof body.passkey === "string" ?
    body.passkey :
    typeof body.pin === "string" ?
      body.pin :
      "";
  const normalizedPasskey = rawPasskey.trim().toUpperCase();

  if (!deviceId || !espUid || !normalizedPasskey) {
    res.status(400).send("Missing parameters");
    return;
  }

  if (!DEVICE_ID_REGEX.test(deviceId)) {
    res.status(400).send("Invalid deviceId format");
    return;
  }

  if (!ESP_UID_REGEX.test(espUid)) {
    res.status(400).send("Invalid espUid format");
    return;
  }

  if (!PASSKEY_REGEX.test(normalizedPasskey)) {
    res.status(400).send("Invalid passkey format");
    return;
  }

  const deviceRef = db.collection("devices").doc(deviceId);
  let customToken = "";
  try {
    const resolvedState = await db.runTransaction(async (tx) => {
      const deviceSnap = await tx.get(deviceRef);
      const existing = deviceSnap.exists ? (deviceSnap.data() ?? {}) : {};

      const thr = isIntInRange(existing.threshold, 1, 100) ?
        existing.threshold : 60;
      const sens = isIntInRange(existing.sensitivity, 1, 100) ?
        existing.sensitivity : 60;
      const dur = isIntInRange(existing.duration, 10, 600) ?
        existing.duration : 60;
      const safe = isIntInRange(existing.safety_off_min, 0, 1440) ?
        existing.safety_off_min : 100;
      const wattage = isIntInRange(existing.lamp_wattage_w, 0, 5000) ?
        existing.lamp_wattage_w : 0;
      const lamp = typeof existing.remote_lamp_on === "boolean" ?
        existing.remote_lamp_on : false;
      const allowedUsers = toUidList(existing.allowedUsers);
      const humanUsers = allowedUsers.filter(
        (uid) => uid !== espUid && uid !== deviceId
      );

      if (!deviceSnap.exists) {
        tx.set(deviceRef, {
          espUid,
          allowedUsers: [],
          customNames: {},
          passkeyHash: createSaltedPasskeyHash(normalizedPasskey),
          failedPairAttempts: 0,
          duration: dur,
          sensitivity: sens,
          threshold: thr,
          safety_off_min: safe,
          lamp_wattage_w: wattage,
          total_on_seconds: 0,
          lamp_on: false,
          remote_lamp_on: lamp,
          restart_requested: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        const updatePayload: Record<string, unknown> = {
          espUid,
          failedPairAttempts: 0,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        if (!Array.isArray(existing.allowedUsers)) {
          updatePayload.allowedUsers = [];
        }
        if (
          !existing.customNames ||
          typeof existing.customNames !== "object" ||
          Array.isArray(existing.customNames)
        ) {
          updatePayload.customNames = {};
        }
        if (
          typeof existing.passkeyHash !== "string" ||
          !existing.passkeyHash.includes(":")
        ) {
          updatePayload.passkeyHash = createSaltedPasskeyHash(
            normalizedPasskey
          );
        }
        if (!isIntInRange(existing.threshold, 1, 100)) {
          updatePayload.threshold = thr;
        }
        if (!isIntInRange(existing.sensitivity, 1, 100)) {
          updatePayload.sensitivity = sens;
        }
        if (!isIntInRange(existing.duration, 10, 600)) {
          updatePayload.duration = dur;
        }
        if (!isIntInRange(existing.safety_off_min, 0, 1440)) {
          updatePayload.safety_off_min = safe;
        }
        if (!isIntInRange(existing.lamp_wattage_w, 0, 5000)) {
          updatePayload.lamp_wattage_w = wattage;
        }
        if (
          typeof existing.total_on_seconds !== "number" ||
          !Number.isFinite(existing.total_on_seconds) ||
          existing.total_on_seconds < 0
        ) {
          updatePayload.total_on_seconds = 0;
        }
        if (typeof existing.lamp_on !== "boolean") {
          updatePayload.lamp_on = false;
        }
        if (typeof existing.remote_lamp_on !== "boolean") {
          updatePayload.remote_lamp_on = lamp;
        }
        if (typeof existing.restart_requested !== "boolean") {
          updatePayload.restart_requested = false;
        }

        tx.set(deviceRef, updatePayload, {merge: true});
      }

      return {thr, sens, dur, safe, wattage, lamp, humanUsers};
    });

    await ensureDeviceAuthUser(espUid);
    customToken = await getAuth().createCustomToken(espUid, {
      role: "device",
      deviceId,
    });

    await rtdb.ref(`acl/${deviceId}/${espUid}`).set(true);

    const cmdRef = rtdb.ref(`live/${deviceId}/cmd`);
    const stateRef = rtdb.ref(`live/${deviceId}/state`);
    const aclRef = rtdb.ref(`acl/${deviceId}`);
    const [cmdSnap, stateSnap] = await Promise.all([
      cmdRef.get(),
      stateRef.get(),
    ]);

    const rtdbTasks: Promise<unknown>[] = [];
    if (!cmdSnap.exists()) {
      rtdbTasks.push(
        cmdRef.set({
          lamp: resolvedState.lamp,
          restart: false,
          unpaired: false,
          thr: resolvedState.thr,
          sens: resolvedState.sens,
          dur: resolvedState.dur,
          safe: resolvedState.safe,
          wattage: resolvedState.wattage,
        })
      );
    }
    if (!stateSnap.exists()) {
      rtdbTasks.push(
        stateRef.set({
          on: false,
          auto: false,
          lux: 0,
          mot: false,
          ts: ServerValue.TIMESTAMP,
          online: true,
          last_seen: ServerValue.TIMESTAMP,
          energy_delta_sec: 0,
        })
      );
    }
    if (resolvedState.humanUsers.length > 0) {
      const aclMap: Record<string, boolean> = {[espUid]: true};
      for (const uid of resolvedState.humanUsers) {
        aclMap[uid] = true;
      }
      rtdbTasks.push(aclRef.update(aclMap));
    }

    if (rtdbTasks.length > 0) {
      await Promise.all(rtdbTasks);
    }
  } catch (err) {
    console.error("registerDevice failed:", err);
    res.status(500).json({error: "Internal server error"});
    return;
  }

  res.status(200).json({ok: true, deviceId, customToken});
}

export const verifyPairing = onRequest(handleRegisterDevice);
export const registerDevice = onRequest(handleRegisterDevice);

export const onPairingRequestCreated = onDocumentWritten(
  {
    document: "pairing_requests/{deviceId}",
    database: "(default)",
    region: RTDB_REGION,
  },
  async (event) => {
    const snap = event.data?.after;
    if (!snap || !snap.exists) {
      return;
    }
    const deviceId = event.params.deviceId;
    const reqData = snap.data() ?? {};
    if (reqData.status === "rejected") {
      return;
    }

    const requesterUid = typeof reqData.requesterUid === "string" ?
      reqData.requesterUid.trim() :
      typeof reqData.userId === "string" ?
        reqData.userId.trim() :
        typeof reqData.uid === "string" ?
          reqData.uid.trim() :
          "";
    const rawPasskey = typeof reqData.passkey === "string" ?
      reqData.passkey :
      typeof reqData.pin === "string" ?
        reqData.pin :
        "";
    const normalizedPasskey = rawPasskey.trim().toUpperCase();
    const rawCustomName = typeof reqData.customName === "string" ?
      reqData.customName.trim() : "";

    const deviceRef = db.collection("devices").doc(deviceId);
    const pairingRef = snap.ref;

    await db.runTransaction(async (tx) => {
      const deviceSnap = await tx.get(deviceRef);
      const deviceData = deviceSnap.data() ?? {};

      // Case A: Uninitialized device (never booted/connected to cloud yet)
      if (
        !deviceSnap.exists ||
        typeof deviceData.passkeyHash !== "string" ||
        !deviceData.passkeyHash.includes(":")
      ) {
        tx.update(pairingRef, {
          status: "rejected",
          errorCode: "DEVICE_UNINITIALIZED",
        });
        return;
      }

      // Case B: Initialized device (works for 0, 1, or N existing owners)
      const existingAllowed = toUidList(deviceData.allowedUsers);

      if (
        !requesterUid ||
        !PASSKEY_REGEX.test(normalizedPasskey) ||
        !CUSTOM_NAME_REGEX.test(rawCustomName)
      ) {
        tx.update(pairingRef, {
          status: "rejected",
          errorCode: "INVALID_PASSKEY",
        });
        return;
      }

      if (
        reqData.expiresAt &&
        typeof reqData.expiresAt.toDate === "function" &&
        reqData.expiresAt.toDate() < new Date()
      ) {
        tx.delete(pairingRef);
        return;
      }

      if (existingAllowed.includes(requesterUid)) {
        tx.delete(pairingRef);
        return;
      }

      const failedAttempts =
        typeof deviceData.failedPairAttempts === "number" &&
        Number.isFinite(deviceData.failedPairAttempts) ?
          deviceData.failedPairAttempts :
          0;
      if (failedAttempts >= MAX_PAIR_ATTEMPTS) {
        tx.update(pairingRef, {
          status: "rejected",
          errorCode: "LOCKED_OUT",
        });
        return;
      }

      if (!verifyPasskeyHash(normalizedPasskey, deviceData.passkeyHash)) {
        const nextAttempts = failedAttempts + 1;
        tx.update(deviceRef, {
          failedPairAttempts: nextAttempts,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        tx.update(pairingRef, {
          status: "rejected",
          errorCode: nextAttempts >= MAX_PAIR_ATTEMPTS ?
            "LOCKED_OUT" : "INVALID_PASSKEY",
          attempts: nextAttempts,
        });
        return;
      }

      const existingCustomNames = deviceData.customNames;
      const customNames: Record<string, string> =
        existingCustomNames &&
        typeof existingCustomNames === "object" &&
        !Array.isArray(existingCustomNames) ?
          {...(existingCustomNames as Record<string, string>)} :
          {};

      if (rawCustomName.length > 0) {
        customNames[requesterUid] = rawCustomName;
      } else {
        delete customNames[requesterUid];
      }

      tx.update(deviceRef, {
        allowedUsers: admin.firestore.FieldValue.arrayUnion(requesterUid),
        customNames,
        failedPairAttempts: 0,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.delete(pairingRef);
    });
  }
);

export const onDeviceUpdated = onDocumentUpdated(
  {
    document: "devices/{deviceId}",
    database: "(default)",
    region: RTDB_REGION,
  },
  async (event) => {
    if (!event.data) {
      return;
    }
    const deviceId = event.params.deviceId;
    const before = event.data.before.data() ?? {};
    const after = event.data.after.data() ?? {};

    const beforeAllowed = toUidList(before.allowedUsers);
    const afterAllowed = toUidList(after.allowedUsers);
    const allowedChanged = !areStringListsEqual(beforeAllowed, afterAllowed);
    const afterEspUid = typeof after.espUid === "string" ?
      after.espUid.trim() : "";
    const beforeEspUid = typeof before.espUid === "string" ?
      before.espUid.trim() : "";
    const espUid = afterEspUid || beforeEspUid;

    if (allowedChanged) {
      const beforeHumans = beforeAllowed.filter(
        (uid) => uid !== espUid && uid !== deviceId
      );
      const humanUsers = afterAllowed.filter(
        (uid) => uid !== espUid && uid !== deviceId
      );

      const aclMap: Record<string, boolean> = {};
      for (const uid of humanUsers) {
        aclMap[uid] = true;
      }
      if (espUid) {
        aclMap[espUid] = true;
      }
      if (Object.keys(aclMap).length > 0) {
        await rtdb.ref(`acl/${deviceId}`).set(aclMap);
      } else {
        await rtdb.ref(`acl/${deviceId}`).remove();
      }

      if (humanUsers.length === 0) {
        const cmdRef = rtdb.ref(`live/${deviceId}/cmd`);
        const cmdSnap = await cmdRef.get();
        if (cmdSnap.exists()) {
          await cmdRef.update({
            lamp: false,
            unpaired: true,
          });
        }
        // Keep device Auth user, acl/{deviceId}/{espUid}, passkeyHash,
        // live/{deviceId}, and devices/{deviceId} counters so the ESP32 stays
        // online without 401 loops and can be re-paired anytime.
        return;
      }

      if (beforeHumans.length === 0) {
        const cmdRef = rtdb.ref(`live/${deviceId}/cmd`);
        const cmdSnap = await cmdRef.get();
        if (cmdSnap.exists()) {
          await cmdRef.update({unpaired: false});
        }
      }
    }

    const cmdUpdates: Record<string, unknown> = {};
    if (
      typeof after.remote_lamp_on === "boolean" &&
      after.remote_lamp_on !== before.remote_lamp_on
    ) {
      cmdUpdates.lamp = after.remote_lamp_on;
    }
    if (
      before.restart_requested !== true &&
      after.restart_requested === true
    ) {
      cmdUpdates.restart = true;
    }
    if (
      isIntInRange(after.threshold, 1, 100) &&
      after.threshold !== before.threshold
    ) {
      cmdUpdates.thr = after.threshold;
    }
    if (
      isIntInRange(after.sensitivity, 1, 100) &&
      after.sensitivity !== before.sensitivity
    ) {
      cmdUpdates.sens = after.sensitivity;
    }
    if (
      isIntInRange(after.duration, 10, 600) &&
      after.duration !== before.duration
    ) {
      cmdUpdates.dur = after.duration;
    }
    if (
      isIntInRange(after.safety_off_min, 0, 1440) &&
      after.safety_off_min !== before.safety_off_min
    ) {
      cmdUpdates.safe = after.safety_off_min;
    }
    if (
      isIntInRange(after.lamp_wattage_w, 0, 5000) &&
      after.lamp_wattage_w !== before.lamp_wattage_w
    ) {
      cmdUpdates.wattage = after.lamp_wattage_w;
    }

    if (Object.keys(cmdUpdates).length > 0) {
      await rtdb.ref(`live/${deviceId}/cmd`).update(cmdUpdates);
    }
  }
);

export const onDeviceDeleted = onDocumentDeleted(
  {
    document: "devices/{deviceId}",
    database: "(default)",
    region: RTDB_REGION,
  },
  async (event) => {
    const deviceId = event.params.deviceId;
    const deleted = event.data?.data() ?? {};
    const espUid = typeof deleted.espUid === "string" ?
      deleted.espUid.trim() : "";

    await revokeAndDeleteDeviceAuthUsers([espUid, deviceId]);
    await removeDeviceRtdbNodes(deviceId);
  }
);

export const onEnergyDeltaUpdated = onValueUpdated(
  {
    ref: "/live/{deviceId}/state/energy_delta_sec",
    instance: RTDB_INSTANCE,
    region: RTDB_REGION,
  },
  async (event) => {
    const deviceId = event.params.deviceId;
    const delta = event.data.after.val();
    if (
      typeof delta !== "number" ||
      !Number.isFinite(delta) ||
      delta <= 0 ||
      delta > 86400
    ) {
      return;
    }

    await db.collection("devices").doc(deviceId).update({
      total_on_seconds: admin.firestore.FieldValue.increment(delta),
    });
    await event.data.after.ref.set(0);
  }
);

export const onDeviceWattageUpdated = onValueWritten(
  {
    ref: "/live/{deviceId}/state/wattage",
    instance: RTDB_INSTANCE,
    region: RTDB_REGION,
  },
  async (event) => {
    if (!event.data.after.exists()) {
      return;
    }
    const deviceId = event.params.deviceId;
    const wattage = event.data.after.val();
    if (!isIntInRange(wattage, 0, 5000)) {
      return;
    }

    const deviceRef = db.collection("devices").doc(deviceId);
    const deviceSnap = await deviceRef.get();
    if (!deviceSnap.exists) {
      return;
    }

    const current = deviceSnap.data()?.lamp_wattage_w;
    if (current === wattage) {
      return;
    }

    await deviceRef.update({
      lamp_wattage_w: wattage,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
);

export const onDeviceRestartAck = onValueWritten(
  {
    ref: "/live/{deviceId}/cmd/restart",
    instance: RTDB_INSTANCE,
    region: RTDB_REGION,
  },
  async (event) => {
    if (
      event.data.before.val() !== true ||
      event.data.after.val() !== false
    ) {
      return;
    }

    const deviceId = event.params.deviceId;
    const deviceRef = db.collection("devices").doc(deviceId);
    const deviceSnap = await deviceRef.get();
    if (!deviceSnap.exists) {
      return;
    }

    if (deviceSnap.data()?.restart_requested !== true) {
      return;
    }

    await deviceRef.update({
      restart_requested: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
);

export const onDeviceP1OffUpdated = onValueUpdated(
  {
    ref: "/live/{deviceId}/state/p1_off",
    instance: RTDB_INSTANCE,
    region: RTDB_REGION,
  },
  async (event) => {
    const deviceId = event.params.deviceId;
    if (event.data.after.val() !== true) {
      return;
    }

    await Promise.all([
      db.collection("devices").doc(deviceId).update({
        remote_lamp_on: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }),
      rtdb.ref(`live/${deviceId}/cmd/lamp`).set(false),
      rtdb.ref(`live/${deviceId}/state/p1_off`).set(false),
    ]);
  }
);
