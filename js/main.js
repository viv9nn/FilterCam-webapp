// Port of ContentView.swift (screens), BoothView (countdown + 4 shots), and ResultView.
import { Camera, CameraError } from './camera.js';
import { MoshRenderer } from './mosh.js';
import { makeStrip } from './strip.js';

const PHOTO_COUNT = 4;

const $ = (id) => document.getElementById(id);
const screens = { loading: $('loading'), denied: $('denied'), booth: $('booth'), result: $('result') };

const video = $('preview');
const moshCanvas = $('mosh');
const moshToggle = $('mosh-toggle');
const shutter = $('shutter');
const countdownEl = $('countdown');
const shotCounter = $('shot-counter');
const flash = $('flash');
const stripImg = $('strip');
const toast = $('toast');

const camera = new Camera(video);
let mosh = null;
let moshOn = false;
let isShooting = false;
let stripBlob = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function show(name) {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
}

// ---------- Camera / permissions ----------

async function openBooth() {
  show('loading');
  try {
    await camera.start();
  } catch (error) {
    showCameraError(error);
    return;
  }
  show('booth');
  if (moshOn) mosh?.start();
}

function showCameraError(error) {
  const kind = error instanceof CameraError ? error.kind : 'unavailable';
  const copy = {
    denied: [
      'Camera Access Needed',
      'FilterCam needs your camera to snap photo booth pictures. Allow camera access for this site in your browser settings, then try again.',
    ],
    unavailable: ['No Camera Found', "FilterCam couldn't find a camera it can use. Connect one, or close other apps that are using it, then try again."],
    insecure: ['Secure Connection Needed', 'Browsers only allow camera access over HTTPS or on localhost.'],
  }[kind];
  $('denied-title').textContent = copy[0];
  $('denied-text').textContent = copy[1];
  show('denied');
}

$('retry').addEventListener('click', openBooth);

// ---------- Mosh ----------

function setMosh(on) {
  if (on && !mosh) {
    try {
      mosh = new MoshRenderer(moshCanvas, video);
    } catch (error) {
      console.error(error);
      flashToast("Mosh isn't supported in this browser");
      return;
    }
  }
  moshOn = on;
  moshToggle.setAttribute('aria-pressed', String(on));
  moshCanvas.hidden = !on;
  if (on) mosh.start();
  else mosh?.stop();
}

moshToggle.addEventListener('click', () => setMosh(!moshOn));
// Tap to wipe the mosh and start from a clean picture.
moshCanvas.addEventListener('click', () => mosh?.reset());

// ---------- Shooting ----------

function setShooting(shooting) {
  isShooting = shooting;
  shutter.disabled = shooting;
  moshToggle.disabled = shooting;
}

function showCountdown(number) {
  countdownEl.textContent = number ?? '';
  countdownEl.classList.remove('pop');
  if (number != null) {
    void countdownEl.offsetWidth; // restart the animation
    countdownEl.classList.add('pop');
  }
}

function flashOn() {
  flash.style.transition = 'none';
  flash.style.opacity = '1';
}

function flashOff() {
  void flash.offsetWidth;
  flash.style.transition = 'opacity 0.4s ease-out';
  flash.style.opacity = '0';
}

function capturePhoto() {
  // When moshing, capture the datamoshed frame on screen instead.
  if (moshOn) {
    const moshed = mosh?.snapshot();
    if (moshed) return moshed;
  }
  return camera.capturePhoto();
}

/** Counts down 3-2-1, then takes four photos with a white flash for each. */
async function takePhotos() {
  if (isShooting) return;
  setShooting(true);
  const photos = [];
  try {
    for (const number of [3, 2, 1]) {
      showCountdown(number);
      await sleep(1000);
    }
    showCountdown(null);

    for (let number = 1; number <= PHOTO_COUNT; number++) {
      shotCounter.textContent = `${number} of ${PHOTO_COUNT}`;
      shotCounter.hidden = false;
      flashOn();
      const photo = capturePhoto();
      if (photo) photos.push(photo);
      flashOff();
      if (number < PHOTO_COUNT) await sleep(1000);
    }
  } finally {
    setShooting(false);
    shotCounter.hidden = true;
  }

  if (photos.length) await showResult(makeStrip(photos));
}

shutter.addEventListener('click', takePhotos);

// ---------- Result ----------

async function showResult(stripCanvas) {
  stripBlob = await new Promise((resolve) => stripCanvas.toBlob(resolve, 'image/png'));
  if (stripImg.src) URL.revokeObjectURL(stripImg.src);
  stripImg.src = URL.createObjectURL(stripBlob);
  $('share').hidden = !canShareFile();
  mosh?.stop();
  camera.stop();
  show('result');
}

function stripFile() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return new File([stripBlob], `filtercam-${stamp}.png`, { type: 'image/png' });
}

function canShareFile() {
  try {
    return !!navigator.canShare?.({ files: [stripFile()] });
  } catch {
    return false;
  }
}

$('retake').addEventListener('click', openBooth);

$('save').addEventListener('click', () => {
  const file = stripFile();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(file);
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  flashToast('Saved!');
});

$('share').addEventListener('click', async () => {
  try {
    await navigator.share({ files: [stripFile()], title: 'Photo Strip' });
  } catch (error) {
    if (error.name !== 'AbortError') flashToast("Couldn't share the photo strip");
  }
});

let toastTimer;
function flashToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2000);
}

// ---------- Start ----------

openBooth();
