const BACKEND_URL =
  'https://script.google.com/macros/s/AKfycbxQVMCHV1NsFrQClNPJUKjk-uus2QaqcSab1M6D8A1QZ1H9crHGQqmZCZedTjFaTgqzBA/exec';

const TIME_ZONE = 'Asia/Manila';
const DB_NAME = 'qr-attendance';
const SYNC_CHUNK = 40;

let scanner = null;
let current = null;
let busy = false;
let mode = '';
let lastValue = '';
let lastTime = 0;
let syncing = false;
let syncTimer = null;
let lastSyncError = '';
let dbPromise = null;
let chain = Promise.resolve();

const schoolSelect = document.getElementById('school');
const codeInput = document.getElementById('code');
const loginButton = document.getElementById('login');
const modeInButton = document.getElementById('modeIn');
const modeOutButton = document.getElementById('modeOut');
const netBadge = document.getElementById('netBadge');
const pendingBadge = document.getElementById('pendingBadge');

window.addEventListener('load', init);
window.addEventListener('online', () => {
  updateNet();
  syncAll();
});
window.addEventListener('offline', updateNet);
loginButton.addEventListener('click', login);
modeInButton.addEventListener('click', () => chooseMode('in'));
modeOutButton.addEventListener('click', () => chooseMode('out'));
pendingBadge.addEventListener('click', onBadgeClick);

setInterval(() => {
  if (navigator.onLine) syncAll();
}, 60000);

/* ===== Simula ===== */

async function init() {
  updateNet();

  try {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist();
    }
  } catch (error) {}

  await loadSchools();
  await updatePending();
  syncAll();
}

function updateNet() {
  const online = navigator.onLine;
  netBadge.textContent = online ? 'Online' : 'Offline';
  netBadge.className = online ? '' : 'off';
}

/* ===== Database sa phone (IndexedDB) ===== */

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('schools')) {
        database.createObjectStore('schools', { keyPath: 'school' });
      }
      if (!database.objectStoreNames.contains('scans')) {
        database.createObjectStore('scans', { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getDb() {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

async function dbRun(storeName, access, action) {
  const database = await getDb();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, access);
    const request = action(transaction.objectStore(storeName));

    transaction.oncomplete = () => resolve(request ? request.result : undefined);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

const dbGet = (store, key) => dbRun(store, 'readonly', s => s.get(key));
const dbAll = store => dbRun(store, 'readonly', s => s.getAll());
const dbPut = (store, value) => dbRun(store, 'readwrite', s => s.put(value));
const dbDelete = (store, key) => dbRun(store, 'readwrite', s => s.delete(key));

function exclusive(task) {
  const run = chain.then(task);
  chain = run.catch(() => {});
  return run;
}

/* ===== Petsa, oras, at iba pa ===== */

function dateKey(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function timeText(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  })
    .format(date)
    .replace(/\u202f/g, ' ');
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/* ===== Network ===== */

async function request(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function getJson(params, timeoutMs) {
  const query = new URLSearchParams(params).toString();
  return request(`${BACKEND_URL}?${query}`, {}, timeoutMs || 20000);
}

function postJson(body) {
  return request(
    BACKEND_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    },
    60000
  );
}

/* ===== Mga school ===== */

function readCachedSchools() {
  try {
    return JSON.parse(localStorage.getItem('qr_schools') || '[]');
  } catch (error) {
    return [];
  }
}

async function loadSchools() {
  let names = readCachedSchools();
  let online = false;

  try {
    const data = await getJson({ action: 'schools' }, 10000);
    online = true;

    if (data.schools && data.schools.length) {
      names = data.schools;
      try {
        localStorage.setItem('qr_schools', JSON.stringify(names));
      } catch (error) {}
    }
  } catch (error) {}

  let stored = [];
  try {
    stored = (await dbAll('schools')).map(record => record.school);
  } catch (error) {}

  stored.forEach(name => {
    if (!names.includes(name)) names.push(name);
  });

  schoolSelect.replaceChildren(
    ...names.map(name =>
      new Option(
        stored.includes(name) ? `${name} (ready offline)` : name,
        name
      )
    )
  );

  if (!names.length) {
    show(
      online
        ? 'No schools are configured.'
        : 'No internet connection. Connect once so this phone can download the school list.',
      false
    );
  }
}

/* ===== Login ===== */

function buildRecord(school, salt, syncKey, data) {
  const days = {};
  (data.days || []).forEach(day => {
    days[day.date] = day.rows;
  });

  return {
    school: school,
    salt: salt,
    syncKey: syncKey,
    serverDate: data.serverDate,
    cadets: data.cadets || [],
    days: days,
    updatedAt: Date.now()
  };
}

function withMap(record) {
  record.cadetMap = new Map(record.cadets.map((cadet, i) => [cadet.id, i]));
  return record;
}

function ensureDay(record, date) {
  if (!record.days[date]) {
    record.days[date] = record.cadets.map(() => ['', '', '']);
  }
  return record.days[date];
}

async function saveRecord(record) {
  await dbPut('schools', {
    school: record.school,
    salt: record.salt,
    syncKey: record.syncKey,
    serverDate: record.serverDate,
    cadets: record.cadets,
    days: record.days,
    updatedAt: record.updatedAt
  });
}

// Ibinabalik sa ibabaw ng bagong data ang mga scan na hindi pa na-sync.
async function applyPending(record) {
  const scans = (await dbAll('scans')).filter(
    scan => scan.school === record.school && scan.status === 'pending'
  );

  const map = new Map(record.cadets.map((cadet, i) => [cadet.id, i]));

  scans.forEach(scan => {
    const index = map.get(scan.cadetId);
    if (index === undefined) return;

    const rows = ensureDay(record, scan.date);
    const column = scan.mode === 'in' ? 0 : 1;

    if (!rows[index][column]) {
      rows[index][column] = timeText(new Date(scan.ts));
    }
  });
}

function storeRecord(record) {
  return exclusive(async () => {
    await applyPending(record);
    await saveRecord(record);
    return withMap(record);
  });
}

async function offlineLogin(school, loginCode) {
  const stored = await dbGet('schools', school);

  if (!stored) {
    throw new Error(
      `No internet connection, and this phone has not downloaded ${school} yet. Connect to the internet and log in once.`
    );
  }

  if (!(window.crypto && crypto.subtle)) {
    throw new Error('Offline login is not supported on this device.');
  }

  const hash = await sha256(`${stored.salt}|${school.trim()}|${loginCode}`);

  if (hash !== stored.syncKey) {
    throw new Error('Invalid school or login code.');
  }

  if (stored.serverDate && dateKey(new Date()) < stored.serverDate) {
    throw new Error('This phone date looks wrong. Fix the date and time, then try again.');
  }

  return withMap(stored);
}

async function login() {
  const school = schoolSelect.value;
  const loginCode = codeInput.value.trim();

  if (!school || !loginCode) {
    show('Select a school and enter its login code.', false);
    return;
  }

  loginButton.disabled = true;
  show('Logging in...', true);

  try {
    let data = null;
    let offline = false;

    try {
      data = await getJson({ action: 'setup', school: school, loginCode: loginCode }, 30000);
    } catch (error) {
      offline = true;
    }

    let record;

    if (offline) {
      record = await offlineLogin(school, loginCode);
    } else {
      if (!data.ok) {
        throw new Error(data.message || 'Login failed.');
      }

      if (data.serverDate !== dateKey(new Date())) {
        throw new Error('This phone date or time is wrong. Fix it, then try again.');
      }

      record = await storeRecord(
        buildRecord(data.school, data.salt, data.syncKey, data)
      );
    }

    current = record;

    schoolSelect.disabled = true;
    codeInput.disabled = true;
    modeInButton.disabled = false;
    modeOutButton.disabled = false;

    show(
      offline
        ? 'Offline login successful. Choose Time in or Time out.'
        : 'Login successful. Choose Time in or Time out.',
      true
    );

    if (!offline) syncSoon();
  } catch (error) {
    loginButton.disabled = false;
    show(error.message || 'Login failed.', false);
  }
}

/* ===== Scanner ===== */

async function startScanner() {
  if (scanner) return;

  scanner = new Html5Qrcode('reader');

  const config = {
    fps: 10,
    qrbox: {
      width: 250,
      height: 250
    }
  };

  try {
    const cameras = await Html5Qrcode.getCameras();

    if (!cameras || cameras.length === 0) {
      throw new Error('No camera found');
    }

    const preferredCamera =
      cameras.find(camera =>
        /back|rear|environment/i.test(camera.label)
      ) || cameras[0];

    await scanner.start(
      preferredCamera.id,
      config,
      handleScan,
      () => {}
    );

    document.getElementById('app').classList.add('scanning');
    show('Scanner is ready.', true);
  } catch (error) {
    scanner = null;
    show(cameraErrorMessage(error), false);
  }
}

async function handleScan(value) {
  if (busy || !current) return;

  const now = Date.now();
  if (value === lastValue && now - lastTime < 8000) return;
  lastValue = value;
  lastTime = now;

  busy = true;

  try {
    const result = await exclusive(() => recordLocalScan(value, now));

    showRecorded_(result);

    if (navigator.vibrate) {
      navigator.vibrate(150);
    }

    syncSoon();
  } catch (error) {
    show(error.message || 'Scan failed.', false);
  } finally {
    setTimeout(() => {
      busy = false;
    }, 1200);
  }
}

async function recordLocalScan(value, nowMs) {
  const record = current;

  if (mode !== 'in' && mode !== 'out') {
    throw new Error('Choose Time in or Time out first.');
  }

  const cadetId = String(value || '').replace(/^CADET:/i, '').trim();

  if (!cadetId) {
    throw new Error('Invalid QR code.');
  }

  const index = record.cadetMap.get(cadetId);

  if (index === undefined) {
    throw new Error(
      'Cadet ID is not in this phone list. Connect to the internet and log in again to refresh.'
    );
  }

  const when = new Date(nowMs);
  const date = dateKey(when);

  if (record.serverDate && date < record.serverDate) {
    throw new Error('This phone date looks wrong. Fix the date and time, then reopen the app.');
  }

  const name = record.cadets[index].name;
  const label = mode === 'in' ? 'TIME IN' : 'TIME OUT';
  const column = mode === 'in' ? 0 : 1;
  const rows = ensureDay(record, date);
  const existing = rows[index][column];

  if (existing) {
    throw new Error(`${label} ALREADY RECORDED - ${name} (${existing})`);
  }

  rows[index][column] = timeText(when);

  await dbPut('scans', {
    id: makeId(),
    school: record.school,
    cadetId: cadetId,
    mode: mode,
    ts: nowMs,
    date: date,
    name: name,
    status: 'pending'
  });

  await saveRecord(record);
  updatePending();

  return { action: label, name: name, id: cadetId };
}

/* ===== Sync ===== */

function syncSoon() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncAll, 1500);
}

async function syncAll() {
  if (syncing || !navigator.onLine) return;

  syncing = true;
  let sent = 0;

  try {
    const pending = (await dbAll('scans')).filter(scan => scan.status === 'pending');
    const groups = {};

    pending.forEach(scan => {
      (groups[scan.school] = groups[scan.school] || []).push(scan);
    });

    for (const school of Object.keys(groups)) {
      const record = await dbGet('schools', school);
      if (!record) continue;

      const list = groups[school].sort((a, b) => a.ts - b.ts);

      for (let i = 0; i < list.length; i += SYNC_CHUNK) {
        const chunk = list.slice(i, i + SYNC_CHUNK);

        const data = await postJson({
          action: 'sync',
          school: school,
          syncKey: record.syncKey,
          scans: chunk.map(scan => ({
            id: scan.id,
            cadetId: scan.cadetId,
            mode: scan.mode,
            ts: scan.ts,
            date: scan.date
          }))
        });

        if (!data.ok) {
          const message = data.message || 'Sync failed.';
          if (message !== lastSyncError) {
            lastSyncError = message;
            show(message, false);
          }
          break;
        }

        lastSyncError = '';

        for (const result of data.results || []) {
          const scan = chunk.find(item => item.id === result.id);
          if (!scan) continue;

          sent++;

          if (result.status === 'recorded' || result.status === 'duplicate') {
            await dbDelete('scans', scan.id);
          } else {
            scan.status = 'problem';
            scan.message =
              result.status === 'already'
                ? `already in the sheet (${result.existing || 'no time'})`
                : result.message || 'could not be recorded';
            await dbPut('scans', scan);
          }
        }
      }
    }

    if (sent && current) {
      await refreshCurrent();
    }
  } catch (error) {
    // Walang internet o hindi makontak ang backend. Susubukan ulit mamaya.
  } finally {
    syncing = false;
    updatePending();
  }
}

async function refreshCurrent() {
  try {
    const data = await getJson(
      { action: 'roster', school: current.school, syncKey: current.syncKey },
      30000
    );

    if (!data.ok) return;

    current = await storeRecord(
      buildRecord(current.school, current.salt, current.syncKey, data)
    );
  } catch (error) {}
}

async function updatePending() {
  let pending = 0;
  let problems = 0;

  try {
    const all = await dbAll('scans');
    pending = all.filter(scan => scan.status === 'pending').length;
    problems = all.filter(scan => scan.status === 'problem').length;
  } catch (error) {}

  if (problems) {
    pendingBadge.textContent = `${problems} not recorded - tap to view`;
    pendingBadge.className = 'warn';
    pendingBadge.hidden = false;
  } else if (pending) {
    pendingBadge.textContent = `${pending} waiting to sync`;
    pendingBadge.className = '';
    pendingBadge.hidden = false;
  } else {
    pendingBadge.hidden = true;
  }
}

async function onBadgeClick() {
  const all = await dbAll('scans');
  const problems = all.filter(scan => scan.status === 'problem');

  if (!problems.length) {
    syncAll();
    return;
  }

  const text = problems
    .slice(0, 5)
    .map(scan =>
      `${scan.name} (${scan.mode === 'in' ? 'Time in' : 'Time out'}, ${scan.date}): ${scan.message}`
    )
    .join(' | ');

  show(`Not recorded: ${text}${problems.length > 5 ? ' ...' : ''}`, false);

  for (const scan of problems) {
    await dbDelete('scans', scan.id);
  }

  updatePending();
}

/* ===== Mensahe ===== */

function cameraErrorMessage(error) {
  const message = String(error || '').toLowerCase();

  if (
    message.includes('permission') ||
    message.includes('notallowed')
  ) {
    return 'Camera permission is blocked. Allow camera access, then refresh the page.';
  }

  if (
    message.includes('notfound') ||
    message.includes('no camera')
  ) {
    return 'No camera was found. Check that the device has a working camera.';
  }

  if (
    message.includes('secure') ||
    message.includes('https')
  ) {
    return 'Camera requires an HTTPS website. Live Server is only for computer testing.';
  }

  return 'Camera could not start. Check the camera settings or try another browser.';
}

function showRecorded_(data) {
  const status = document.getElementById('scanStatus');

  status.textContent =
    `${data.action} RECORDED - ${data.name} (${data.id})`;

  status.className = 'visible';

  show(
    navigator.onLine
      ? `${data.action} saved. Syncing...`
      : `${data.action} saved on this phone. It will sync when internet returns.`,
    true
  );

  window.clearTimeout(showRecorded_.timer);

  showRecorded_.timer = window.setTimeout(() => {
    status.className = '';
  }, 4000);
}

function show(text, success) {
  const message = document.getElementById('message');

  message.textContent = text;
  message.className = success ? 'success' : 'error';
}

function chooseMode(newMode) {
  setMode(newMode);
  startScanner();
}

function setMode(newMode) {
  mode = newMode;
  lastValue = '';
  modeInButton.classList.toggle('active', mode === 'in');
  modeOutButton.classList.toggle('active', mode === 'out');
}
