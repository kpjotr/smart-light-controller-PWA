import {onRequest} from "firebase-functions/v2/https";
import {
  onDocumentUpdated,
  onDocumentDeleted,
} from "firebase-functions/v2/firestore";
import {onValueUpdated} from "firebase-functions/v2/database";
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
const PASSKEY_REGEX = /^[A-Z0-9]{6,12}$/;
const CUSTOM_NAME_REGEX = /^[A-Za-z0-9 _-]{0,32}$/;

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

export const verifyPairing = onRequest(async (req, res) => {
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
  const rawPasskey = typeof body.pin === "string" ?
    body.pin :
    typeof body.passkey === "string" ?
      body.passkey :
      "";
  const normalizedPasskey = rawPasskey.trim().toUpperCase();

  if (!deviceId || deviceId.includes("/") || !normalizedPasskey || !espUid) {
    res.status(400).send("Missing parameters");
    return;
  }

  if (!PASSKEY_REGEX.test(normalizedPasskey)) {
    res.status(400).send("Invalid passkey format");
    return;
  }

  const pairingRef = db.collection("pairing_requests").doc(deviceId);
  const pairingSnap = await pairingRef.get();

  if (!pairingSnap.exists) {
    res.status(404).send("No active pairing request");
    return;
  }

  const data = pairingSnap.data();
  if (!data || typeof data.userId !== "string" || !data.userId) {
    res.status(400).send("Invalid pairing request");
    return;
  }

  // 3. Védelmi réteg: TTL (Időtúllépés) ellenőrzése
  if (data.expiresAt && data.expiresAt.toDate() < new Date()) {
    await pairingRef.delete();
    res.status(400).send("Pairing request expired");
    return;
  }

  // 2. Védelmi réteg: 3-Strike (Brute-force) ellenőrzés
  const attempts = typeof data.attempts === "number" ? data.attempts : 0;
  if (attempts >= 3) {
    await pairingRef.delete();
    res.status(403).send("Too many failed attempts. Pairing locked.");
    return;
  }

  // Gyári biztonsági kód (Passkey) ellenőrzése kis-/nagybetű-függetlenül
  const storedPin = typeof data.pin === "string" ?
    data.pin.trim().toUpperCase() :
    "";
  if (storedPin !== normalizedPasskey) {
    await pairingRef.update({attempts: attempts + 1});
    res.status(401).send("Invalid passkey");
    return;
  }

  const rawCustomName = typeof data.customName === "string" ?
    data.customName.trim() :
    "";
  if (!CUSTOM_NAME_REGEX.test(rawCustomName)) {
    res.status(400).send("Invalid custom name");
    return;
  }

  // SIKERES PÁROSÍTÁS: Létrehozzuk/frissítjük a devices/{deviceId} dokumentumot
  const deviceRef = db.collection("devices").doc(deviceId);
  const resolved = await db.runTransaction(async (tx) => {
    const deviceSnap = await tx.get(deviceRef);
    const existing = deviceSnap.exists ? (deviceSnap.data() ?? {}) : {};

    const existingCustomNames = existing.customNames;
    const customNames: Record<string, string> =
      existingCustomNames &&
      typeof existingCustomNames === "object" &&
      !Array.isArray(existingCustomNames) ?
        {...(existingCustomNames as Record<string, string>)} :
        {};

    if (rawCustomName.length > 0) {
      customNames[data.userId] = rawCustomName;
    } else {
      delete customNames[data.userId];
    }

    const updatePayload: Record<string, unknown> = {
      allowedUsers: admin.firestore.FieldValue.arrayUnion(data.userId, espUid),
      espUid,
      customNames,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const currentThr = isIntInRange(existing.threshold, 1, 100) ?
      existing.threshold : 50;
    if (!isIntInRange(existing.threshold, 1, 100)) {
      updatePayload.threshold = currentThr;
    }

    const currentSens = isIntInRange(existing.sensitivity, 1, 100) ?
      existing.sensitivity : 50;
    if (!isIntInRange(existing.sensitivity, 1, 100)) {
      updatePayload.sensitivity = currentSens;
    }

    const currentDur = isIntInRange(existing.duration, 10, 600) ?
      existing.duration : 60;
    if (!isIntInRange(existing.duration, 10, 600)) {
      updatePayload.duration = currentDur;
    }

    const currentSafe = isIntInRange(existing.safety_off_min, 0, 1440) ?
      existing.safety_off_min : 0;
    if (!isIntInRange(existing.safety_off_min, 0, 1440)) {
      updatePayload.safety_off_min = currentSafe;
    }

    const currentRemoteLampOn = typeof existing.remote_lamp_on === "boolean" ?
      existing.remote_lamp_on : false;
    if (typeof existing.remote_lamp_on !== "boolean") {
      updatePayload.remote_lamp_on = currentRemoteLampOn;
    }

    if (typeof existing.restart_requested !== "boolean") {
      updatePayload.restart_requested = false;
    }

    if (
      typeof existing.total_on_seconds !== "number" ||
      !Number.isFinite(existing.total_on_seconds)
    ) {
      updatePayload.total_on_seconds = 0;
    }

    tx.set(deviceRef, updatePayload, {merge: true});
    tx.delete(pairingRef);

    return {
      currentThr,
      currentSens,
      currentDur,
      currentSafe,
      currentRemoteLampOn,
    };
  });

  await Promise.all([
    rtdb.ref(`acl/${deviceId}`).update({
      [data.userId]: true,
      [espUid]: true,
    }),
    rtdb.ref(`live/${deviceId}`).set({
      cmd: {
        lamp: resolved.currentRemoteLampOn,
        restart: false,
        thr: resolved.currentThr,
        sens: resolved.currentSens,
        dur: resolved.currentDur,
        safe: resolved.currentSafe,
      },
      state: {
        on: false,
        auto: false,
        lux: 0,
        mot: false,
        ts: ServerValue.TIMESTAMP,
        energy_delta_sec: 0,
      },
    }),
  ]);

  const customToken = await getAuth().createCustomToken(espUid, {
    role: "device",
    deviceId,
  });

  res.status(200).json({ok: true, deviceId, customToken});
});

export const onDeviceUpdated = onDocumentUpdated(
  "devices/{deviceId}",
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
    const espUid = typeof after.espUid === "string" ?
      after.espUid.trim() : "";

    if (allowedChanged) {
      const humanUsers = afterAllowed.filter((uid) => uid !== espUid);
      if (humanUsers.length === 0) {
        if (espUid) {
          await safeRevokeRefreshTokens(espUid);
        }
        await removeDeviceRtdbNodes(deviceId);
        return;
      }

      const aclMap: Record<string, boolean> = {};
      for (const uid of afterAllowed) {
        aclMap[uid] = true;
      }
      await rtdb.ref(`acl/${deviceId}`).set(aclMap);
    }

    const cmdUpdates: Record<string, unknown> = {};
    if (
      typeof after.remote_lamp_on === "boolean" &&
      after.remote_lamp_on !== before.remote_lamp_on
    ) {
      cmdUpdates.lamp = after.remote_lamp_on;
    }
    if (
      typeof after.restart_requested === "boolean" &&
      after.restart_requested !== before.restart_requested
    ) {
      cmdUpdates.restart = after.restart_requested;
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

    if (Object.keys(cmdUpdates).length > 0) {
      await rtdb.ref(`live/${deviceId}/cmd`).update(cmdUpdates);
    }
  }
);

export const onDeviceDeleted = onDocumentDeleted(
  "devices/{deviceId}",
  async (event) => {
    const deviceId = event.params.deviceId;
    const deleted = event.data?.data() ?? {};
    const espUid = typeof deleted.espUid === "string" ?
      deleted.espUid.trim() : "";

    if (espUid) {
      await safeRevokeRefreshTokens(espUid);
    }
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
