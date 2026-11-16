import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  initializeFirestore,
  collection,
  doc,
  query,
  where,
  limit,
  onSnapshot,
  setDoc,
  updateDoc,
  arrayRemove,
  serverTimestamp,
  Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const PARAM_SPECS = [
  { key: 'threshold', label: 'Fény érzékenység', min: 1, max: 100, fallback: 50 },
  { key: 'sensitivity', label: 'Mozgás érzékenység', min: 1, max: 100, fallback: 50 },
  { key: 'duration', label: 'Késleltetés (mp)', min: 10, max: 600, fallback: 60 },
  { key: 'safety_off_min', label: 'Auto kikapcs (p)', min: 0, max: 1440, fallback: 0 },
];

const PASSKEY_REGEX = /^[A-Z0-9]{10}$/;
const LOADING_DELAY_MS = 250;
const PAIRING_TIMEOUT_MS = 60000;
const PAIRING_GRACE_MS = 1500;
const PAIRING_SUCCESS_DISPLAY_MS = 6500;
const ONLINE_THRESHOLD_MS = 90000;
const SVG_NS = 'http://www.w3.org/2000/svg';

const els = {
  helpBtn: document.getElementById('help-btn'),
  signOutBtn: document.getElementById('sign-out-btn'),
  userStatusBar: document.getElementById('user-status-bar'),
  userStatusEmail: document.getElementById('user-status-email'),
  authSection: document.getElementById('auth-section'),
  authForm: document.getElementById('auth-form'),
  authEmail: document.getElementById('auth-email'),
  authPassword: document.getElementById('auth-password'),
  signInBtn: document.getElementById('sign-in-btn'),
  authError: document.getElementById('auth-error'),
  pairingView: document.getElementById('pairing-view'),
  pairingForm: document.getElementById('pairing-form'),
  pairDeviceId: document.getElementById('pair-device-id'),
  pairPin: document.getElementById('pair-pin'),
  pairSubmitBtn: document.getElementById('pair-submit-btn'),
  backToDevicesBtn: document.getElementById('back-to-devices-btn'),
  pairingError: document.getElementById('pairing-error'),
  pairingSpinner: document.getElementById('pairing-spinner'),
  pairingFeedbackText: document.getElementById('pairing-feedback-text'),
  deviceListView: document.getElementById('device-list-view'),
  statusBanner: document.getElementById('status-banner'),
  deviceList: document.getElementById('device-list'),
  openPairingBtn: document.getElementById('open-pairing-btn'),
  settingsModal: document.getElementById('settings-modal'),
  settingsModalDeviceName: document.getElementById('settings-modal-device-name'),
  settingsModalStatusDot: document.getElementById('settings-modal-status-dot'),
  settingsModalStatusText: document.getElementById('settings-modal-status-text'),
  settingsModalClose: document.getElementById('settings-modal-close'),
  configForm: document.getElementById('config-form'),
  saveSettingsBtn: document.getElementById('save-settings-btn'),
  settingsError: document.getElementById('settings-error'),
  restartBtn: document.getElementById('restart-btn'),
  unpairBtn: document.getElementById('unpair-btn'),
  restartModal: document.getElementById('restart-modal'),
  restartModalDesc: document.getElementById('restart-modal-desc'),
  restartModalClose: document.getElementById('restart-modal-close'),
  restartCancelBtn: document.getElementById('restart-cancel-btn'),
  restartConfirmBtn: document.getElementById('restart-confirm-btn'),
  helpModal: document.getElementById('help-modal'),
  helpModalClose: document.getElementById('help-modal-close'),
};

let auth = null;
let db = null;
let currentUser = null;
let devicesUnsubscribe = null;
let devicesById = new Map();
const dirtyParams = new Set();
const togglingDeviceIds = new Set();

const uiState = {
  showPairingView: false,
  settingsDeviceId: null,
};

const pendingPairing = {
  deviceId: null,
  unsubscribeReq: null,
  timeoutId: null,
};
let pairingGraceTimer = null;
let pairingFeedbackTimer = null;
let statusTimer = null;
let settingsStatusTimer = null;
let isRestartSubmitting = false;
let pairSubmitDefaultText = '';

function isTextInputFocused() {
  const active = document.activeElement;
  if (!active || active.tagName !== 'INPUT') return false;
  const type = (active.getAttribute('type') || 'text').toLowerCase();
  return ['text', 'email', 'password', 'number', 'search', 'tel', 'url'].includes(type);
}

function syncAppHeight(force = false) {
  if (!force && isTextInputFocused()) return;
  const vh = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty('--app-h', `${Math.round(vh)}px`);
}

function showBanner(message, type = 'info', durationMs = 5000) {
  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }
  els.statusBanner.classList.remove('is-hidden', 'is-error', 'is-success');
  if (!message) {
    els.statusBanner.textContent = '\u00A0';
    els.statusBanner.classList.add('is-hidden');
    return;
  }
  els.statusBanner.textContent = message;
  if (type === 'error') {
    els.statusBanner.classList.add('is-error');
  } else if (type === 'success') {
    els.statusBanner.classList.add('is-success');
  }
  statusTimer = setTimeout(() => {
    statusTimer = null;
    els.statusBanner.classList.add('is-hidden');
    els.statusBanner.textContent = '\u00A0';
  }, durationMs);
}

function setFieldError(element, message) {
  if (!message) {
    element.textContent = '\u00A0';
    element.classList.add('is-hidden');
    return;
  }
  element.textContent = message;
  element.classList.remove('is-hidden');
}

function setSettingsStatus(type, message, autoClearMs = 0) {
  if (settingsStatusTimer) {
    clearTimeout(settingsStatusTimer);
    settingsStatusTimer = null;
  }
  els.settingsError.classList.remove('is-hidden', 'is-error', 'is-success');
  if (!message || type === 'hidden') {
    els.settingsError.textContent = '\u00A0';
    els.settingsError.classList.add('is-hidden');
    return;
  }
  els.settingsError.textContent = message;
  if (type === 'error') {
    els.settingsError.classList.add('is-error');
  } else if (type === 'success') {
    els.settingsError.classList.add('is-success');
  }
  if (autoClearMs > 0) {
    settingsStatusTimer = setTimeout(() => {
      settingsStatusTimer = null;
      setSettingsStatus('hidden', '');
    }, autoClearMs);
  }
}

function setPairingFeedback(type, message, autoHideMs = 0) {
  if (pairingFeedbackTimer) {
    clearTimeout(pairingFeedbackTimer);
    pairingFeedbackTimer = null;
  }

  els.pairingError.classList.remove('is-hidden', 'is-pending', 'is-success', 'is-error');
  els.pairingSpinner.classList.add('hidden');

  if (!message || type === 'hidden') {
    els.pairingFeedbackText.textContent = '\u00A0';
    els.pairingError.classList.add('is-hidden');
    els.pairingError.setAttribute('role', 'status');
    return;
  }

  els.pairingFeedbackText.textContent = message;
  if (type === 'pending') {
    els.pairingError.classList.add('is-pending');
    els.pairingError.setAttribute('role', 'status');
    els.pairingSpinner.classList.remove('hidden');
  } else if (type === 'success') {
    els.pairingError.classList.add('is-success');
    els.pairingError.setAttribute('role', 'status');
  } else {
    els.pairingError.classList.add('is-error');
    els.pairingError.setAttribute('role', 'alert');
  }

  if (autoHideMs > 0) {
    pairingFeedbackTimer = setTimeout(() => {
      pairingFeedbackTimer = null;
      setPairingFeedback('hidden', '');
    }, autoHideMs);
  }
}

function setPairingFormPending(isPending) {
  els.pairSubmitBtn.disabled = isPending;
  if (isPending) {
    els.pairSubmitBtn.setAttribute('aria-busy', 'true');
    els.pairSubmitBtn.textContent = 'Várakozás az eszközre...';
  } else {
    els.pairSubmitBtn.removeAttribute('aria-busy');
    els.pairSubmitBtn.textContent = pairSubmitDefaultText || 'Párosítás';
  }
}

function cleanupPendingPairing() {
  if (pendingPairing.unsubscribeReq) {
    pendingPairing.unsubscribeReq();
    pendingPairing.unsubscribeReq = null;
  }
  if (pendingPairing.timeoutId) {
    clearTimeout(pendingPairing.timeoutId);
    pendingPairing.timeoutId = null;
  }
  if (pairingGraceTimer) {
    clearTimeout(pairingGraceTimer);
    pairingGraceTimer = null;
  }
  pendingPairing.deviceId = null;
  setPairingFormPending(false);
}

async function runWithButtonLock(buttonEl, loadingText, asyncFn) {
  if (buttonEl.disabled) return;
  const originalText = buttonEl.textContent;
  buttonEl.disabled = true;
  buttonEl.setAttribute('aria-busy', 'true');
  const loadingTimer = setTimeout(() => {
    buttonEl.textContent = loadingText;
  }, LOADING_DELAY_MS);
  try {
    return await asyncFn();
  } finally {
    clearTimeout(loadingTimer);
    buttonEl.textContent = originalText;
    buttonEl.removeAttribute('aria-busy');
    buttonEl.disabled = false;
  }
}

function isDeviceOnline(device) {
  if (device?.online === true) return true;
  const lastSeen = device?.lastSeenAt;
  if (!lastSeen) return false;
  let ms = NaN;
  if (typeof lastSeen.toMillis === 'function') {
    ms = lastSeen.toMillis();
  } else if (typeof lastSeen === 'number') {
    ms = lastSeen;
  } else if (typeof lastSeen === 'string') {
    ms = Date.parse(lastSeen);
  }
  return Number.isFinite(ms) && (Date.now() - ms) <= ONLINE_THRESHOLD_MS;
}

function createSvgElement(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, val] of Object.entries(attrs)) {
    el.setAttribute(key, String(val));
  }
  return el;
}

function createBulbIconSvg() {
  const svg = createSvgElement('svg', {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  });
  svg.appendChild(createSvgElement('path', {
    d: 'M9 18h6',
  }));
  svg.appendChild(createSvgElement('path', {
    d: 'M10 22h4',
  }));
  svg.appendChild(createSvgElement('path', {
    d: 'M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14',
  }));
  return svg;
}

function createGearIconSvg() {
  const svg = createSvgElement('svg', {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  });
  svg.appendChild(createSvgElement('circle', { cx: '12', cy: '12', r: '3' }));
  svg.appendChild(createSvgElement('path', {
    d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  }));
  return svg;
}

function renderDeviceList() {
  const sortedIds = Array.from(devicesById.keys()).sort();
  const rows = [];

  for (const deviceId of sortedIds) {
    const device = devicesById.get(deviceId) || {};
    const displayName = device.name || deviceId;
    const online = isDeviceOnline(device);
    const isLampOn = device.remote_lamp_on === true;

    const row = document.createElement('div');
    row.className = 'device-row';
    row.setAttribute('role', 'listitem');

    const info = document.createElement('div');
    info.className = 'device-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'device-name';
    nameEl.textContent = displayName;

    const statusEl = document.createElement('div');
    statusEl.className = 'device-status';

    const dot = document.createElement('span');
    dot.className = `status-dot ${online ? 'is-online' : 'is-offline'}`;
    dot.setAttribute('aria-hidden', 'true');

    const statusText = document.createElement('span');
    statusText.textContent = online ? 'Online' : 'Offline';

    statusEl.append(dot, statusText);
    info.append(nameEl, statusEl);

    const actions = document.createElement('div');
    actions.className = 'device-actions';

    const lampBtn = document.createElement('button');
    lampBtn.type = 'button';
    lampBtn.className = `icon-btn lamp-btn${isLampOn ? ' is-on' : ''}`;
    lampBtn.setAttribute('aria-pressed', isLampOn ? 'true' : 'false');
    lampBtn.title = isLampOn ? 'Lámpa: BE' : 'Lámpa: KI';
    lampBtn.setAttribute('aria-label', `${displayName} – ${isLampOn ? 'Lámpa: BE' : 'Lámpa: KI'}`);
    lampBtn.disabled = togglingDeviceIds.has(deviceId);
    lampBtn.appendChild(createBulbIconSvg());
    lampBtn.addEventListener('click', () => handleRowLampToggle(deviceId, lampBtn));

    const gearBtn = document.createElement('button');
    gearBtn.type = 'button';
    gearBtn.className = 'icon-btn gear-btn';
    gearBtn.title = 'Beállítások';
    gearBtn.setAttribute('aria-label', `${displayName} – Beállítások`);
    gearBtn.appendChild(createGearIconSvg());
    gearBtn.addEventListener('click', () => openSettingsModal(deviceId));

    actions.append(lampBtn, gearBtn);
    row.append(info, actions);
    rows.push(row);
  }

  els.deviceList.replaceChildren(...rows);
}

function renderCurrentView() {
  if (!currentUser) {
    // State 1: Login View
    els.signOutBtn.classList.add('hidden');
    els.userStatusBar.classList.add('hidden');
    els.userStatusEmail.textContent = '';
    els.authSection.classList.remove('hidden');
    els.pairingView.classList.add('hidden');
    els.deviceListView.classList.add('hidden');
    closeSettingsModal();
    closeRestartModal();
    return;
  }

  // Logged in: Kilépés and signed-in email are ALWAYS visible on Pairing and Device List views
  els.signOutBtn.classList.remove('hidden');
  els.userStatusBar.classList.remove('hidden');
  els.userStatusEmail.textContent = `Bejelentkezve: ${currentUser.email || ''}`;
  els.authSection.classList.add('hidden');

  const hasDevices = devicesById.size > 0;
  if (!hasDevices || uiState.showPairingView) {
    // State 2: Pairing View
    els.pairingView.classList.remove('hidden');
    els.deviceListView.classList.add('hidden');
    els.backToDevicesBtn.classList.toggle('hidden', !hasDevices);
  } else {
    // State 3: Device List View
    els.pairingView.classList.add('hidden');
    els.deviceListView.classList.remove('hidden');
    renderDeviceList();
  }
}

function populateSettingsModal(deviceId, forcePopulate = false) {
  const data = devicesById.get(deviceId);
  if (!data) {
    closeSettingsModal();
    return;
  }

  els.settingsModalDeviceName.textContent = data.name || deviceId;

  const online = isDeviceOnline(data);
  els.settingsModalStatusDot.className = `status-dot ${online ? 'is-online' : 'is-offline'}`;
  els.settingsModalStatusText.textContent = online ? 'Online' : 'Offline';

  const isRestarting = data.restart_requested === true;
  els.restartBtn.disabled = isRestarting;
  els.restartBtn.textContent = isRestarting ? 'Újraindítás...' : 'Újraindítás';

  for (const spec of PARAM_SPECS) {
    const numEl = document.getElementById(`${spec.key}-num`);
    const isFocused = document.activeElement === numEl;
    if (!forcePopulate && (isFocused || dirtyParams.has(spec.key))) {
      continue;
    }
    const rawVal = typeof data[spec.key] === 'number' && Number.isFinite(data[spec.key])
      ? data[spec.key]
      : spec.fallback;
    const clamped = Math.min(spec.max, Math.max(spec.min, Math.round(rawVal)));
    numEl.value = String(clamped);
  }
}

function openDialogElement(dialogEl) {
  if (typeof dialogEl.showModal === 'function') {
    if (!dialogEl.open) {
      dialogEl.showModal();
    }
  } else {
    dialogEl.setAttribute('open', '');
  }
}

function closeDialogElement(dialogEl) {
  if (typeof dialogEl.close === 'function') {
    if (dialogEl.open) {
      dialogEl.close();
    }
  } else {
    dialogEl.removeAttribute('open');
  }
}

function openSettingsModal(deviceId) {
  if (!deviceId || !devicesById.has(deviceId)) return;
  uiState.settingsDeviceId = deviceId;
  dirtyParams.clear();
  setSettingsStatus('hidden', '');
  populateSettingsModal(deviceId, true);
  openDialogElement(els.settingsModal);
}

function closeSettingsModal() {
  uiState.settingsDeviceId = null;
  dirtyParams.clear();
  setSettingsStatus('hidden', '');
  closeDialogElement(els.settingsModal);
}

function openRestartModal() {
  const deviceId = uiState.settingsDeviceId;
  if (!deviceId || els.restartBtn.disabled) return;
  const displayName = devicesById.get(deviceId)?.name || deviceId;
  els.restartModalDesc.textContent =
    `Biztosan újra szeretnéd indítani a(z) "${displayName}" ESP32 vezérlőt? Az újraindítás alatt az eszköz átmenetileg nem lesz elérhető.`;
  openDialogElement(els.restartModal);
  els.restartCancelBtn.focus();
}

function closeRestartModal() {
  closeDialogElement(els.restartModal);
}

function openHelpModal() {
  openDialogElement(els.helpModal);
  els.helpModalClose.focus();
}

function closeHelpModal() {
  closeDialogElement(els.helpModal);
}

function completePairingSuccess(deviceId) {
  cleanupPendingPairing();
  els.pairingForm.reset();
  uiState.showPairingView = false;
  renderCurrentView();
  const successMsg = `Sikeres párosítás! A(z) ${deviceId} eszköz csatlakoztatva.`;
  setPairingFeedback('hidden', '');
  showBanner(successMsg, 'success', PAIRING_SUCCESS_DISPLAY_MS);
}

function subscribeToDevices() {
  if (devicesUnsubscribe) {
    devicesUnsubscribe();
    devicesUnsubscribe = null;
  }

  if (!auth?.currentUser) {
    return;
  }

  const devicesQuery = query(
    collection(db, 'devices'),
    where('allowedUsers', 'array-contains', auth.currentUser.uid),
    limit(50)
  );

  devicesUnsubscribe = onSnapshot(
    devicesQuery,
    (querySnapshot) => {
      devicesById = new Map();
      querySnapshot.forEach((docSnap) => {
        devicesById.set(docSnap.id, docSnap.data());
      });

      if (pendingPairing.deviceId && devicesById.has(pendingPairing.deviceId)) {
        completePairingSuccess(pendingPairing.deviceId);
      } else {
        renderCurrentView();
      }

      if (uiState.settingsDeviceId) {
        if (devicesById.has(uiState.settingsDeviceId)) {
          populateSettingsModal(uiState.settingsDeviceId, false);
        } else {
          closeRestartModal();
          closeSettingsModal();
        }
      }
    },
    (error) => {
      showBanner(`Nem sikerült betölteni az eszközöket: ${error.message}`, 'error');
    }
  );
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  setFieldError(els.authError, '');

  const email = els.authEmail.value.trim();
  const password = els.authPassword.value;

  if (!email || !password) {
    setFieldError(els.authError, 'Az e-mail cím és a jelszó megadása kötelező.');
    return;
  }

  await runWithButtonLock(els.signInBtn, 'Bejelentkezés...', async () => {
    try {
      await signInWithEmailAndPassword(auth, email, password);
      els.authForm.reset();
    } catch (error) {
      setFieldError(els.authError, error.message);
    }
  });
}

async function handlePairingSubmit(event) {
  event.preventDefault();
  setPairingFeedback('hidden', '');

  if (!currentUser || !auth?.currentUser) return;

  const deviceId = els.pairDeviceId.value.trim();
  const pin = els.pairPin.value.trim().toUpperCase();
  els.pairPin.value = pin;

  if (!deviceId || deviceId.includes('/')) {
    setPairingFeedback('error', 'Adj meg egy érvényes eszköz azonosítót "/" karakter nélkül.');
    return;
  }
  if (!PASSKEY_REGEX.test(pin)) {
    setPairingFeedback(
      'error',
      'A gyári biztonsági kódnak (Passkey) pontosan 10 karakteres alfanumerikus kódnak (A–Z, 0–9) kell lennie.'
    );
    return;
  }

  cleanupPendingPairing();
  els.pairSubmitBtn.disabled = true;
  els.pairSubmitBtn.setAttribute('aria-busy', 'true');
  const sendTimer = setTimeout(() => {
    els.pairSubmitBtn.textContent = 'Küldés...';
  }, LOADING_DELAY_MS);

  try {
    await setDoc(doc(db, 'pairing_requests', deviceId), {
      pin,
      userId: auth.currentUser.uid,
      attempts: 0,
      expiresAt: Timestamp.fromDate(new Date(Date.now() + 5 * 60 * 1000)),
    });
    clearTimeout(sendTimer);

    pendingPairing.deviceId = deviceId;
    setPairingFormPending(true);
    setPairingFeedback('pending', `Párosítás folyamatban: várakozás a(z) ${deviceId} válaszára...`);

    pendingPairing.timeoutId = setTimeout(() => {
      if (pendingPairing.deviceId !== deviceId) return;
      cleanupPendingPairing();
      setPairingFeedback(
        'error',
        'A párosítási kérelem időtúllépés miatt megszakadt (60 mp). Ellenőrizd az eszközt és próbáld újra.'
      );
    }, PAIRING_TIMEOUT_MS);

    pendingPairing.unsubscribeReq = onSnapshot(
      doc(db, 'pairing_requests', deviceId),
      (snap) => {
        if (pendingPairing.deviceId !== deviceId) return;

        if (snap.exists()) {
          const reqData = snap.data() || {};
          if (typeof reqData.attempts === 'number' && reqData.attempts > 0) {
            cleanupPendingPairing();
            setPairingFeedback(
              'error',
              `Sikertelen párosítás: az eszköz elutasította a megadott Passkey kódot (${reqData.attempts}/3 próbálkozás).`
            );
          }
          return;
        }

        if (devicesById.has(deviceId)) {
          completePairingSuccess(deviceId);
          return;
        }

        if (!pairingGraceTimer) {
          pairingGraceTimer = setTimeout(() => {
            pairingGraceTimer = null;
            if (pendingPairing.deviceId !== deviceId) return;
            if (devicesById.has(deviceId)) {
              completePairingSuccess(deviceId);
            } else {
              cleanupPendingPairing();
              setPairingFeedback('error', 'A párosítási kérelem lejárt vagy megszakadt.');
            }
          }, PAIRING_GRACE_MS);
        }
      },
      (error) => {
        if (pendingPairing.deviceId !== deviceId) return;
        cleanupPendingPairing();
        setPairingFeedback('error', error.message);
      }
    );
  } catch (error) {
    clearTimeout(sendTimer);
    cleanupPendingPairing();
    setPairingFeedback('error', error.message);
  }
}

async function handleRowLampToggle(deviceId, buttonEl) {
  if (!deviceId || togglingDeviceIds.has(deviceId)) return;
  const device = devicesById.get(deviceId);
  if (!device) return;

  const previousState = device.remote_lamp_on === true;
  const nextState = !previousState;
  togglingDeviceIds.add(deviceId);
  buttonEl.disabled = true;
  buttonEl.setAttribute('aria-busy', 'true');

  try {
    await updateDoc(doc(db, 'devices', deviceId), {
      remote_lamp_on: nextState,
      updatedAt: serverTimestamp(),
    });
    const label = device.name || deviceId;
    showBanner(
      nextState
        ? `${label}: Lámpa BE (P2 manuális mód).`
        : `${label}: Lámpa KI (P3 automata mód).`,
      'success'
    );
  } catch (error) {
    showBanner(`Nem sikerült átkapcsolni a lámpát: ${error.message}`, 'error');
  } finally {
    togglingDeviceIds.delete(deviceId);
    buttonEl.removeAttribute('aria-busy');
    buttonEl.disabled = false;
  }
}

async function handleSettingsSubmit(event) {
  event.preventDefault();
  setSettingsStatus('hidden', '');
  const deviceId = uiState.settingsDeviceId;
  if (!deviceId) return;

  const payload = {
    updatedAt: serverTimestamp(),
  };

  for (const spec of PARAM_SPECS) {
    const numEl = document.getElementById(`${spec.key}-num`);
    const rawStr = numEl.value.trim();
    const val = Number(rawStr);
    if (rawStr === '' || !Number.isInteger(val) || val < spec.min || val > spec.max) {
      setSettingsStatus(
        'error',
        `${spec.label}: ${spec.min}–${spec.max} közötti egész szám szükséges.`
      );
      return;
    }
    payload[spec.key] = val;
  }

  await runWithButtonLock(els.saveSettingsBtn, 'Mentés...', async () => {
    try {
      await updateDoc(doc(db, 'devices', deviceId), payload);
      dirtyParams.clear();
      setSettingsStatus('success', 'Beállítások elmentve.', 4000);
    } catch (error) {
      setSettingsStatus('error', error.message);
    }
  });
}

async function handleRestartConfirm() {
  const deviceId = uiState.settingsDeviceId;
  if (!deviceId || isRestartSubmitting) return;
  isRestartSubmitting = true;
  els.restartCancelBtn.disabled = true;
  els.restartModalClose.disabled = true;

  await runWithButtonLock(els.restartConfirmBtn, 'Küldés...', async () => {
    try {
      await updateDoc(doc(db, 'devices', deviceId), {
        restart_requested: true,
        updatedAt: serverTimestamp(),
      });
      els.restartBtn.disabled = true;
      els.restartBtn.textContent = 'Újraindítás...';
      closeRestartModal();
      setSettingsStatus('success', 'Újraindítási kérelem elküldve.', 5000);
      showBanner(`Újraindítási kérelem elküldve: ${deviceId}.`, 'success');
    } catch (error) {
      setSettingsStatus('error', `Az újraindítás sikertelen: ${error.message}`);
      showBanner(`Az újraindítás sikertelen: ${error.message}`, 'error');
    } finally {
      isRestartSubmitting = false;
      els.restartCancelBtn.disabled = false;
      els.restartModalClose.disabled = false;
    }
  });
}

async function handleUnpair() {
  const deviceId = uiState.settingsDeviceId;
  if (!deviceId || !currentUser) return;
  const displayName = devicesById.get(deviceId)?.name || deviceId;
  if (!window.confirm(`Biztosan leválasztod a(z) "${displayName}" eszközt a fiókodról?`)) return;

  await runWithButtonLock(els.unpairBtn, 'Leválasztás...', async () => {
    try {
      await updateDoc(doc(db, 'devices', deviceId), {
        allowedUsers: arrayRemove(currentUser.uid),
      });
      closeSettingsModal();
      showBanner(`A(z) "${displayName}" eszköz leválasztva.`, 'success');
    } catch (error) {
      setSettingsStatus('error', `A leválasztás sikertelen: ${error.message}`);
    }
  });
}

const firebaseConfig = {
  apiKey: "AIzaSyCymXk2RyRcQ3Rn5JSvJvJeQIMAxH0KyQU",
  authDomain: "okospilacsvezerlo.firebaseapp.com",
  projectId: "okospilacsvezerlo",
  storageBucket: "okospilacsvezerlo.firebasestorage.app",
  messagingSenderId: "934748179856",
  appId: "1:934748179856:web:d5271c07bff1e1f9fb7715"
};

function bindModalEvents() {
  els.settingsModalClose.addEventListener('click', closeSettingsModal);
  els.settingsModal.addEventListener('close', () => {
    uiState.settingsDeviceId = null;
    dirtyParams.clear();
  });
  els.settingsModal.addEventListener('click', (event) => {
    if (event.target === els.settingsModal) {
      closeSettingsModal();
    }
  });

  els.restartBtn.addEventListener('click', openRestartModal);
  els.restartModalClose.addEventListener('click', closeRestartModal);
  els.restartCancelBtn.addEventListener('click', closeRestartModal);
  els.restartConfirmBtn.addEventListener('click', handleRestartConfirm);
  els.restartModal.addEventListener('cancel', (event) => {
    if (isRestartSubmitting) {
      event.preventDefault();
    }
  });
  els.restartModal.addEventListener('click', (event) => {
    if (event.target === els.restartModal && !isRestartSubmitting) {
      closeRestartModal();
    }
  });

  els.helpBtn.addEventListener('click', openHelpModal);
  els.helpModalClose.addEventListener('click', closeHelpModal);
  els.helpModal.addEventListener('click', (event) => {
    if (event.target === els.helpModal) {
      closeHelpModal();
    }
  });
}

function init() {
  syncAppHeight(true);
  window.addEventListener('load', () => syncAppHeight(true));
  window.addEventListener('resize', () => syncAppHeight(false));
  window.addEventListener('orientationchange', () => {
    syncAppHeight(true);
    setTimeout(() => syncAppHeight(true), 150);
  });
  window.visualViewport?.addEventListener('resize', () => syncAppHeight(false));
  document.addEventListener('focusout', () => setTimeout(() => syncAppHeight(false), 120));

  pairSubmitDefaultText = els.pairSubmitBtn.textContent;
  setFieldError(els.authError, '');
  setPairingFeedback('hidden', '');
  setSettingsStatus('hidden', '');
  showBanner('', 'info');

  for (const spec of PARAM_SPECS) {
    const numEl = document.getElementById(`${spec.key}-num`);
    numEl.addEventListener('input', () => {
      dirtyParams.add(spec.key);
    });
  }

  els.pairPin.addEventListener('input', () => {
    const start = els.pairPin.selectionStart;
    const end = els.pairPin.selectionEnd;
    const upper = els.pairPin.value.toUpperCase();
    if (els.pairPin.value !== upper) {
      els.pairPin.value = upper;
      if (start !== null && end !== null) {
        els.pairPin.setSelectionRange(start, end);
      }
    }
  });

  els.authForm.addEventListener('submit', handleAuthSubmit);
  els.signOutBtn.addEventListener('click', () => auth && signOut(auth));

  els.pairingForm.addEventListener('submit', handlePairingSubmit);
  els.backToDevicesBtn.addEventListener('click', () => {
    cleanupPendingPairing();
    setPairingFeedback('hidden', '');
    uiState.showPairingView = false;
    renderCurrentView();
  });
  els.openPairingBtn.addEventListener('click', () => {
    setPairingFeedback('hidden', '');
    uiState.showPairingView = true;
    renderCurrentView();
  });

  els.configForm.addEventListener('submit', handleSettingsSubmit);
  els.unpairBtn.addEventListener('click', handleUnpair);
  bindModalEvents();

  renderCurrentView();

  try {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = initializeFirestore(app, { experimentalForceLongPolling: true });

    onAuthStateChanged(auth, (user) => {
      currentUser = user;
      if (user) {
        uiState.showPairingView = false;
        renderCurrentView();
        subscribeToDevices();
      } else {
        cleanupPendingPairing();
        setPairingFeedback('hidden', '');
        if (devicesUnsubscribe) {
          devicesUnsubscribe();
          devicesUnsubscribe = null;
        }
        devicesById.clear();
        togglingDeviceIds.clear();
        uiState.showPairingView = false;
        renderCurrentView();
      }
    });
  } catch (error) {
    showBanner(`Firebase inicializálási hiba: ${error.message}`, 'error');
  }
}

init();
