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
  updateDoc,
  arrayRemove,
  deleteField,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import {
  getDatabase,
  ref,
  onValue,
  update,
  goOffline,
  goOnline,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js';
import {
  getFunctions,
  httpsCallable,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js';

const PARAM_SPECS = [
  { key: 'threshold', label: 'Fény érzékenység', min: 1, max: 100, fallback: 50 },
  { key: 'sensitivity', label: 'Mozgás érzékenység', min: 1, max: 100, fallback: 50 },
  { key: 'duration', label: 'Késleltetés (mp)', min: 10, max: 600, fallback: 60 },
  { key: 'safety_off_min', label: 'Auto kikapcs (p)', min: 0, max: 1440, fallback: 0 },
  { key: 'lamp_wattage_w', label: 'Lámpa teljesítménye (W)', min: 0, max: 5000, fallback: 0 },
];

const PASSKEY_REGEX = /^[A-Z0-9]{10}$/;
const CUSTOM_NAME_REGEX = /^[A-Za-z0-9 _-]{0,32}$/;
const LOADING_DELAY_MS = 250;
const TOAST_DISPLAY_MS = 4000;
const PAIRING_SUCCESS_DISPLAY_MS = TOAST_DISPLAY_MS;
const ONLINE_THRESHOLD_MS = 90000;
const RTDB_URL = 'https://okospilacsvezerlo-default-rtdb.europe-west1.firebasedatabase.app';
const STALE_THRESHOLD_MS = 55000;
const ONLINE_TICK_MS = 10000;
const RTDB_RETRY_DELAYS_MS = [2000, 5000];
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
  pairCustomName: document.getElementById('pair-custom-name'),
  pairPin: document.getElementById('pair-pin'),
  pairSubmitBtn: document.getElementById('pair-submit-btn'),
  backToDevicesBtn: document.getElementById('back-to-devices-btn'),
  pairingError: document.getElementById('pairing-error'),
  pairingSpinner: document.getElementById('pairing-spinner'),
  pairingFeedbackText: document.getElementById('pairing-feedback-text'),
  deviceListView: document.getElementById('device-list-view'),
  statusBanner: document.getElementById('status-banner'),
  statusBannerText: document.getElementById('status-banner-text'),
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
  resetConsumptionBtn: document.getElementById('reset-consumption-btn'),
  confirmModal: document.getElementById('confirm-modal'),
  confirmModalTitle: document.getElementById('confirm-modal-title'),
  confirmModalDesc: document.getElementById('confirm-modal-desc'),
  confirmCancelBtn: document.getElementById('confirm-cancel-btn'),
  confirmActionBtn: document.getElementById('confirm-action-btn'),
  helpModal: document.getElementById('help-modal'),
  helpModalClose: document.getElementById('help-modal-close'),
};

let auth = null;
let db = null;
let rtdb = null;
let functions = null;
let currentUser = null;
let devicesUnsubscribe = null;
let devicesById = new Map();
const liveStateById = new Map();
const liveCmdById = new Map();
const rtdbUnsubscribesById = new Map();
const rtdbRetryTimersById = new Map();
const rtdbRetryCountById = new Map();
const renderedOnlineById = new Map();
const dirtyParams = new Set();
const togglingDeviceIds = new Set();
let onlineTickerId = null;
let tokenRefreshPromise = null;
let rtdbReconnectInFlight = false;
let serverTimeOffset = 0;
let serverTimeOffsetUnsubscribe = null;

const uiState = {
  showPairingView: false,
  settingsDeviceId: null,
};

let pairingFeedbackTimer = null;
let statusTimer = null;
let settingsStatusTimer = null;
let isConfirmSubmitting = false;
let pendingConfirmHandler = null;
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

function isDeviceLampOn(device) {
  if (!device || !isDeviceOnline(device)) return false;
  const liveState = liveStateById.get(device.id);
  const isManualOn = getManualLampOn(device);
  const isAutoActive = !isManualOn && liveState?.auto === true;
  return liveState?.on === true || isManualOn || isAutoActive;
}

function getFleetSummaryText() {
  const totalCount = devicesById.size;
  if (totalCount === 0) {
    return 'Nincs még párosított eszköz';
  }
  let onCount = 0;
  let hasWattage = false;
  let totalKwh = 0;
  for (const device of devicesById.values()) {
    if (isDeviceLampOn(device)) {
      onCount += 1;
    }
    const wattage = getDeviceWattage(device);
    if (wattage > 0) {
      hasWattage = true;
      totalKwh += (getDeviceTotalOnSeconds(device) / 3600) * (wattage / 1000);
    }
  }
  if (hasWattage) {
    return `Összesen: ${totalCount} eszköz • Ég: ${onCount} • ${totalKwh.toFixed(2)} kWh`;
  }
  return `Összesen: ${totalCount} eszköz • Ég: ${onCount}`;
}

function renderIdleStatusBanner() {
  els.statusBanner.classList.remove('is-hidden', 'is-error', 'is-success', 'is-info');
  els.statusBannerText.textContent = getFleetSummaryText();
}

function showBanner(message, type = 'info', durationMs = TOAST_DISPLAY_MS) {
  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }
  if (!message) {
    renderIdleStatusBanner();
    return;
  }
  els.statusBanner.classList.remove('is-hidden', 'is-error', 'is-success', 'is-info');
  els.statusBannerText.textContent = message;
  if (type === 'error') {
    els.statusBanner.classList.add('is-error');
  } else if (type === 'success') {
    els.statusBanner.classList.add('is-success');
  } else {
    els.statusBanner.classList.add('is-info');
  }
  statusTimer = setTimeout(() => {
    statusTimer = null;
    renderIdleStatusBanner();
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

function normalizeTimestampMs(rawTs) {
  if (rawTs === null || rawTs === undefined) return NaN;
  if (typeof rawTs.toMillis === 'function') {
    return rawTs.toMillis();
  }
  if (typeof rawTs === 'string') {
    const parsedNum = Number(rawTs);
    if (Number.isFinite(parsedNum) && parsedNum > 0) {
      return parsedNum < 1e12 ? parsedNum * 1000 : parsedNum;
    }
    return Date.parse(rawTs);
  }
  if (typeof rawTs === 'number' && Number.isFinite(rawTs) && rawTs > 0) {
    return rawTs < 1e12 ? rawTs * 1000 : rawTs;
  }
  return NaN;
}

function isDeviceOnline(device) {
  if (!device) return false;
  const now = Date.now() + serverTimeOffset;
  const liveState = liveStateById.get(device.id);
  const rtdbTsMs = normalizeTimestampMs(liveState?.ts ?? liveState?.last_seen);
  if (Number.isFinite(rtdbTsMs)) {
    return (now - rtdbTsMs) <= STALE_THRESHOLD_MS;
  }
  if (device.online === true) return true;
  const lastSeenMs = normalizeTimestampMs(device.lastSeenAt ?? device.last_seen);
  return Number.isFinite(lastSeenMs) && (now - lastSeenMs) <= ONLINE_THRESHOLD_MS;
}

function getManualLampOn(device) {
  if (!device) return false;
  const liveCmd = liveCmdById.get(device.id);
  if (liveCmd && typeof liveCmd.lamp === 'boolean') {
    return liveCmd.lamp;
  }
  return Boolean(device.remote_lamp_on);
}

function clampIntParam(val, min, max, fallback) {
  return typeof val === 'number' && Number.isFinite(val)
    ? Math.min(max, Math.max(min, Math.round(val)))
    : fallback;
}

function getDeviceWattage(device) {
  if (!device) return 0;
  const liveState = liveStateById.get(device.id);
  const raw = Number(device.lamp_wattage_w ?? liveState?.wattage ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(5000, Math.round(raw));
}

function getDeviceTotalOnSeconds(device) {
  const raw = Number(device?.total_on_seconds ?? 0);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function buildFullCmdPayload(device, overrides = {}) {
  return {
    lamp: Boolean(device?.remote_lamp_on),
    restart: Boolean(device?.restart_requested),
    thr: clampIntParam(device?.threshold, 1, 100, 50),
    sens: clampIntParam(device?.sensitivity, 1, 100, 50),
    dur: clampIntParam(device?.duration, 10, 600, 60),
    safe: clampIntParam(device?.safety_off_min, 0, 1440, 0),
    wattage: getDeviceWattage(device),
    ...overrides,
  };
}

function renderLiveDeviceUpdates(deviceId) {
  if (!currentUser) return;
  if (!uiState.showPairingView && devicesById.size > 0) {
    renderDeviceList();
  }
  if (uiState.settingsDeviceId === deviceId && devicesById.has(deviceId)) {
    populateSettingsModal(deviceId, false);
  }
}

async function refreshCurrentUserToken() {
  const user = auth?.currentUser || currentUser;
  if (!user || typeof user.getIdToken !== 'function') return;
  if (!tokenRefreshPromise) {
    tokenRefreshPromise = user.getIdToken(true)
      .catch((error) => {
        console.warn('Auth token refresh failed:', error?.message || error);
      })
      .finally(() => {
        tokenRefreshPromise = null;
      });
  }
  await tokenRefreshPromise;
}

function detachDeviceRtdbListeners(deviceId) {
  const unsubs = rtdbUnsubscribesById.get(deviceId);
  if (unsubs) {
    unsubs.unsubState();
    unsubs.unsubCmd();
    rtdbUnsubscribesById.delete(deviceId);
  }
  const retryTimer = rtdbRetryTimersById.get(deviceId);
  if (retryTimer !== undefined) {
    clearTimeout(retryTimer);
    rtdbRetryTimersById.delete(deviceId);
  }
}

function clearRtdbListeners() {
  for (const deviceId of Array.from(rtdbUnsubscribesById.keys())) {
    detachDeviceRtdbListeners(deviceId);
  }
  for (const timerId of rtdbRetryTimersById.values()) {
    clearTimeout(timerId);
  }
  rtdbRetryTimersById.clear();
  rtdbRetryCountById.clear();
  liveStateById.clear();
  liveCmdById.clear();
  renderedOnlineById.clear();
}

function scheduleRtdbListenerRecovery(deviceId) {
  if (!currentUser || !devicesById.has(deviceId)) return;
  if (rtdbRetryTimersById.has(deviceId)) return;

  const unsubs = rtdbUnsubscribesById.get(deviceId);
  if (unsubs) {
    unsubs.unsubState();
    unsubs.unsubCmd();
    rtdbUnsubscribesById.delete(deviceId);
  }

  const attempt = rtdbRetryCountById.get(deviceId) || 0;
  const delayMs = RTDB_RETRY_DELAYS_MS[Math.min(attempt, RTDB_RETRY_DELAYS_MS.length - 1)];
  rtdbRetryCountById.set(deviceId, attempt + 1);

  const timerId = setTimeout(() => {
    rtdbRetryTimersById.delete(deviceId);
    if (!currentUser || !devicesById.has(deviceId)) return;
    attachDeviceRtdbListeners(deviceId);
  }, delayMs);

  rtdbRetryTimersById.set(deviceId, timerId);
}

function attachDeviceRtdbListeners(deviceId) {
  if (!rtdb || !currentUser || !devicesById.has(deviceId)) return;
  detachDeviceRtdbListeners(deviceId);

  const stateRef = ref(rtdb, `live/${deviceId}/state`);
  const cmdRef = ref(rtdb, `live/${deviceId}/cmd`);

  const unsubState = onValue(
    stateRef,
    (snap) => {
      rtdbRetryCountById.set(deviceId, 0);
      if (snap.exists()) {
        liveStateById.set(deviceId, snap.val());
      } else {
        liveStateById.delete(deviceId);
      }
      renderLiveDeviceUpdates(deviceId);
    },
    (error) => {
      if (!currentUser || !devicesById.has(deviceId)) return;
      console.warn(`RTDB state listener error (${deviceId}):`, error.message);
      scheduleRtdbListenerRecovery(deviceId);
    }
  );

  const unsubCmd = onValue(
    cmdRef,
    (snap) => {
      rtdbRetryCountById.set(deviceId, 0);
      if (snap.exists()) {
        liveCmdById.set(deviceId, snap.val());
      } else {
        liveCmdById.delete(deviceId);
      }
      renderLiveDeviceUpdates(deviceId);
    },
    (error) => {
      if (!currentUser || !devicesById.has(deviceId)) return;
      console.warn(`RTDB cmd listener error (${deviceId}):`, error.message);
      scheduleRtdbListenerRecovery(deviceId);
    }
  );

  rtdbUnsubscribesById.set(deviceId, { unsubState, unsubCmd });
}

function syncRtdbListeners(deviceIds) {
  if (!rtdb) return;
  const activeSet = new Set(deviceIds);

  for (const deviceId of Array.from(rtdbUnsubscribesById.keys())) {
    if (!activeSet.has(deviceId)) {
      detachDeviceRtdbListeners(deviceId);
      rtdbRetryCountById.delete(deviceId);
      liveStateById.delete(deviceId);
      liveCmdById.delete(deviceId);
      renderedOnlineById.delete(deviceId);
    }
  }

  for (const deviceId of Array.from(rtdbRetryTimersById.keys())) {
    if (!activeSet.has(deviceId)) {
      clearTimeout(rtdbRetryTimersById.get(deviceId));
      rtdbRetryTimersById.delete(deviceId);
      rtdbRetryCountById.delete(deviceId);
    }
  }

  for (const deviceId of activeSet) {
    if (rtdbUnsubscribesById.has(deviceId) || rtdbRetryTimersById.has(deviceId)) continue;
    attachDeviceRtdbListeners(deviceId);
  }
}

function evaluateOnlineStatuses(forceRender = false) {
  if (!currentUser || devicesById.size === 0) return;
  let changed = forceRender;
  if (!changed) {
    for (const [deviceId, device] of devicesById.entries()) {
      if (renderedOnlineById.get(deviceId) !== isDeviceOnline(device)) {
        changed = true;
        break;
      }
    }
  }
  if (!changed) return;
  if (!uiState.showPairingView) {
    renderDeviceList();
  }
  if (uiState.settingsDeviceId && devicesById.has(uiState.settingsDeviceId)) {
    populateSettingsModal(uiState.settingsDeviceId, false);
  }
}

async function reconnectRtdbAndRefresh() {
  if (!rtdb || !currentUser || rtdbReconnectInFlight) return;
  rtdbReconnectInFlight = true;
  try {
    await refreshCurrentUserToken();
    if (!currentUser || !rtdb) return;
    goOffline(rtdb);
    goOnline(rtdb);
    for (const timerId of rtdbRetryTimersById.values()) {
      clearTimeout(timerId);
    }
    rtdbRetryTimersById.clear();
    rtdbRetryCountById.clear();
    for (const deviceId of devicesById.keys()) {
      attachDeviceRtdbListeners(deviceId);
    }
    evaluateOnlineStatuses(true);
  } catch (error) {
    console.warn('RTDB reconnect failed:', error?.message || error);
  } finally {
    rtdbReconnectInFlight = false;
  }
}

function startOnlineTicker() {
  if (onlineTickerId !== null) return;
  onlineTickerId = setInterval(() => {
    evaluateOnlineStatuses(false);
  }, ONLINE_TICK_MS);
}

function stopOnlineTicker() {
  if (onlineTickerId !== null) {
    clearInterval(onlineTickerId);
    onlineTickerId = null;
  }
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

function createAutoIndicatorSvg() {
  const svg = createSvgElement('svg', {
    viewBox: '0 0 24 24',
    'aria-hidden': 'true',
  });
  const text = createSvgElement('text', {
    x: '12',
    y: '12',
    'text-anchor': 'middle',
    'dominant-baseline': 'central',
    fill: 'currentColor',
    'font-size': '13.5',
    'font-weight': '700',
  });
  text.textContent = 'A';
  svg.appendChild(text);
  return svg;
}

function getDeviceDisplayName(deviceOrId) {
  const device = typeof deviceOrId === 'string'
    ? (devicesById.get(deviceOrId) || { id: deviceOrId })
    : deviceOrId;
  if (!device) return '';
  const custom =
    currentUser &&
    device.customNames &&
    typeof device.customNames[currentUser.uid] === 'string'
      ? device.customNames[currentUser.uid].trim()
      : '';
  return custom.length > 0 ? custom : (device.id || '');
}

function renderDeviceList() {
  const sortedIds = Array.from(devicesById.keys()).sort();
  const rows = [];
  renderedOnlineById.clear();

  for (const deviceId of sortedIds) {
    const device = devicesById.get(deviceId) || { id: deviceId };
    const displayName = getDeviceDisplayName(device);
    const isOnline = isDeviceOnline(device);
    renderedOnlineById.set(deviceId, isOnline);
    const liveState = liveStateById.get(deviceId);
    const isManualOn = getManualLampOn(device);
    const isAutoActive = isOnline && !isManualOn && liveState?.auto === true;

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
    dot.className = `status-dot ${isOnline ? 'is-online' : 'is-offline'}`;
    dot.setAttribute('aria-hidden', 'true');

    const statusText = document.createElement('span');
    statusText.textContent = isOnline ? 'Online' : 'Offline';

    statusEl.append(dot, statusText);
    info.append(nameEl, statusEl);

    const actions = document.createElement('div');
    actions.className = 'device-actions';

    const wattage = getDeviceWattage(device);
    if (wattage > 0) {
      const totalSec = getDeviceTotalOnSeconds(device);
      const kwh = (totalSec / 3600) * (wattage / 1000);
      const kwhBadge = document.createElement('span');
      kwhBadge.className = 'device-kwh';
      kwhBadge.textContent = `${kwh.toFixed(2)} kWh`;
      actions.append(kwhBadge);
    }

    const autoIndicator = document.createElement('span');
    autoIndicator.className = `auto-indicator${isAutoActive ? ' is-active' : ''}`;
    autoIndicator.setAttribute('aria-hidden', 'true');
    autoIndicator.appendChild(createAutoIndicatorSvg());

    const lampBtn = document.createElement('button');
    lampBtn.type = 'button';
    if (!isOnline) {
      lampBtn.className = 'icon-btn lamp-btn lamp-btn--offline';
      lampBtn.disabled = true;
      lampBtn.title = 'Eszköz offline – a lámpa távolról nem kapcsolható';
      lampBtn.setAttribute('aria-label', `${displayName} – Eszköz offline`);
    } else if (isManualOn) {
      lampBtn.className = 'icon-btn lamp-btn lamp-btn--on is-on';
      lampBtn.disabled = togglingDeviceIds.has(deviceId);
      lampBtn.title = 'Manuális világítás: BE';
      lampBtn.setAttribute('aria-label', `${displayName} – Manuális világítás: BE`);
    } else {
      lampBtn.className = 'icon-btn lamp-btn btn-accent-highlight';
      lampBtn.disabled = togglingDeviceIds.has(deviceId);
      lampBtn.title = 'Manuális világítás: KI';
      lampBtn.setAttribute('aria-label', `${displayName} – Manuális világítás: KI`);
    }
    lampBtn.setAttribute('aria-pressed', isManualOn ? 'true' : 'false');
    lampBtn.appendChild(createBulbIconSvg());
    lampBtn.addEventListener('click', () => handleRowLampToggle(deviceId, lampBtn));

    const gearBtn = document.createElement('button');
    gearBtn.type = 'button';
    gearBtn.className = 'icon-btn gear-btn btn-accent-highlight';
    gearBtn.disabled = false;
    gearBtn.title = 'Beállítások';
    gearBtn.setAttribute('aria-label', `${displayName} – Beállítások`);
    gearBtn.appendChild(createGearIconSvg());
    gearBtn.addEventListener('click', () => openSettingsModal(deviceId));

    actions.append(autoIndicator, lampBtn, gearBtn);
    row.append(info, actions);
    rows.push(row);
  }

  els.deviceList.replaceChildren(...rows);
  if (!statusTimer) {
    renderIdleStatusBanner();
  }
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
    closeConfirmModal();
    return;
  }

  // Logged in: Kilépés and signed-in email are ALWAYS visible on Pairing and Device List views
  els.signOutBtn.classList.remove('hidden');
  els.userStatusBar.classList.remove('hidden');
  els.userStatusEmail.textContent = `Bejelentkezve: ${currentUser.email || ''}`;
  els.authSection.classList.add('hidden');

  if (uiState.showPairingView) {
    // State 2: Pairing View
    els.pairingView.classList.remove('hidden');
    els.deviceListView.classList.add('hidden');
    els.backToDevicesBtn.classList.remove('hidden');
  } else {
    // State 3: Device List View (also shown for 0-device empty state)
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

  els.settingsModalDeviceName.textContent = getDeviceDisplayName(deviceId);

  const online = isDeviceOnline(data);
  els.settingsModalStatusDot.className = `status-dot ${online ? 'is-online' : 'is-offline'}`;
  els.settingsModalStatusText.textContent = online ? 'Online' : 'Offline';

  const liveCmd = liveCmdById.get(deviceId);
  const isRestarting = liveCmd && typeof liveCmd.restart === 'boolean'
    ? liveCmd.restart
    : data.restart_requested === true;
  els.restartBtn.disabled = isRestarting;
  els.restartBtn.textContent = isRestarting ? 'Újraindítás...' : 'Újraindítás';

  const wattage = getDeviceWattage(data);
  els.resetConsumptionBtn.classList.toggle('hidden', wattage <= 0);

  for (const spec of PARAM_SPECS) {
    const numEl = document.getElementById(`${spec.key}-num`);
    const isFocused = document.activeElement === numEl;
    if (!forcePopulate && (isFocused || dirtyParams.has(spec.key))) {
      continue;
    }
    const candidate = spec.key === 'lamp_wattage_w'
      ? (data.lamp_wattage_w ?? liveStateById.get(deviceId)?.wattage ?? spec.fallback)
      : data[spec.key];
    const numericVal = Number(candidate);
    const rawVal = candidate !== null && candidate !== undefined && candidate !== '' && Number.isFinite(numericVal)
      ? numericVal
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

function blurIfInside(containerEl) {
  const active = document.activeElement;
  if (active instanceof HTMLElement && containerEl && containerEl.contains(active)) {
    active.blur();
  }
}

function closeSettingsModal() {
  uiState.settingsDeviceId = null;
  dirtyParams.clear();
  setSettingsStatus('hidden', '');
  blurIfInside(els.settingsModal);
  closeDialogElement(els.settingsModal);
}

function openConfirmModal({
  title,
  description,
  confirmText,
  loadingText = 'Folyamatban...',
  variantClass = 'btn-warning',
  closeSettingsOnConfirm = false,
  onConfirm,
}) {
  if (!onConfirm) return;
  pendingConfirmHandler = { onConfirm, loadingText, closeSettingsOnConfirm };
  isConfirmSubmitting = false;
  els.confirmCancelBtn.disabled = false;
  els.confirmActionBtn.disabled = false;
  els.confirmActionBtn.className = `btn ${variantClass}`;
  els.confirmActionBtn.textContent = confirmText;
  els.confirmModalTitle.textContent = title;
  els.confirmModalDesc.textContent = description;
  openDialogElement(els.confirmModal);
  els.confirmCancelBtn.focus();
}

function closeConfirmModal() {
  if (isConfirmSubmitting) return;
  pendingConfirmHandler = null;
  els.confirmCancelBtn.disabled = false;
  blurIfInside(els.confirmModal);
  closeDialogElement(els.confirmModal);
}

function openRestartModal() {
  const deviceId = uiState.settingsDeviceId;
  if (!deviceId || els.restartBtn.disabled) return;
  const displayName = getDeviceDisplayName(deviceId);
  openConfirmModal({
    title: 'ESP32 újraindítása',
    description: `Biztosan újra szeretnéd indítani a(z) "${displayName}" ESP32 vezérlőt? Az újraindítás alatt az eszköz átmenetileg nem lesz elérhető.`,
    confirmText: 'Újraindítás',
    loadingText: 'Küldés...',
    variantClass: 'btn-warning',
    closeSettingsOnConfirm: true,
    onConfirm: () => executeRestart(deviceId),
  });
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
  const displayName = getDeviceDisplayName(deviceId);
  const successMsg = `Sikeres párosítás! A(z) ${displayName} eszköz csatlakoztatva.`;
  setPairingFeedback('hidden', '');
  showBanner(successMsg, 'success', PAIRING_SUCCESS_DISPLAY_MS);
}

function subscribeToDevices() {
  if (devicesUnsubscribe) {
    devicesUnsubscribe();
    devicesUnsubscribe = null;
  }
  clearRtdbListeners();
  stopOnlineTicker();

  if (!auth?.currentUser) {
    return;
  }

  startOnlineTicker();

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
        devicesById.set(docSnap.id, { ...docSnap.data(), id: docSnap.id });
      });

      syncRtdbListeners(Array.from(devicesById.keys()));

      renderCurrentView();

      if (uiState.settingsDeviceId) {
        if (devicesById.has(uiState.settingsDeviceId)) {
          populateSettingsModal(uiState.settingsDeviceId, false);
        } else {
          isConfirmSubmitting = false;
          closeConfirmModal();
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

function getPairingRejectionMessage(errorCode) {
  switch (errorCode) {
    case 'DEVICE_UNINITIALIZED':
      return 'Az eszköz még nincs inicializálva (még nem csatlakozott az internetre). Először csatlakozz az eszköz saját Wi-Fi hálózatához (SmartLight-XXXX), és a 192.168.4.1 oldalon állítsd be az otthoni Wi-Fi elérést, majd próbáld újra a párosítást!';
    case 'LOCKED_OUT':
      return 'Túl sok hibás próbálkozás miatt az eszköz zárolva van. Indítsd újra az eszközt vagy használd a gyári visszaállítást.';
    case 'INVALID_PASSKEY':
      return 'Hibás 10 karakteres gyári biztonsági kód (Passkey). Ellenőrizd az eszköz címkéjén vagy a Captive Portalon!';
    default:
      return 'A párosítási kérelem elutasításra került. Ellenőrizd az eszköz adatait és próbáld újra.';
  }
}

async function handlePairingSubmit(event) {
  event.preventDefault();
  setPairingFeedback('hidden', '');

  if (!currentUser || !auth?.currentUser) return;

  const deviceId = els.pairDeviceId.value.trim();
  const customName = els.pairCustomName.value.trim();
  const pin = els.pairPin.value.trim().toUpperCase();
  els.pairCustomName.value = customName;
  els.pairPin.value = pin;

  if (!deviceId || deviceId.includes('/')) {
    setPairingFeedback('error', 'Adj meg egy érvényes eszköz azonosítót "/" karakter nélkül.');
    return;
  }
  if (!CUSTOM_NAME_REGEX.test(customName)) {
    setPairingFeedback(
      'error',
      'Az egyedi név csak ékezet nélküli betűket (a-Z), számokat (0-9), szóközt, _ és - karaktert tartalmazhat!'
    );
    return;
  }
  if (!PASSKEY_REGEX.test(pin)) {
    setPairingFeedback(
      'error',
      'A gyári biztonsági kódnak (Passkey) pontosan 10 karakteres alfanumerikus kódnak (A–Z, 0–9) kell lennie.'
    );
    return;
  }

  setPairingFormPending(true);
  const sendTimer = setTimeout(() => {
    els.pairSubmitBtn.textContent = 'Küldés...';
  }, LOADING_DELAY_MS);

  try {
    const pair = httpsCallable(functions, 'requestPairing');
    await pair({ deviceId, passkey: pin, customName });
    clearTimeout(sendTimer);
    completePairingSuccess(deviceId);
  } catch (error) {
    clearTimeout(sendTimer);
    cleanupPendingPairing();
    setPairingFeedback('error', error.message);
  }
}

async function handleRowLampToggle(deviceId, buttonEl) {
  if (!deviceId || togglingDeviceIds.has(deviceId)) return;
  const device = devicesById.get(deviceId);
  if (!device || !isDeviceOnline(device)) return;

  const previousState = getManualLampOn(device);
  const nextState = !previousState;
  togglingDeviceIds.add(deviceId);
  buttonEl.disabled = true;
  buttonEl.setAttribute('aria-busy', 'true');

  try {
    const cmdPayload = liveCmdById.has(deviceId)
      ? { lamp: nextState }
      : buildFullCmdPayload(device, { lamp: nextState });
    await Promise.all([
      update(ref(rtdb, `live/${deviceId}/cmd`), cmdPayload),
      updateDoc(doc(db, 'devices', deviceId), {
        remote_lamp_on: nextState,
        updatedAt: serverTimestamp(),
      }),
    ]);
    if (!statusTimer) {
      renderIdleStatusBanner();
    }
  } catch (error) {
    showBanner(`Nem sikerült átkapcsolni a lámpát: ${error.message}`, 'error');
  } finally {
    togglingDeviceIds.delete(deviceId);
    buttonEl.removeAttribute('aria-busy');
    const latestDevice = devicesById.get(deviceId);
    buttonEl.disabled = !latestDevice || !isDeviceOnline(latestDevice);
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
      const device = devicesById.get(deviceId);
      const rtdbCmdPatch = {
        thr: payload.threshold,
        sens: payload.sensitivity,
        dur: payload.duration,
        safe: payload.safety_off_min,
        wattage: payload.lamp_wattage_w,
      };
      const cmdPayload = liveCmdById.has(deviceId)
        ? rtdbCmdPatch
        : buildFullCmdPayload(device, rtdbCmdPatch);
      await Promise.all([
        update(ref(rtdb, `live/${deviceId}/cmd`), cmdPayload),
        updateDoc(doc(db, 'devices', deviceId), payload),
      ]);
      dirtyParams.clear();
      const displayName = getDeviceDisplayName(deviceId);
      setSettingsStatus('success', `${displayName}: Beállítások elmentve.`, 4000);
      showBanner(`${displayName}: Beállítások elmentve.`, 'success');
    } catch (error) {
      setSettingsStatus('error', error.message);
    }
  });
}

async function executeRestart(deviceId) {
  if (!deviceId) return;
  try {
    const device = devicesById.get(deviceId);
    const cmdPayload = liveCmdById.has(deviceId)
      ? { restart: true }
      : buildFullCmdPayload(device, { restart: true });
    await Promise.all([
      update(ref(rtdb, `live/${deviceId}/cmd`), cmdPayload),
      updateDoc(doc(db, 'devices', deviceId), {
        restart_requested: true,
        updatedAt: serverTimestamp(),
      }),
    ]);
    els.restartBtn.disabled = true;
    els.restartBtn.textContent = 'Újraindítás...';
    const displayName = getDeviceDisplayName(deviceId);
    showBanner(`Újraindítási kérelem elküldve: ${displayName}.`, 'success');
  } catch (error) {
    showBanner(`Az újraindítás sikertelen: ${error.message}`, 'error');
  }
}

async function executeResetConsumption(deviceId) {
  if (!deviceId || !currentUser) return;
  const device = devicesById.get(deviceId);
  if (!device || getDeviceWattage(device) <= 0) return;
  const displayName = getDeviceDisplayName(device);
  try {
    await updateDoc(doc(db, 'devices', deviceId), {
      total_on_seconds: 0,
      updatedAt: serverTimestamp(),
    });
    showBanner(`${displayName}: A fogyasztási adatok sikeresen törölve.`, 'success');
  } catch (error) {
    showBanner(`A fogyasztási adatok törlése sikertelen: ${error.message}`, 'error');
  }
}

async function executeUnpair(deviceId) {
  if (!deviceId || !currentUser) return;
  const device = devicesById.get(deviceId);
  const displayName = getDeviceDisplayName(device || deviceId);

  const updatePayload = {
    allowedUsers: arrayRemove(currentUser.uid),
    updatedAt: serverTimestamp(),
  };
  if (
    device?.customNames &&
    Object.prototype.hasOwnProperty.call(device.customNames, currentUser.uid)
  ) {
    updatePayload[`customNames.${currentUser.uid}`] = deleteField();
  }

  try {
    // Firestore is the ownership authority. The trusted onDeviceUpdated
    // function performs the RTDB/device notification after this succeeds.
    await updateDoc(doc(db, 'devices', deviceId), updatePayload);
    uiState.showPairingView = false;
    showBanner(`A(z) "${displayName}" eszköz sikeresen leválasztva.`, 'success');
  } catch (error) {
    showBanner(`A leválasztás sikertelen: ${error.message}`, 'error');
  }
}

async function handleConfirmAction() {
  if (!pendingConfirmHandler || isConfirmSubmitting) return;
  const { onConfirm, loadingText, closeSettingsOnConfirm } = pendingConfirmHandler;

  if (closeSettingsOnConfirm) {
    pendingConfirmHandler = null;
    isConfirmSubmitting = false;
    closeConfirmModal();
    closeSettingsModal();
    await onConfirm();
    return;
  }

  isConfirmSubmitting = true;
  els.confirmCancelBtn.disabled = true;

  await runWithButtonLock(els.confirmActionBtn, loadingText, async () => {
    try {
      await onConfirm();
    } finally {
      isConfirmSubmitting = false;
      els.confirmCancelBtn.disabled = false;
      closeConfirmModal();
    }
  });
}

function handleResetConsumption() {
  const deviceId = uiState.settingsDeviceId;
  if (!deviceId || !currentUser) return;
  const device = devicesById.get(deviceId);
  if (!device || getDeviceWattage(device) <= 0) return;

  const displayName = getDeviceDisplayName(device);
  openConfirmModal({
    title: 'Fogyasztási adatok törlése',
    description: `Biztosan törlöd a(z) "${displayName}" összesített fogyasztási adatait (0.00 kWh)?`,
    confirmText: 'Törlés',
    loadingText: 'Törlés...',
    variantClass: 'btn-danger',
    closeSettingsOnConfirm: true,
    onConfirm: () => executeResetConsumption(deviceId),
  });
}

function handleUnpair() {
  const deviceId = uiState.settingsDeviceId;
  if (!deviceId || !currentUser) return;
  const device = devicesById.get(deviceId);
  const displayName = getDeviceDisplayName(device || deviceId);
  openConfirmModal({
    title: 'Eszköz leválasztása',
    description: `Biztosan leválasztod a(z) "${displayName}" eszközt a fiókodról?`,
    confirmText: 'Leválasztás',
    loadingText: 'Leválasztás...',
    variantClass: 'btn-danger',
    closeSettingsOnConfirm: true,
    onConfirm: () => executeUnpair(deviceId),
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
  els.settingsModal.addEventListener('cancel', (event) => {
    if (els.confirmModal.open) {
      event.preventDefault();
    }
  });
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
  els.confirmCancelBtn.addEventListener('click', closeConfirmModal);
  els.confirmActionBtn.addEventListener('click', handleConfirmAction);
  els.confirmModal.addEventListener('close', () => {
    pendingConfirmHandler = null;
    isConfirmSubmitting = false;
    els.confirmCancelBtn.disabled = false;
  });
  els.confirmModal.addEventListener('cancel', (event) => {
    if (isConfirmSubmitting) {
      event.preventDefault();
    }
  });
  els.confirmModal.addEventListener('click', (event) => {
    if (event.target === els.confirmModal && !isConfirmSubmitting) {
      closeConfirmModal();
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
  window.addEventListener('online', () => {
    reconnectRtdbAndRefresh();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      reconnectRtdbAndRefresh();
    }
  });
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((err) => {
        console.warn('Service worker registration failed:', err?.message || err);
      });
    });
  }

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
  els.resetConsumptionBtn.addEventListener('click', handleResetConsumption);
  els.unpairBtn.addEventListener('click', handleUnpair);
  bindModalEvents();

  renderCurrentView();

  try {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = initializeFirestore(app, {});
    rtdb = getDatabase(app, RTDB_URL);
    functions = getFunctions(app, 'europe-west1');

    onAuthStateChanged(auth, (user) => {
      currentUser = user;
      if (user) {
        if (!serverTimeOffsetUnsubscribe) {
          const offsetRef = ref(rtdb, '/.info/serverTimeOffset');
          serverTimeOffsetUnsubscribe = onValue(offsetRef, (snap) => {
            const val = snap.val();
            if (typeof val === 'number' && Number.isFinite(val)) {
              serverTimeOffset = val;
              evaluateOnlineStatuses();
            }
          });
        }
        uiState.showPairingView = false;
        renderCurrentView();
        subscribeToDevices();
      } else {
        if (serverTimeOffsetUnsubscribe) {
          serverTimeOffsetUnsubscribe();
          serverTimeOffsetUnsubscribe = null;
        }
        serverTimeOffset = 0;
        cleanupPendingPairing();
        setPairingFeedback('hidden', '');
        if (devicesUnsubscribe) {
          devicesUnsubscribe();
          devicesUnsubscribe = null;
        }
        clearRtdbListeners();
        stopOnlineTicker();
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
