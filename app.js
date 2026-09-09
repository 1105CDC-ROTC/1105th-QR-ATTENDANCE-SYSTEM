const BACKEND_URL =
  'https://script.google.com/macros/s/AKfycbxQVMCHV1NsFrQClNPJUKjk-uus2QaqcSab1M6D8A1QZ1H9crHGQqmZCZedTjFaTgqzBA/exec';

let scanner;
let sessionId = '';
let busy = false;

const schoolSelect = document.getElementById('school');
const codeInput = document.getElementById('code');
const loginButton = document.getElementById('login');
const startButton = document.getElementById('start');

window.addEventListener('load', loadSchools);
loginButton.addEventListener('click', login);
startButton.addEventListener('click', startScanner);

async function loadSchools() {
  try {
    const response = await fetch(`${BACKEND_URL}?action=schools`);
    const data = await response.json();

    schoolSelect.replaceChildren(
      ...data.schools.map(name => new Option(name, name))
    );

    if (!data.schools.length) {
      show('No schools are configured.', false);
    }
  } catch (error) {
    show('Unable to load schools. Check the backend URL.', false);
  }
}

async function login() {
  const school = schoolSelect.value;
  const loginCode = codeInput.value.trim();

  if (!school || !loginCode) {
    show('Select a school and enter its login code.', false);
    return;
  }

  try {
    const params = new URLSearchParams({
      action: 'login',
      school: school,
      loginCode: loginCode
    });

    const response = await fetch(`${BACKEND_URL}?${params.toString()}`);
    const data = await response.json();

    if (!data.ok) {
      throw new Error(data.message);
    }

    sessionId = data.sessionId;

    schoolSelect.disabled = true;
    codeInput.disabled = true;
    loginButton.disabled = true;
    startButton.disabled = false;

    show('Login successful. Start scanner.', true);
  } catch (error) {
    show(error.message || 'Login failed.', false);
  }
}

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

    startButton.disabled = true;
    show('Scanner is ready.', true);
  } catch (error) {
    scanner = null;
    show(cameraErrorMessage(error), false);
  }
}

async function handleScan(value) {
  if (busy) return;

  busy = true;
  show('Reading QR code...', true);

  try {
    const params = new URLSearchParams({
      action: 'scan',
      sessionId: sessionId,
      qrValue: value
    });

    const response = await fetch(`${BACKEND_URL}?${params.toString()}`);
    const data = await response.json();

    if (!data.ok) {
      throw new Error(data.message);
    }

    showRecorded_(data);

    if (navigator.vibrate) {
      navigator.vibrate(150);
    }
  } catch (error) {
    show(error.message || 'Scan failed.', false);
  } finally {
    setTimeout(() => {
      busy = false;
    }, 1200);
  }
}

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

  show(`${data.action} recorded successfully.`, true);

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