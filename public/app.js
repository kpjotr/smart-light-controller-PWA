import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore,
  collection,
  doc,
  query,
  where,
  onSnapshot,
  addDoc,
  updateDoc,
  arrayRemove,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const PARAM_SPECS = [
  { key: 'lux_threshold', min: 0, max: 65535, fallback: 500 },
  { key: 'treshold', min: 0, max: 1000, fallback: 100 },
  { key: 'duration', min: 5, max: 7200, fallback: 60 },
  { key: 'cycle_len', min: 1, max: 60, fallback: 10 },
  { key: 'pir_sensitivity', min: 1, max: 255, fallback: 128 },
  { key: 'safety_off', min: 60, max: 28800, fallback: 3600 },
];

const WATTAGE_SPEC = { key: 'lamp_wattage', min: 1, max: 5000, fallback: 60 };

const els = {
  statusBanner: document.getElementById('status-banner'),
  userBar: document.getElementById('user-bar'),
  userEmail: document.getElementById('user-email'),
  signOutBtn: document.getElementById('sign-out-btn'),
  authSection: document.getElementById('auth-section'),
  authForm: document.getElementById('auth-form'),
  authEmail: document.getElementById('auth-email'),
  authPassword: document.getElementById('auth-password'),
  signInBtn: document.getElementById('sign-in-btn'),
  authError: document.getElementById('auth-error'),
  appSection: document.getElementById('app-section'),
  deviceSelect: document.getElementById('device-select'),
  deviceCountHint: document.getElementById('device-count-hint'),
  pairingForm: document.getElementById('pairing-form'),
  pairDeviceId: document.getElementById('pair-device-id'),
  pairPin: document.getElementById('pair-pin'),
  pairSubmitBtn: document.getElementById('pair-submit-btn'),
  pairingError: document.getElementById('pairing-error'),
  dashboardSection: document.getElementById('dashboard-section'),
  selectedDeviceId: document.getElementById('selected-device-id'),
  lampOnToggle: document.getElementById('lamp-on-toggle'),
  lampStateLabel: document.getElementById('lamp-state-label'),
  settingsForm: document.getElementById('settings-form'),
  loggingToggle: document.getElementById('logging-toggle'),
  wattageField: document.getElementById('wattage-field'),
  wattageNum: document.getElementById('lamp_wattage-num'),
  saveSettingsBtn: document.getElementById('save-settings-btn'),
  settingsError: document.getElementById('settings-error'),
  restartBtn: document.getElementById('restart-btn'),
  unpairBtn: document.getElementById('unpair-btn'),
};

let auth = null;
let db = null;
let currentUser = null;
let devicesUnsubscribe = null;
let selectedDeviceUnsubscribe = null;
let devicesById = new Map();
let selectedId = '';
let statusTimer = null;

function showBanner(message, type = 'info') {
  els.statusBanner.textContent = message;
  els.statusBanner.classList.remove('hidden', 'is-error', 'is-success');
  if (type === 'error') {
    els.statusBanner.classList.add('is-error');
  } else if (type === 'success') {
    els.statusBanner.classList.add('is-success');
  }
  if (statusTimer) {
    clearTimeout(statusTimer);
  }
  statusTimer = setTimeout(() => {
    els.statusBanner.classList.add('hidden');
  }, 5000);
}

function setFieldError(element, message) {
  if (!message) {
    element.textContent = '';
    element.classList.add('hidden');
    return;
  }
  element.textContent = message;
  element.classList.remove('hidden');
}

function setToggleState(buttonEl, isOn) {
  buttonEl.setAttribute('aria-checked', isOn ? 'true' : 'false');
}

function getToggleState(buttonEl) {
  return buttonEl.getAttribute('aria-checked') === 'true';
}

function updateLampUI(isOn) {
  setToggleState(els.lampOnToggle, isOn);
  els.lampStateLabel.textContent = isOn ? 'Lamp ON' : 'Lamp OFF';
}

function updateLoggingUI(enabled) {
  setToggleState(els.loggingToggle, enabled);
  if (enabled) {
    els.wattageField.classList.remove('hidden');
    els.wattageNum.required = true;
  } else {
    els.wattageField.classList.add('hidden');
    els.wattageNum.required = false;
  }
}

function bindSliderAndNumberSync() {
  for (const spec of PARAM_SPECS) {
    const rangeEl = document.getElementById(`${spec.key}-range`);
    const numEl = document.getElementById(`${spec.key}-num`);

    rangeEl.addEventListener('input', () => {
      numEl.value = rangeEl.value;
    });

    numEl.addEventListener('input', () => {
      const parsed = Number(numEl.value);
      if (Number.isFinite(parsed)) {
        const clamped = Math.min(spec.max, Math.max(spec.min, Math.round(parsed)));
        rangeEl.value = String(clamped);
      }
    });
  }
}

function renderDeviceSelector() {
  const previousId = selectedId;
  const options = [];

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '-- Select a device --';
  options.push(placeholder);

  const sortedIds = Array.from(devicesById.keys()).sort();
  for (const id of sortedIds) {
    const data = devicesById.get(id);
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = data.name ? `${data.name} (${id})` : id;
    options.push(opt);
  }

  els.deviceSelect.replaceChildren(...options);

  if (sortedIds.length === 0) {
    els.deviceCountHint.textContent = 'No paired devices found. Use Pair New Device to link one.';
  } else {
    els.deviceCountHint.textContent = `${sortedIds.length} paired device${sortedIds.length === 1 ? '' : 's'} available.`;
  }

  if (previousId && devicesById.has(previousId)) {
    selectedId = previousId;
    els.deviceSelect.value = previousId;
    if (!selectedDeviceUnsubscribe) {
      subscribeToSelectedDevice(previousId);
    }
  } else {
    clearSelectedDevice();
  }
}

function clearSelectedDevice() {
  if (selectedDeviceUnsubscribe) {
    selectedDeviceUnsubscribe();
    selectedDeviceUnsubscribe = null;
  }
  selectedId = '';
  els.deviceSelect.value = '';
  els.dashboardSection.classList.add('hidden');
}

function subscribeToSelectedDevice(deviceId) {
  if (selectedDeviceUnsubscribe) {
    selectedDeviceUnsubscribe();
    selectedDeviceUnsubscribe = null;
  }

  if (!deviceId) {
    els.dashboardSection.classList.add('hidden');
    return;
  }

  selectedDeviceUnsubscribe = onSnapshot(
    doc(db, 'devices', deviceId),
    (docSnap) => {
      if (!docSnap.exists()) {
        clearSelectedDevice();
        return;
      }
      const data = docSnap.data();
      devicesById.set(docSnap.id, data);
      renderDashboard(docSnap.id);
    },
    (error) => {
      showBanner(`Failed to sync device "${deviceId}": ${error.message}`, 'error');
    }
  );
}

function renderDashboard(deviceId) {
  const data = devicesById.get(deviceId);
  if (!data) {
    els.dashboardSection.classList.add('hidden');
    return;
  }

  els.selectedDeviceId.textContent = `Device ID: ${deviceId}`;
  updateLampUI(Boolean(data.lamp_on));

  for (const spec of PARAM_SPECS) {
    const rangeEl = document.getElementById(`${spec.key}-range`);
    const numEl = document.getElementById(`${spec.key}-num`);
    const rawVal = typeof data[spec.key] === 'number' ? data[spec.key] : spec.fallback;
    const clamped = Math.min(spec.max, Math.max(spec.min, Math.round(rawVal)));
    rangeEl.value = String(clamped);
    numEl.value = String(clamped);
  }

  const loggingEnabled = Boolean(data.logging_enabled);
  updateLoggingUI(loggingEnabled);
  const wattageVal = typeof data.lamp_wattage === 'number' ? data.lamp_wattage : WATTAGE_SPEC.fallback;
  els.wattageNum.value = String(Math.min(WATTAGE_SPEC.max, Math.max(WATTAGE_SPEC.min, Math.round(wattageVal))));

  setFieldError(els.settingsError, '');
  els.dashboardSection.classList.remove('hidden');
}

function subscribeToDevices() {
  if (devicesUnsubscribe) {
    devicesUnsubscribe();
    devicesUnsubscribe = null;
  }

  if (!auth?.currentUser) {
    console.warn('[DeviceSelector] subscribeToDevices aborted: auth.currentUser is null');
    return;
  }

  console.log('[DeviceSelector] Querying devices for uid:', auth.currentUser.uid);

  const devicesQuery = query(
    collection(db, 'devices'),
    where('allowedUsers', 'array-contains', auth.currentUser.uid)
  );

  devicesUnsubscribe = onSnapshot(
    devicesQuery,
    (querySnapshot) => {
      console.log('[DeviceSelector] querySnapshot.size:', querySnapshot.size);
      if (querySnapshot.empty) {
        console.warn('[DeviceSelector] querySnapshot.empty is true — no devices matched allowedUsers array-contains', auth.currentUser?.uid);
      }
      const selectEl = document.getElementById('device-select');
      console.log('[DeviceSelector] target #device-select element:', selectEl);

      devicesById = new Map();
      querySnapshot.forEach((docSnap) => {
        console.log('[DeviceSelector] Appending device doc.id:', docSnap.id);
        devicesById.set(docSnap.id, docSnap.data());
      });
      renderDeviceSelector();
    },
    (error) => {
      console.error('[DeviceSelector] onSnapshot error:', error);
      showBanner(`Failed to load devices: ${error.message}`, 'error');
    }
  );
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  setFieldError(els.authError, '');

  const email = els.authEmail.value.trim();
  const password = els.authPassword.value;

  if (!email || !password) {
    setFieldError(els.authError, 'Email and password are required.');
    return;
  }

  els.signInBtn.disabled = true;
  try {
    await signInWithEmailAndPassword(auth, email, password);
    els.authForm.reset();
  } catch (error) {
    setFieldError(els.authError, error.message);
  } finally {
    els.signInBtn.disabled = false;
  }
}

async function handlePairingSubmit(event) {
  event.preventDefault();
  setFieldError(els.pairingError, '');

  if (!currentUser) return;

  const deviceId = els.pairDeviceId.value.trim();
  const pin = els.pairPin.value.trim();

  if (!deviceId || deviceId.includes('/')) {
    setFieldError(els.pairingError, 'Enter a valid Device ID without "/" characters.');
    return;
  }
  if (!pin) {
    setFieldError(els.pairingError, 'Enter the pairing PIN.');
    return;
  }

  els.pairSubmitBtn.disabled = true;
  try {
    await addDoc(collection(db, 'devices', deviceId, 'pairing_requests'), {
      uid: currentUser.uid,
      pin,
      createdAt: serverTimestamp(),
    });
    els.pairingForm.reset();
    subscribeToDevices();
    showBanner(`Pairing request sent for "${deviceId}".`, 'success');
  } catch (error) {
    setFieldError(els.pairingError, error.message);
  } finally {
    els.pairSubmitBtn.disabled = false;
  }
}

async function handleLampToggle() {
  if (!selectedId) return;
  const nextState = !getToggleState(els.lampOnToggle);
  els.lampOnToggle.disabled = true;
  try {
    await updateDoc(doc(db, 'devices', selectedId), { lamp_on: nextState });
    updateLampUI(nextState);
    showBanner(`Lamp turned ${nextState ? 'ON' : 'OFF'}.`, 'success');
  } catch (error) {
    showBanner(`Failed to toggle lamp: ${error.message}`, 'error');
  } finally {
    els.lampOnToggle.disabled = false;
  }
}

async function handleLoggingToggle() {
  if (!selectedId) return;
  const nextState = !getToggleState(els.loggingToggle);
  updateLoggingUI(nextState);
  try {
    await updateDoc(doc(db, 'devices', selectedId), { logging_enabled: nextState });
    showBanner(`Power logging ${nextState ? 'enabled' : 'disabled'}.`, 'success');
  } catch (error) {
    updateLoggingUI(!nextState);
    showBanner(`Failed to update logging state: ${error.message}`, 'error');
  }
}

async function handleSettingsSubmit(event) {
  event.preventDefault();
  setFieldError(els.settingsError, '');
  if (!selectedId) return;

  const payload = {
    logging_enabled: getToggleState(els.loggingToggle),
  };

  for (const spec of PARAM_SPECS) {
    const numEl = document.getElementById(`${spec.key}-num`);
    const val = Number(numEl.value);
    if (!Number.isInteger(val) || val < spec.min || val > spec.max) {
      setFieldError(els.settingsError, `${spec.key} must be an integer between ${spec.min} and ${spec.max}.`);
      return;
    }
    payload[spec.key] = val;
  }

  if (payload.logging_enabled) {
    const wattage = Number(els.wattageNum.value);
    if (!Number.isInteger(wattage) || wattage < WATTAGE_SPEC.min || wattage > WATTAGE_SPEC.max) {
      setFieldError(
        els.settingsError,
        `lamp_wattage must be an integer between ${WATTAGE_SPEC.min} and ${WATTAGE_SPEC.max}.`
      );
      return;
    }
    payload.lamp_wattage = wattage;
  }

  els.saveSettingsBtn.disabled = true;
  try {
    await updateDoc(doc(db, 'devices', selectedId), payload);
    showBanner('Device settings saved.', 'success');
  } catch (error) {
    setFieldError(els.settingsError, error.message);
  } finally {
    els.saveSettingsBtn.disabled = false;
  }
}

async function handleRestart() {
  if (!selectedId) return;
  if (!window.confirm(`Restart device "${selectedId}" now?`)) return;

  els.restartBtn.disabled = true;
  try {
    await updateDoc(doc(db, 'devices', selectedId), { restart: true });
    showBanner(`Restart command sent to "${selectedId}".`, 'success');
  } catch (error) {
    showBanner(`Restart failed: ${error.message}`, 'error');
  } finally {
    els.restartBtn.disabled = false;
  }
}

async function handleUnpair() {
  if (!selectedId || !currentUser) return;
  if (!window.confirm(`Unpair "${selectedId}" from your account?`)) return;

  const targetId = selectedId;
  els.unpairBtn.disabled = true;
  try {
    await updateDoc(doc(db, 'devices', targetId), {
      allowedUsers: arrayRemove(currentUser.uid),
    });
    clearSelectedDevice();
    showBanner(`Unpaired from "${targetId}".`, 'success');
  } catch (error) {
    showBanner(`Unpair failed: ${error.message}`, 'error');
  } finally {
    els.unpairBtn.disabled = false;
  }
}

const firebaseConfig = {
  apiKey: "AIzaSyCymXk2RyRcQ3Rn5JSvJvJeQIMAxH0KyQU",
  authDomain: "okospilacsvezerlo.firebaseapp.com",
  projectId: "okospilacsvezerlo",
  storageBucket: "okospilacsvezerlo.firebasestorage.app",
  messagingSenderId: "934748179856",
  appId: "1:934748179856:web:d5271c07bff1e1f9fb7715"
};

function init() {
  bindSliderAndNumberSync();

  els.authForm.addEventListener('submit', handleAuthSubmit);
  els.signOutBtn.addEventListener('click', () => auth && signOut(auth));
  els.deviceSelect.addEventListener('change', () => {
    selectedId = els.deviceSelect.value;
    if (selectedId) {
      renderDashboard(selectedId);
      subscribeToSelectedDevice(selectedId);
    } else {
      clearSelectedDevice();
    }
  });
  els.pairingForm.addEventListener('submit', handlePairingSubmit);
  els.lampOnToggle.addEventListener('click', handleLampToggle);
  els.loggingToggle.addEventListener('click', handleLoggingToggle);
  els.settingsForm.addEventListener('submit', handleSettingsSubmit);
  els.restartBtn.addEventListener('click', handleRestart);
  els.unpairBtn.addEventListener('click', handleUnpair);

  try {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);

    onAuthStateChanged(auth, (user) => {
      currentUser = user;
      if (user) {
        els.authSection.classList.add('hidden');
        els.appSection.classList.remove('hidden');
        els.userBar.classList.remove('hidden');
        els.userEmail.textContent = user.email || user.uid;
        subscribeToDevices();
      } else {
        if (devicesUnsubscribe) {
          devicesUnsubscribe();
          devicesUnsubscribe = null;
        }
        clearSelectedDevice();
        devicesById.clear();
        els.userEmail.textContent = '';
        els.userBar.classList.add('hidden');
        els.appSection.classList.add('hidden');
        els.dashboardSection.classList.add('hidden');
        els.authSection.classList.remove('hidden');
      }
    });
  } catch (error) {
    showBanner(`Firebase initialization error: ${error.message}`, 'error');
  }
}

init();
