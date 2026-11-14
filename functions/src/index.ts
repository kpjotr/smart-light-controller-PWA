import {onRequest} from "firebase-functions/v2/https";
import * as admin from "firebase-admin";

admin.initializeApp();
const db = admin.firestore();

// 1. Védelmi réteg: Statikus Pre-Shared Key
// (később kiszervezhető Secret Managerbe)
const ESP_AUTH_TOKEN = "ESP32_SECRET_TOKEN_998877";

export const verifyPairing = onRequest(async (req, res) => {
  // Pre-Shared Key ellenőrzése
  if (req.header("X-Esp-Auth-Token") !== ESP_AUTH_TOKEN) {
    res.status(401).send("Unauthorized");
    return;
  }

  const {deviceId, pin, espUid} = req.body;
  if (!deviceId || !pin || !espUid) {
    res.status(400).send("Missing parameters");
    return;
  }

  const pairingRef = db.collection("pairing_requests").doc(deviceId);
  const pairingSnap = await pairingRef.get();

  if (!pairingSnap.exists) {
    res.status(404).send("No active pairing request");
    return;
  }

  const data = pairingSnap.data()!;

  // 3. Védelmi réteg: TTL (Időtúllépés) ellenőrzése
  if (data?.expiresAt && data.expiresAt.toDate() < new Date()) {
    await pairingRef.delete();
    res.status(400).send("Pairing request expired");
    return;
  }

  // 2. Védelmi réteg: 3-Strike (Brute-force) ellenőrzés
  const attempts = data?.attempts || 0;
  if (attempts >= 3) {
    await pairingRef.delete();
    res.status(403).send("Too many failed attempts. Pairing locked.");
    return;
  }

  // PIN kód ellenőrzése
  if (data?.pin !== pin) {
    await pairingRef.update({attempts: attempts + 1});
    res.status(401).send("Invalid PIN");
    return;
  }

  // SIKERES PÁROSÍTÁS: Hozzáadjuk a usert és az ESP-t a devices kollekcióhoz
  const deviceRef = db.collection("devices").doc(deviceId);
  await deviceRef.update({
    allowedUsers: admin.firestore.FieldValue.arrayUnion(data.userId, espUid),
  });

  // Takarítás: töröljük a kérést, hogy ne lehessen újra felhasználni
  await pairingRef.delete();

  res.status(200).send({success: true});
});
