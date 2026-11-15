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
  { key: 'safety_off_min', label: 'Auto kikapcs (perc)', min: 0, max: 1440, fallback: 0 },
];

const PASSKEY_REGEX = /^[A-Z0-9]{10}$/;
const LOADING_DELAY_MS = 250;

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
  lampPriorityInfo: document.getElementById('lamp-priority-info'),
  settingsForm: document.getElementById('settings-form'),
  saveSettingsBtn: document.getElementById('save-settings-btn'),
  settingsError: document.getElementById('settings-error'),
  restartStatusWrap: document.getElementById('restart-status-wrap'),
  restartStatusBadge: document.getElementById('restart-status-badge'),
  restartBtn: document.getElementById('restart-btn'),
  unpairBtn: document.getElementById('unpair-btn'),
  restartModal: document.getElementById('restart-modal'),
  restartModalCard: document.getElementById('restart-modal-card'),
  restartModalHeader: document.getElementById('restart-modal-header'),
  restartModalDesc: document.getElementById('restart-modal-desc'),
  restartModalClose: document.getElementById('restart-modal-close'),
  restartCancelBtn: document.getElementById('restart-cancel-btn'),
  restartConfirmBtn: document.getElementById('restart-confirm-btn'),
};

let auth = null;
let db = null;
let currentUser = null;
let devicesUnsubscribe = null;
let selectedDeviceUnsubscribe = null;
let devicesById = new Map();
let dirtyParams = new Set();
let selectedId = '';
let statusTimer = null;
let isRestartSubmitting = false;

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
    element.textContent = '\u00A0';
    element.style.visibility = 'hidden';
    return;
  }
  element.textContent = message;
  element.style.visibility = 'visible';
}

function setToggleState(buttonEl, isOn) {
  buttonEl.setAttribute('aria-checked', isOn ? 'true' : 'false');
}

function getToggleState(buttonEl) {
  return buttonEl.getAttribute('aria-checked') === 'true';
}

function updateLampUI(isOn) {
  setToggleState(els.lampOnToggle, isOn);
  els.lampStateLabel.textContent = isOn ? 'Lámpa: BE' : 'Lámpa: KI';
}

function updateRestartUI(isRestarting) {
  els.restartBtn.disabled = isRestarting;
  els.restartStatusBadge.style.visibility = isRestarting ? 'visible' : 'hidden';
  els.restartStatusBadge.setAttribute('aria-hidden', isRestarting ? 'false' : 'true');
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

function bindSliderAndNumberSync() {
  for (const spec of PARAM_SPECS) {
    const rangeEl = document.getElementById(`${spec.key}-range`);
    const numEl = document.getElementById(`${spec.key}-num`);

    rangeEl.addEventListener('input', () => {
      dirtyParams.add(spec.key);
      numEl.value = rangeEl.value;
    });

    numEl.addEventListener('input', () => {
      dirtyParams.add(spec.key);
      const trimmed = numEl.value.trim();
      if (trimmed === '') return;
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) {
        const clamped = Math.min(spec.max, Math.max(spec.min, Math.round(parsed)));
        rangeEl.value = String(clamped);
      }
    });
  }
}

function applyUiErgonomics() {
  const interactiveControls = document.querySelectorAll('button, input, select, .btn, .toggle-btn');
  interactiveControls.forEach((control) => {
    control.style.touchAction = 'manipulation';
    control.style.webkitTapHighlightColor = 'transparent';
  });

  [els.authError, els.pairingError, els.settingsError].forEach((errEl) => {
    errEl.style.minHeight = '22px';
    setFieldError(errEl, '');
  });

  els.lampPriorityInfo.style.marginTop = '0';
  els.lampPriorityInfo.style.marginBottom = '16px';

  els.restartStatusWrap.style.minHeight = '32px';
  els.restartStatusWrap.style.marginBottom = '12px';
  els.restartStatusWrap.style.display = 'flex';
  els.restartStatusWrap.style.alignItems = 'center';

  els.restartStatusBadge.style.borderColor = 'var(--warning)';
  els.restartStatusBadge.style.color = 'var(--warning)';
  updateRestartUI(false);

  els.restartModal.style.background = 'transparent';
  els.restartModal.style.border = 'none';
  els.restartModal.style.padding = '0';
  els.restartModal.style.maxWidth = '440px';
  els.restartModal.style.width = 'calc(100% - 32px)';
  els.restartModal.style.margin = 'auto';
  els.restartModal.style.color = 'var(--text)';

  els.restartModalCard.style.marginBottom = '0';
  els.restartModalCard.style.boxShadow = '0 20px 50px rgba(0, 0, 0, 0.55)';

  els.restartModalHeader.style.marginBottom = '12px';
  els.restartModalHeader.style.paddingBottom = '10px';
  els.restartModalClose.style.minHeight = '44px';
  els.restartModalClose.style.minWidth = '44px';
  els.restartModalClose.style.padding = '8px 12px';
}

function renderDeviceSelector() {
  const previousId = selectedId;
  const options = [];

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '-- Válassz eszközt --';
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
    els.deviceCountHint.textContent = 'Nincs párosított eszköz. Párosíts egy újat a fenti űrlapon.';
  } else {
    els.deviceCountHint.textContent = `${sortedIds.length} párosított eszköz érhető el.`;
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
  dirtyParams.clear();
  els.deviceSelect.value = '';
  els.dashboardSection.classList.add('hidden');
  closeRestartModal();
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
      renderDashboard(docSnap.id, false);
    },
    (error) => {
      showBanner(`Nem sikerült szinkronizálni a(z) "${deviceId}" eszközt: ${error.message}`, 'error');
    }
  );
}

function renderDashboard(deviceId, forcePopulate = false) {
  const data = devicesById.get(deviceId);
  if (!data) {
    els.dashboardSection.classList.add('hidden');
    return;
  }

  els.selectedDeviceId.textContent = `Eszköz azonosító: ${deviceId}`;
  updateLampUI(data.remote_lamp_on === true);
  updateRestartUI(data.restart_requested === true);

  for (const spec of PARAM_SPECS) {
    const rangeEl = document.getElementById(`${spec.key}-range`);
    const numEl = document.getElementById(`${spec.key}-num`);
    const isFocused = document.activeElement === rangeEl || document.activeElement === numEl;
    if (!forcePopulate && (isFocused || dirtyParams.has(spec.key))) {
      continue;
    }

    const rawVal = typeof data[spec.key] === 'number' && Number.isFinite(data[spec.key])
      ? data[spec.key]
      : spec.fallback;
    const clamped = Math.min(spec.max, Math.max(spec.min, Math.round(rawVal)));
    rangeEl.value = String(clamped);
    numEl.value = String(clamped);
  }

  setFieldError(els.settingsError, '');
  els.dashboardSection.classList.remove('hidden');
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
      renderDeviceSelector();
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
  setFieldError(els.pairingError, '');

  if (!currentUser || !auth?.currentUser) return;

  const deviceId = els.pairDeviceId.value.trim();
  const pin = els.pairPin.value.trim().toUpperCase();
  els.pairPin.value = pin;

  if (!deviceId || deviceId.includes('/')) {
    setFieldError(els.pairingError, 'Adj meg egy érvényes eszköz azonosítót "/" karakter nélkül.');
    return;
  }
  if (!PASSKEY_REGEX.test(pin)) {
    setFieldError(
      els.pairingError,
      'A gyári biztonsági kódnak (Passkey) pontosan 10 karakteres alfanumerikus kódnak (A–Z, 0–9) kell lennie.'
    );
    return;
  }

  await runWithButtonLock(els.pairSubmitBtn, 'Küldés...', async () => {
    try {
      await setDoc(doc(db, 'pairing_requests', deviceId), {
        pin,
        userId: auth.currentUser.uid,
        attempts: 0,
        expiresAt: Timestamp.fromDate(new Date(Date.now() + 5 * 60 * 1000)),
      });
      els.pairingForm.reset();
      subscribeToDevices();
      showBanner(`Párosítási kérelem elküldve a(z) "${deviceId}" eszközhöz.`, 'success');
    } catch (error) {
      setFieldError(els.pairingError, error.message);
    }
  });
}

async function handleLampToggle() {
  if (!selectedId || els.lampOnToggle.disabled) return;
  const previousState = getToggleState(els.lampOnToggle);
  const nextState = !previousState;

  els.lampOnToggle.disabled = true;
  els.lampOnToggle.setAttribute('aria-busy', 'true');
  const loadingTimer = setTimeout(() => {
    els.lampStateLabel.textContent = 'Frissítés...';
  }, LOADING_DELAY_MS);

  try {
    await updateDoc(doc(db, 'devices', selectedId), {
      remote_lamp_on: nextState,
      updatedAt: serverTimestamp(),
    });
    clearTimeout(loadingTimer);
    updateLampUI(nextState);
    showBanner(
      nextState
        ? 'Lámpa bekapcsolva (P2 manuális mód aktív).'
        : 'Lámpa kikapcsolva (P3 automata mód aktív).',
      'success'
    );
  } catch (error) {
    clearTimeout(loadingTimer);
    updateLampUI(previousState);
    showBanner(`Nem sikerült átkapcsolni a lámpát: ${error.message}`, 'error');
  } finally {
    clearTimeout(loadingTimer);
    els.lampOnToggle.removeAttribute('aria-busy');
    els.lampOnToggle.disabled = false;
  }
}

async function handleSettingsSubmit(event) {
  event.preventDefault();
  setFieldError(els.settingsError, '');
  if (!selectedId) return;

  const payload = {
    updatedAt: serverTimestamp(),
  };

  for (const spec of PARAM_SPECS) {
    const numEl = document.getElementById(`${spec.key}-num`);
    const rawStr = numEl.value.trim();
    const val = Number(rawStr);
    if (rawStr === '' || !Number.isInteger(val) || val < spec.min || val > spec.max) {
      setFieldError(
        els.settingsError,
        `A(z) "${spec.label}" értékének ${spec.min} és ${spec.max} közötti egész számnak kell lennie.`
      );
      return;
    }
    payload[spec.key] = val;
  }

  await runWithButtonLock(els.saveSettingsBtn, 'Mentés...', async () => {
    try {
      await updateDoc(doc(db, 'devices', selectedId), payload);
      dirtyParams.clear();
      showBanner('Eszköz beállításai elmentve.', 'success');
    } catch (error) {
      setFieldError(els.settingsError, error.message);
    }
  });
}

function openRestartModal() {
  if (!selectedId || els.restartBtn.disabled) return;
  els.restartModalDesc.textContent =
    `Biztosan újra szeretnéd indítani a(z) "${selectedId}" ESP32 vezérlőt? Az újraindítás alatt az eszköz átmenetileg nem lesz elérhető.`;

  if (typeof els.restartModal.showModal === 'function') {
    if (!els.restartModal.open) {
      els.restartModal.showModal();
    }
  } else {
    els.restartModal.setAttribute('open', '');
  }
  els.restartCancelBtn.focus();
}

function closeRestartModal() {
  if (typeof els.restartModal.close === 'function') {
    if (els.restartModal.open) {
      els.restartModal.close();
    }
  } else {
    els.restartModal.removeAttribute('open');
  }
}

async function handleRestartConfirm() {
  if (!selectedId || isRestartSubmitting) return;
  isRestartSubmitting = true;
  els.restartCancelBtn.disabled = true;
  els.restartModalClose.disabled = true;

  await runWithButtonLock(els.restartConfirmBtn, 'Küldés...', async () => {
    try {
      await updateDoc(doc(db, 'devices', selectedId), {
        restart_requested: true,
        updatedAt: serverTimestamp(),
      });
      updateRestartUI(true);
      closeRestartModal();
      showBanner(`Újraindítási kérelem elküldve a(z) "${selectedId}" eszközhöz.`, 'success');
    } catch (error) {
      showBanner(`Az újraindítás sikertelen: ${error.message}`, 'error');
    } finally {
      isRestartSubmitting = false;
      els.restartCancelBtn.disabled = false;
      els.restartModalClose.disabled = false;
    }
  });
}

async function handleUnpair() {
  if (!selectedId || !currentUser) return;
  if (!window.confirm(`Biztosan leválasztod a(z) "${selectedId}" eszközt a fiókodról?`)) return;

  const targetId = selectedId;
  await runWithButtonLock(els.unpairBtn, 'Leválasztás...', async () => {
    if (selectedDeviceUnsubscribe) {
      selectedDeviceUnsubscribe();
      selectedDeviceUnsubscribe = null;
    }
    try {
      await updateDoc(doc(db, 'devices', targetId), {
        allowedUsers: arrayRemove(currentUser.uid),
      });
      clearSelectedDevice();
      showBanner(`A(z) "${targetId}" eszköz leválasztva.`, 'success');
    } catch (error) {
      subscribeToSelectedDevice(targetId);
      showBanner(`A leválasztás sikertelen: ${error.message}`, 'error');
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

function init() {
  applyUiErgonomics();
  bindSliderAndNumberSync();

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
  els.deviceSelect.addEventListener('change', () => {
    selectedId = els.deviceSelect.value;
    dirtyParams.clear();
    if (selectedId) {
      renderDashboard(selectedId, true);
      subscribeToSelectedDevice(selectedId);
    } else {
      clearSelectedDevice();
    }
  });
  els.pairingForm.addEventListener('submit', handlePairingSubmit);
  els.lampOnToggle.addEventListener('click', handleLampToggle);
  els.settingsForm.addEventListener('submit', handleSettingsSubmit);
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
  els.unpairBtn.addEventListener('click', handleUnpair);

  try {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = initializeFirestore(app, { experimentalForceLongPolling: true });

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
    showBanner(`Firebase inicializálási hiba: ${error.message}`, 'error');
  }
}

init();
