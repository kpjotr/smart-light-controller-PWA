import {onRequest} from "firebase-functions/v2/https";
import * as admin from "firebase-admin";

admin.initializeApp();
const db = admin.firestore();

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
  await db.runTransaction(async (tx) => {
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

    if (!isIntInRange(existing.threshold, 1, 100)) {
      updatePayload.threshold = 50;
    }
    if (!isIntInRange(existing.sensitivity, 1, 100)) {
      updatePayload.sensitivity = 50;
    }
    if (!isIntInRange(existing.duration, 10, 600)) {
      updatePayload.duration = 60;
    }
    if (!isIntInRange(existing.safety_off_min, 0, 1440)) {
      updatePayload.safety_off_min = 0;
    }
    if (typeof existing.remote_lamp_on !== "boolean") {
      updatePayload.remote_lamp_on = false;
    }
    if (typeof existing.restart_requested !== "boolean") {
      updatePayload.restart_requested = false;
    }

    tx.set(deviceRef, updatePayload, {merge: true});
    tx.delete(pairingRef);
  });

  res.status(200).send({success: true});
});
