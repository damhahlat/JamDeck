/* =========================
   Global audio + UI state
   ========================= */

let audioCtx = null;
let compressor = null;
let masterGain = null;
let isStarted = false;

const activeVoices = new Map(); // voiceId -> { nodes: [{src, gain, baseRate, kind}], meta }
let currentVelocity = 0.8;      // from FSR
let vibratoAmount = 0.0;        // 0..1 from accel
let vibratoHz = 6.0;            // vibrato speed
let vibratoTimer = null;
let vibratoPhase = 0;

let lastPlayed = { degree: null, note: null };

const UI = {
  keySelect: document.getElementById("keySelect"),
  modeSelect: document.getElementById("modeSelect"),
  playModeSelect: document.getElementById("playModeSelect"),
  instrumentSelect: document.getElementById("instrumentSelect"),
  degreeGrid: document.getElementById("degreeGrid"),

  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  detectBtn: document.getElementById("detectBtn"),

  status: document.getElementById("status"),
  activeKeyDisplay: document.getElementById("activeKeyDisplay"),
  detectedDisplay: document.getElementById("detectedDisplay"),
  notesHeard: document.getElementById("notesHeard"),
  liveInfo: document.getElementById("liveInfo"),

  wsDot: document.getElementById("wsDot"),
  wsStatus: document.getElementById("wsStatus"),
  lastMsg: document.getElementById("lastMsg"),
};

function setStatus(msg) {
  UI.status.textContent = msg;
}

function updateDetectButtonVisibility() {
  UI.detectBtn.classList.toggle("hidden", UI.keySelect.value !== "auto");
}

function setDetectLoading(isLoading) {
  UI.detectBtn.classList.toggle("loading", isLoading);
}

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

/* =========================
   Music theory mapping
   ========================= */

const NOTE_TO_PC = {
  "C": 0, "C#": 1, "Db": 1,
  "D": 2, "D#": 3, "Eb": 3,
  "E": 4, "Fb": 4, "E#": 5,
  "F": 5, "F#": 6, "Gb": 6,
  "G": 7, "G#": 8, "Ab": 8,
  "A": 9, "A#": 10, "Bb": 10,
  "B": 11, "Cb": 11, "B#": 0
};

const SCALE_INTERVALS = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10]
};

let detectedKey = { tonic: "C", mode: "major", confidence: 0 };

function getCurrentKeyMode() {
  if (UI.keySelect.value === "auto") return detectedKey;
  return { tonic: UI.keySelect.value, mode: UI.modeSelect.value, confidence: 1 };
}

function updateActiveKeyUI() {
  const km = getCurrentKeyMode();
  UI.activeKeyDisplay.textContent = `Active Key: ${km.tonic} ${km.mode}`;
}

function midiToNoteName(midi) {
  const pc = ((midi % 12) + 12) % 12;
  const names = ["C","C#","D","Eb","E","F","F#","G","Ab","A","Bb","B"];
  const oct = Math.floor(midi / 12) - 1;
  return `${names[pc]}${oct}`;
}

// degree supports 1..8
function degreeToMidi(degree) {
  const { tonic, mode } = getCurrentKeyMode();
  const tonicPc = NOTE_TO_PC[tonic];

  const d0 = degree - 1;
  const octaveShift = Math.floor(d0 / 7);
  const within = ((d0 % 7) + 7) % 7;
  const interval = SCALE_INTERVALS[mode][within];

  const inst = UI.instrumentSelect.value;

  // Pick a better base register per instrument
  // Guitar: around C3-C5
  // Flute: around C4-C6
  // Sine: middle-ish
  let baseOctave;
  let minMidi;
  let maxMidi;

  if (inst === "guitar") {
    baseOctave = 3; // C3
    minMidi = 43;   // about G2
    maxMidi = 72;   // C5
  } else if (inst === "flute") {
    baseOctave = 5; // C5
    minMidi = 60;   // C4
    maxMidi = 84;   // C6
  } else {
    baseOctave = 4; // C4
    minMidi = 48;   // C3
    maxMidi = 84;   // C6
  }

  let midi = (baseOctave * 12) + tonicPc + interval + 12 * octaveShift;

  while (midi < minMidi) midi += 12;
  while (midi > maxMidi) midi -= 12;

  return midi;
}


function degreeToMidiOffset(degree, offsetSteps) {
  const base = degreeToMidi(degree);
  let target = degreeToMidi(degree + offsetSteps);

  if (offsetSteps > 0) while (target <= base) target += 12;
  if (offsetSteps < 0) while (target >= base) target -= 12;

  return target;
}

/* =========================
   Sample engine: Flute (single notes)
   ========================= */

const FLUTE_FILES = [
  "Flute.vib.ff.A4.stereo.wav","Flute.vib.ff.A5.stereo.wav","Flute.vib.ff.A6.stereo.wav",
  "Flute.vib.ff.Ab4.stereo.wav","Flute.vib.ff.Ab5.stereo.wav","Flute.vib.ff.Ab6.stereo.wav",
  "Flute.vib.ff.B3.stereo.wav","Flute.vib.ff.B4.stereo.wav","Flute.vib.ff.B5.stereo.wav","Flute.vib.ff.B6.stereo.wav",
  "Flute.vib.ff.Bb4.stereo.wav","Flute.vib.ff.Bb5.stereo.wav","Flute.vib.ff.Bb6.stereo.wav",
  "Flute.vib.ff.C4.stereo.wav","Flute.vib.ff.C5.stereo.wav","Flute.vib.ff.C6.stereo.wav",
  "Flute.vib.ff.D4.stereo.wav","Flute.vib.ff.D5.stereo.wav","Flute.vib.ff.D6.stereo.wav",
  "Flute.vib.ff.Db4.stereo.wav","Flute.vib.ff.Db5.stereo.wav","Flute.vib.ff.Db6.stereo.wav","Flute.vib.ff.Db7.stereo.wav",
  "Flute.vib.ff.E4.stereo.wav","Flute.vib.ff.E5.stereo.wav","Flute.vib.ff.E6.stereo.wav",
  "Flute.vib.ff.Eb4.stereo.wav","Flute.vib.ff.Eb5.stereo.wav","Flute.vib.ff.Eb6.stereo.wav",
  "Flute.vib.ff.F4.stereo.wav","Flute.vib.ff.F5.stereo.wav","Flute.vib.ff.F6.stereo.wav",
  "Flute.vib.ff.G4.stereo.wav","Flute.vib.ff.G5.stereo.wav","Flute.vib.ff.G6.stereo.wav",
  "Flute.vib.ff.Gb4.stereo.wav","Flute.vib.ff.Gb5.stereo.wav","Flute.vib.ff.Gb6.stereo.wav"
];

function parseFluteNoteFromFilename(filename) {
  const m = String(filename).match(/\.([A-G])([#b]?)(\d)\./);
  if (!m) return null;
  return m[1] + (m[2] || "") + m[3];
}

function noteNameToMidi(note) {
  const m = String(note).match(/^([A-G])([#b]?)(\d)$/);
  if (!m) return null;
  const name = m[1] + (m[2] || "");
  const oct = parseInt(m[3], 10);
  const pc = NOTE_TO_PC[name];
  if (pc === undefined) return null;
  return (oct + 1) * 12 + pc;
}

let fluteSamples = []; // [{ midi, buffer }]
let fluteLoaded = false;

async function loadFluteSamples() {
  if (!audioCtx) return;
  if (fluteLoaded) return;

  setStatus("Loading flute samples...");
  const loaded = [];

  for (const file of FLUTE_FILES) {
    const note = parseFluteNoteFromFilename(file);
    const midi = noteNameToMidi(note);
    if (midi === null) continue;

    const url = `/static/samples/flute/${file}`;
    const resp = await fetch(url);
    if (!resp.ok) continue;

    const arrayBuf = await resp.arrayBuffer();
    const buffer = await audioCtx.decodeAudioData(arrayBuf);
    loaded.push({ midi, buffer, file });
  }

  loaded.sort((a, b) => a.midi - b.midi);
  fluteSamples = loaded;
  fluteLoaded = true;

  setStatus(`Audio running. Loaded ${fluteSamples.length} flute samples.`);
}

function findNearestFluteSample(targetMidi) {
  if (!fluteSamples.length) return null;

  let best = fluteSamples[0];
  let bestDist = Math.abs(best.midi - targetMidi);

  for (let i = 1; i < fluteSamples.length; i++) {
    const s = fluteSamples[i];
    const d = Math.abs(s.midi - targetMidi);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

/* =========================
   Sample engine: Guitar (range recordings)
   Assumption: file represents a chromatic run from startNote to endNote.
   We "seek" into the buffer based on target note index and play a short segment.
   ========================= */

// IMPORTANT: Put your guitar files here.
// If you add more, just append them to this list.
const GUITAR_FILES = [
  "Guitar.ff.sul_E.C5Bb5.wav",
  "Guitar.ff.sul_E.E4B4.wav",
  "Guitar.ff.sulA.A2B2.wav",
  "Guitar.ff.sulA.C3B3.wav",
  "Guitar.ff.sulA.C4E4.wav",
  "Guitar.ff.sulB.B3.wav",          // if this exists as single note, it will work too
  "Guitar.ff.sulB.C4B4.wav",
  "Guitar.ff.sulB.C5Gb5.wav",
  "Guitar.ff.sulD.C4Ab4.wav",
  "Guitar.ff.sulD.D3B3.wav",
  "Guitar.ff.sulE.C3B3.wav",
  "Guitar.ff.sulE.E2B2.wav",
  "Guitar.ff.sulG.C4B4.wav",
  "Guitar.ff.sulG.C5Db5.wav",
  "Guitar.ff.sulG.G3B3.wav",

  "Guitar.mf.sul_E.C5Bb5.wav",
  "Guitar.mf.sul_E.E4B4.wav",
  "Guitar.mf.sulA.A2B2.wav",
  "Guitar.mf.sulA.C3B3.wav",
  "Guitar.mf.sulA.C4E4.wav"
];

// Parses either:
// - Range form: "...<StartNote><EndNote>.wav" eg C3B3, C4Ab4, C5Bb5
// - Single note form: "...<Note>.wav" eg B3
function parseGuitarRangeFromFilename(filename) {
  const base = filename.replace(/^.*\./, "").replace(/\.wav$/i, "");

  // Try range: StartNote + EndNote
  // Examples: C5Bb5, C4Ab4, A2B2, C5Db5
  const mRange = filename.match(/\.([A-G])([#b]?)(\d)([A-G])([#b]?)(\d)\.wav$/i);
  if (mRange) {
    const start = mRange[1] + (mRange[2] || "") + mRange[3];
    const end = mRange[4] + (mRange[5] || "") + mRange[6];
    const startMidi = noteNameToMidi(start);
    const endMidi = noteNameToMidi(end);
    if (startMidi === null || endMidi === null) return null;
    return { startMidi, endMidi, isRange: true };
  }

  // Try single note: ".B3.wav"
  const mSingle = filename.match(/\.([A-G])([#b]?)(\d)\.wav$/i);
  if (mSingle) {
    const note = mSingle[1] + (mSingle[2] || "") + mSingle[3];
    const midi = noteNameToMidi(note);
    if (midi === null) return null;
    return { startMidi: midi, endMidi: midi, isRange: false };
  }

  return null;
}

let guitarSamples = []; // [{ startMidi, endMidi, buffer, file, isRange }]
let guitarLoaded = false;

async function loadGuitarSamples() {
  if (!audioCtx) return;
  if (guitarLoaded) return;

  setStatus("Loading guitar samples...");
  const loaded = [];

  for (const file of GUITAR_FILES) {
    const info = parseGuitarRangeFromFilename(file);
    if (!info) continue;

    const url = `/static/samples/guitar/${file}`;
    const resp = await fetch(url);
    if (!resp.ok) continue;

    const arrayBuf = await resp.arrayBuffer();
    const buffer = await audioCtx.decodeAudioData(arrayBuf);

    loaded.push({
      startMidi: Math.min(info.startMidi, info.endMidi),
      endMidi: Math.max(info.startMidi, info.endMidi),
      isRange: info.isRange,
      buffer,
      file
    });
  }

  guitarSamples = loaded;
  guitarLoaded = true;

  setStatus(`Audio running. Loaded ${guitarSamples.length} guitar samples.`);
}

function findBestGuitarSample(targetMidi) {
  if (!guitarSamples.length) return null;

  // Prefer a sample whose range contains targetMidi.
  const containing = guitarSamples.filter(s => targetMidi >= s.startMidi && targetMidi <= s.endMidi);
  if (containing.length) {
    // choose the tightest range (more precise)
    containing.sort((a, b) => (a.endMidi - a.startMidi) - (b.endMidi - b.startMidi));
    return containing[0];
  }

  // Else choose closest by range midpoint
  let best = guitarSamples[0];
  let bestDist = Math.abs(((best.startMidi + best.endMidi) / 2) - targetMidi);

  for (let i = 1; i < guitarSamples.length; i++) {
    const s = guitarSamples[i];
    const mid = (s.startMidi + s.endMidi) / 2;
    const d = Math.abs(mid - targetMidi);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }

  return best;
}

/* =========================
   Audio primitives
   ========================= */

function ensureAudioStarted() {
  if (!audioCtx || !isStarted) {
    setStatus("Start Audio first.");
    return false;
  }
  return true;
}

function connectToOutput(node) {
  node.connect(masterGain);
}

function setMasterFromVelocity(v) {
  currentVelocity = clamp(v, 0.0, 1.0);
  if (masterGain && audioCtx) {
    const now = audioCtx.currentTime;
    const target = 0.15 + 0.85 * currentVelocity;
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setValueAtTime(masterGain.gain.value, now);
    masterGain.gain.linearRampToValueAtTime(target, now + 0.03);
  }
}

function playSineOneShot(midi, { when, duration, velocity }) {
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();

  osc.type = "sine";
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  osc.frequency.setValueAtTime(freq, when);

  g.gain.setValueAtTime(0.0001, when);
  g.gain.linearRampToValueAtTime(clamp(velocity, 0.0001, 1.0), when + 0.01);
  g.gain.linearRampToValueAtTime(0.0001, when + duration);

  osc.connect(g);
  connectToOutput(g);

  osc.start(when);
  osc.stop(when + duration + 0.03);
}

// Flute one-shot: nearest single-note sample + pitch shift
function playFluteOneShot(midi, {
  when = audioCtx.currentTime,
  duration = 0.6,
  velocity = 0.9
} = {}) {
  const sample = findNearestFluteSample(midi);
  if (!sample) return;

  const src = audioCtx.createBufferSource();
  src.buffer = sample.buffer;

  const baseRate = Math.pow(2, (midi - sample.midi) / 12);
  src.playbackRate.value = baseRate;

  const g = audioCtx.createGain();
  const a = 0.01;
  const r = 0.08;
  const peak = clamp(velocity, 0.0001, 1.0);

  g.gain.setValueAtTime(0.0001, when);
  g.gain.linearRampToValueAtTime(peak, when + a);
  g.gain.setValueAtTime(peak, when + Math.max(a, duration - r));
  g.gain.linearRampToValueAtTime(0.0001, when + duration);

  src.connect(g);
  connectToOutput(g);

  src.start(when);
  src.stop(when + duration + 0.03);
}

// Guitar one-shot: seek into range recording and play a short slice
function playGuitarOneShot(targetMidi, {
  when = audioCtx.currentTime,
  velocity = 0.9
} = {}) {
  const sample = findBestGuitarSample(targetMidi);
  if (!sample) return;

  const src = audioCtx.createBufferSource();
  src.buffer = sample.buffer;

  // If it is a single note file, just play from start
  let offset = 0.0;
  let sliceDur = 0.75;

  if (sample.isRange && sample.endMidi > sample.startMidi) {
    const semis = (sample.endMidi - sample.startMidi) + 1;
    const seg = sample.buffer.duration / semis;

    const idx = clamp(targetMidi - sample.startMidi, 0, semis - 1);
    offset = idx * seg;

    // Slice duration: about 1.4 segments, clamped
    sliceDur = clamp(seg * 1.4, 0.12, 0.9);
  }

  const g = audioCtx.createGain();

  // Guitar-style envelope: fast attack, longer decay
  const a = 0.006;
  const d = 0.45;
  const peak = clamp(velocity, 0.05, 1.0);

  g.gain.setValueAtTime(0.0001, when);
  g.gain.linearRampToValueAtTime(peak, when + a);
  g.gain.exponentialRampToValueAtTime(0.0001, when + a + d);

  src.connect(g);
  connectToOutput(g);

  src.start(when, offset, sliceDur);
  src.stop(when + a + d + 0.08);
}

function playNoteMidiOneShot(midi, opts) {
  if (!ensureAudioStarted()) return;
  const inst = UI.instrumentSelect.value;

  if (inst === "flute") {
    playFluteOneShot(midi, opts);
    return;
  }

  if (inst === "guitar") {
    playGuitarOneShot(midi, opts);
    return;
  }

  playSineOneShot(midi, opts);
}

/* =========================
   Vibrato (applies to active looped voices only)
   Guitar is one-shot so vibrato is not applied to it.
   ========================= */

function setVibratoAmount(amount) {
  vibratoAmount = clamp(amount, 0.0, 1.0);
}

function startVibratoLoop() {
  if (vibratoTimer) return;
  vibratoPhase = 0;

  vibratoTimer = setInterval(() => {
    if (!audioCtx) return;

    const dt = 0.02;
    vibratoPhase += 2 * Math.PI * vibratoHz * dt;

    const depthCents = 25 * vibratoAmount;
    const cents = depthCents * Math.sin(vibratoPhase);
    const ratio = Math.pow(2, cents / 1200);

    for (const voice of activeVoices.values()) {
      for (const n of voice.nodes) {
        if (n.kind === "sample" && n.baseRate !== null) {
          n.src.playbackRate.value = n.baseRate * ratio;
        }
        if (n.kind === "osc" && n.baseFreq) {
          n.src.frequency.value = n.baseFreq * ratio;
        }
      }
    }
  }, 20);
}

function stopVibratoLoop() {
  if (!vibratoTimer) return;
  clearInterval(vibratoTimer);
  vibratoTimer = null;
}

/* =========================
   Modes: single / chord / arp
   - For guitar: treat everything as one-shot plucks (no sustain).
   ========================= */

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startSingle(degree, velocity) {
  const midi = degreeToMidi(degree);

  if (UI.instrumentSelect.value === "guitar") {
    playNoteMidiOneShot(midi, { when: audioCtx.currentTime, duration: 0.75, velocity });
    return { midi, note: midiToNoteName(midi) };
  }

  // flute/sine sustained behavior
  startSustainedMidiForNonGuitar(midi, `single-${degree}`, velocity);
  return { midi, note: midiToNoteName(midi) };
}

function stopSingle(degree) {
  if (UI.instrumentSelect.value === "guitar") return;
  stopVoice(`single-${degree}`);
}

function startChord(degree, velocity) {
  const root = degreeToMidi(degree);
  let third = degreeToMidiOffset(degree, 2);
  let fifth = degreeToMidiOffset(degree, 4);
    if (UI.instrumentSelect.value === "guitar") {
        root -= 12;
        third -= 12;
        fifth -= 12;
    }

  if (third - root < 4) third += 12;

  const chordNotes = [root, third, fifth];

  if (UI.instrumentSelect.value === "guitar") {
    const now = audioCtx.currentTime;
    const per = clamp(velocity * 0.65, 0.05, 1.0);
    for (const m of chordNotes) {
      playNoteMidiOneShot(m, { when: now, duration: 0.8, velocity: per });
    }
    return { midi: root, note: midiToNoteName(root) };
  }

  // flute/sine sustained chord
  return startSustainedChordForNonGuitar(degree, chordNotes, velocity);
}

function stopChord(degree) {
  if (UI.instrumentSelect.value === "guitar") return;
  stopVoice(`chord-${degree}`);
}

function triggerArp(degree, velocity) {
  const root = degreeToMidi(degree);
  let third = degreeToMidiOffset(degree, 2);
  let fifth = degreeToMidiOffset(degree, 4);
  if (third - root < 4) third += 12;

  const chord = [root, third, fifth];

  const step = 0.12;
  const now = audioCtx.currentTime;

  let t = now;
  for (let r = 0; r < 2; r++) {
    const pass = shuffleArray(chord);
    for (const m of pass) {
      playNoteMidiOneShot(m, {
        when: t,
        duration: step * 2.6,
        velocity: clamp(velocity, 0.05, 1.0)
      });
      t += step;
    }
  }

  return { midi: root, note: midiToNoteName(root) };
}

/* =========================
   Sustained implementation for flute/sine only
   ========================= */

function startSustainedMidiForNonGuitar(midi, voiceId, velocity = 0.75) {
  if (!ensureAudioStarted()) return;
  if (activeVoices.has(voiceId)) return;

  const inst = UI.instrumentSelect.value;
  const now = audioCtx.currentTime;

  if (inst === "sine") {
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();

    osc.type = "sine";
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    osc.frequency.setValueAtTime(freq, now);

    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(clamp(velocity, 0.0001, 1.0), now + 0.02);

    osc.connect(g);
    connectToOutput(g);
    osc.start(now);

    activeVoices.set(voiceId, {
      nodes: [{ src: osc, gain: g, baseRate: null, kind: "osc", baseFreq: freq }]
    });
    return;
  }

  // flute
  const sample = findNearestFluteSample(midi);
  if (!sample) return;

  const src = audioCtx.createBufferSource();
  src.buffer = sample.buffer;
  src.loop = true;

  const baseRate = Math.pow(2, (midi - sample.midi) / 12);
  src.playbackRate.value = baseRate;

  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.linearRampToValueAtTime(clamp(velocity, 0.0001, 1.0), now + 0.02);

  src.connect(g);
  connectToOutput(g);
  src.start(now);

  activeVoices.set(voiceId, {
    nodes: [{ src, gain: g, baseRate, kind: "sample" }]
  });
}

function startSustainedChordForNonGuitar(degree, chordNotes, velocity) {
  const voiceId = `chord-${degree}`;
  if (activeVoices.has(voiceId)) return { midi: chordNotes[0], note: midiToNoteName(chordNotes[0]) };

  const inst = UI.instrumentSelect.value;
  const now = audioCtx.currentTime;
  const perNoteVel = clamp(velocity * 0.65, 0.05, 0.9);

  const nodes = [];

  if (inst === "sine") {
    for (const m of chordNotes) {
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();

      osc.type = "sine";
      const freq = 440 * Math.pow(2, (m - 69) / 12);
      osc.frequency.setValueAtTime(freq, now);

      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(perNoteVel, now + 0.02);

      osc.connect(g);
      connectToOutput(g);
      osc.start(now);

      nodes.push({ src: osc, gain: g, baseRate: null, kind: "osc", baseFreq: freq });
    }

    activeVoices.set(voiceId, { nodes });
    return { midi: chordNotes[0], note: midiToNoteName(chordNotes[0]) };
  }

  // flute sustained chord
  for (const m of chordNotes) {
    const sample = findNearestFluteSample(m);
    if (!sample) continue;

    const src = audioCtx.createBufferSource();
    src.buffer = sample.buffer;
    src.loop = true;

    const baseRate = Math.pow(2, (m - sample.midi) / 12);
    src.playbackRate.value = baseRate;

    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(perNoteVel, now + 0.02);

    src.connect(g);
    connectToOutput(g);
    src.start(now);

    nodes.push({ src, gain: g, baseRate, kind: "sample" });
  }

  activeVoices.set(voiceId, { nodes });
  return { midi: chordNotes[0], note: midiToNoteName(chordNotes[0]) };
}

function stopVoice(voiceId) {
  if (!audioCtx) return;
  const voice = activeVoices.get(voiceId);
  if (!voice) return;

  const now = audioCtx.currentTime;

  for (const n of voice.nodes) {
    try {
      n.gain.gain.cancelScheduledValues(now);
      n.gain.gain.setValueAtTime(Math.max(n.gain.gain.value, 0.0001), now);
      n.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    } catch (e) {}

    try {
      n.src.stop(now + 0.22);
    } catch (e) {}
  }

  activeVoices.delete(voiceId);
}

function stopAllVoices() {
  for (const id of Array.from(activeVoices.keys())) stopVoice(id);
  activeVoices.clear();
}

/* =========================
   Audio start/stop
   ========================= */

async function startAudio() {
  if (isStarted) return;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.resume();

  // ---- Master + Compression chain ----
  // masterGain -> compressor -> destination

  masterGain = audioCtx.createGain();

  // Louder default volume (was 0.7 before)
  masterGain.gain.value = 1.35;   // Try 1.35 if you want slightly louder

  compressor = audioCtx.createDynamicsCompressor();

  // Tuned for clean loud output (hackathon friendly)
  compressor.threshold.value = -12;
  compressor.knee.value = 30;
  compressor.ratio.value = 6;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;

  masterGain.connect(compressor);
  compressor.connect(audioCtx.destination);

  // -------------------------------------

  isStarted = true;

  startVibratoLoop();

  const inst = UI.instrumentSelect.value;

  try {
    if (inst === "flute") await loadFluteSamples();
    if (inst === "guitar") await loadGuitarSamples();
  } catch (e) {
    console.error(e);
    setStatus("Audio running, but sample load failed.");
  }

  updateDetectButtonVisibility();
  updateActiveKeyUI();
  setStatus("Audio running.");
}

function stopAudio() {
  if (!audioCtx) return;

  stopAllVoices();
  stopVibratoLoop();

  audioCtx.close();
  audioCtx = null;
  compressor = null;
  masterGain = null;
  isStarted = false;

  fluteLoaded = false;
  fluteSamples = [];
  guitarLoaded = false;
  guitarSamples = [];

  setStatus("Audio stopped.");
}

/* =========================
   UI helpers + display update back to ESP32
   ========================= */

function updateLiveInfo() {
  const deg = lastPlayed.degree ?? "-";
  const note = lastPlayed.note ?? "-";
  const vel = isFinite(currentVelocity) ? currentVelocity.toFixed(2) : "-";
  const vib = isFinite(vibratoAmount) ? vibratoAmount.toFixed(2) : "-";
  UI.liveInfo.textContent = `Degree: ${deg} | Note: ${note} | Velocity: ${vel} | Vibrato: ${vib}`;
}

async function sendDisplayUpdateToBackend({ line1, line2 }) {
  try {
    await fetch("/display_update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line1, line2 })
    });
  } catch (e) {}
}

function buildDisplayLines(degree, noteName) {
  const playMode = UI.playModeSelect.value;
  const km = getCurrentKeyMode();
  const line1 = `Mode: ${playMode} Key: ${km.tonic} ${km.mode}`;
  const line2 = `Deg ${degree} -> ${noteName}`;
  return { line1, line2 };
}

function applyFlexCycleMode() {
  const order = ["single", "arp", "chord"];
  const cur = UI.playModeSelect.value;
  const idx = order.indexOf(cur);
  const next = order[(idx + 1) % order.length];
  UI.playModeSelect.value = next;

  sendDisplayUpdateToBackend({
    line1: `Mode: ${next} Key: ${getCurrentKeyMode().tonic} ${getCurrentKeyMode().mode}`,
    line2: `Ready`
  });
}

/* =========================
   Manual (mouse/keyboard) degree input
   ========================= */

function handleDegreeDown(degree, velocity = currentVelocity) {
  if (!ensureAudioStarted()) return;

  setMasterFromVelocity(velocity);

  const playMode = UI.playModeSelect.value;
  let result = null;

  if (playMode === "single") result = startSingle(degree, velocity);
  if (playMode === "chord") result = startChord(degree, velocity);
  if (playMode === "arp") result = triggerArp(degree, velocity);

  if (result) {
    lastPlayed = { degree, note: result.note };
    updateLiveInfo();
    sendDisplayUpdateToBackend(buildDisplayLines(degree, result.note));
  }
}

function handleDegreeUp(degree) {
  const playMode = UI.playModeSelect.value;
  if (playMode === "single") stopSingle(degree);
  if (playMode === "chord") stopChord(degree);
  // arp does nothing on release
}

UI.degreeGrid.addEventListener("mousedown", (e) => {
  const btn = e.target.closest(".deg");
  if (!btn) return;
  handleDegreeDown(parseInt(btn.dataset.degree, 10));
});
UI.degreeGrid.addEventListener("mouseup", (e) => {
  const btn = e.target.closest(".deg");
  if (!btn) return;
  handleDegreeUp(parseInt(btn.dataset.degree, 10));
});
UI.degreeGrid.addEventListener("mouseleave", () => stopAllVoices());

window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (e.key >= "1" && e.key <= "8") handleDegreeDown(parseInt(e.key, 10));
});
window.addEventListener("keyup", (e) => {
  if (e.key >= "1" && e.key <= "8") handleDegreeUp(parseInt(e.key, 10));
});

/* =========================
   Auto key detection (unchanged)
   ========================= */

function mergeFloat32(buffers) {
  let total = 0;
  for (const b of buffers) total += b.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const b of buffers) {
    out.set(b, offset);
    offset += b.length;
  }
  return out;
}

function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return out;
}

function encodeWavMono(samplesFloat32, sampleRate) {
  const pcm16 = floatTo16BitPCM(samplesFloat32);
  const byteRate = sampleRate * 2;
  const blockAlign = 2;

  const buffer = new ArrayBuffer(44 + pcm16.length * 2);
  const view = new DataView(buffer);

  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + pcm16.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, pcm16.length * 2, true);

  let offset = 44;
  for (let i = 0; i < pcm16.length; i++, offset += 2) {
    view.setInt16(offset, pcm16[i], true);
  }

  return new Blob([view], { type: "audio/wav" });
}

async function record5sWavFromMic(updateStatus) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  });

  const ctx = audioCtx;
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);

  const sink = ctx.createGain();
  sink.gain.value = 0.0;
  sink.connect(ctx.destination);

  const chunks = [];
  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
  };

  source.connect(processor);
  processor.connect(sink);

  const start = performance.now();
  while (performance.now() - start < 5000) {
    const leftMs = Math.max(0, 5000 - (performance.now() - start));
    const secs = Math.ceil(leftMs / 1000);
    updateStatus(secs);
    await new Promise((r) => setTimeout(r, 150));
  }

  source.disconnect();
  processor.disconnect();
  stream.getTracks().forEach((t) => t.stop());

  const merged = mergeFloat32(chunks);
  return encodeWavMono(merged, ctx.sampleRate);
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function detectKeyFromMic() {
  if (!ensureAudioStarted()) return;
  if (UI.keySelect.value !== "auto") {
    setStatus("Set Key to Auto to use detection.");
    return;
  }

  setDetectLoading(true);
  UI.notesHeard.textContent = "-";
  UI.detectedDisplay.textContent = "Last Detected Key: -";

  try {
    setStatus("Recording... (5s)");
    const wavBlob = await record5sWavFromMic((secsLeft) => setStatus(`Recording... ${secsLeft}s`));

    setStatus("Uploading...");
    const form = new FormData();
    form.append("audio", wavBlob, "clip.wav");

    setStatus("Analyzing...");
    const resp = await fetchWithTimeout("/detect_key", { method: "POST", body: form }, 45000);
    if (!resp.ok) {
      setStatus(`Server error: ${resp.status}`);
      return;
    }

    const data = await resp.json();
    if (!data.ok) {
      setStatus(data.error || "Key detection failed.");
      return;
    }

    detectedKey = {
      tonic: data.tonic,
      mode: data.mode,
      confidence: typeof data.confidence === "number" ? data.confidence : Number(data.confidence || 0)
    };

    UI.keySelect.value = data.tonic;
    UI.modeSelect.value = data.mode;

    updateDetectButtonVisibility();
    updateActiveKeyUI();

    const conf = Number(detectedKey.confidence);
    UI.detectedDisplay.textContent = `Last Detected Key: ${data.tonic} ${data.mode} (conf ${isFinite(conf) ? conf.toFixed(2) : "-"})`;

    const heard = Array.isArray(data.notes_heard) ? data.notes_heard : [];
    UI.notesHeard.textContent = heard.length ? heard.join("  ") : "-";

    setStatus(`Detected: ${data.tonic} ${data.mode}`);

    sendDisplayUpdateToBackend({
      line1: `Key: ${data.tonic} ${data.mode}`,
      line2: `Detected`
    });
  } catch (e) {
    if (String(e).includes("AbortError")) setStatus("Timed out.");
    else setStatus("Detect failed. Check mic permission.");
  } finally {
    setDetectLoading(false);
  }
}

/* =========================
   Controller integration (WebSocket)
   ========================= */

let ws = null;
let wsReconnectTimer = null;

function setWsUI(connected, text) {
  UI.wsDot.classList.toggle("good", connected);
  UI.wsStatus.textContent = text;
}

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

function connectWebSocket() {
  if (ws) {
    try { ws.close(); } catch (e) {}
    ws = null;
  }

  setWsUI(false, "Controller: connecting...");

  ws = new WebSocket(wsUrl());

  ws.onopen = () => {
    setWsUI(true, "Controller: connected");
    UI.lastMsg.textContent = "Last event: connected";
  };

  ws.onclose = () => {
    setWsUI(false, "Controller: disconnected");
    UI.lastMsg.textContent = "Last event: disconnected";
    scheduleReconnect();
  };

  ws.onerror = () => {
    setWsUI(false, "Controller: error");
  };

  ws.onmessage = (ev) => {
    UI.lastMsg.textContent = `Last event: ${String(ev.data).slice(0, 120)}`;

    let msg = null;
    try { msg = JSON.parse(ev.data); }
    catch (e) { return; }

    handleControllerMessage(msg);
  };
}

function scheduleReconnect() {
  if (wsReconnectTimer) return;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWebSocket();
  }, 1200);
}

function handleControllerMessage(msg) {
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "note_on") {
    const degree = Number(msg.degree);
    const vel = clamp(Number(msg.velocity ?? currentVelocity), 0, 1);
    if (!Number.isFinite(degree)) return;
    handleDegreeDown(degree, vel);
    return;
  }

  if (msg.type === "note_off") {
    const degree = Number(msg.degree);
    if (!Number.isFinite(degree)) return;
    handleDegreeUp(degree);
    return;
  }

  if (msg.type === "vibrato") {
    const amt = clamp(Number(msg.amount), 0, 1);
    if (!Number.isFinite(amt)) return;
    setVibratoAmount(amt);
    updateLiveInfo();
    return;
  }

  if (msg.type === "flex" && msg.action === "cycle_mode") {
    applyFlexCycleMode();
    return;
  }

  if (msg.type === "mode_cycle") {
    applyFlexCycleMode();
    return;
  }

  if (msg.type === "state") {
    if (typeof msg.play_mode === "string") UI.playModeSelect.value = msg.play_mode;
    if (typeof msg.key === "string") UI.keySelect.value = msg.key;
    if (typeof msg.scale_mode === "string") UI.modeSelect.value = msg.scale_mode;
    updateDetectButtonVisibility();
    updateActiveKeyUI();
    return;
  }
}

/* =========================
   Wire UI
   ========================= */

UI.startBtn.addEventListener("click", startAudio);
UI.stopBtn.addEventListener("click", stopAudio);
UI.detectBtn.addEventListener("click", detectKeyFromMic);

UI.keySelect.addEventListener("change", () => {
  updateDetectButtonVisibility();
  updateActiveKeyUI();
  sendDisplayUpdateToBackend({
    line1: `Key: ${getCurrentKeyMode().tonic} ${getCurrentKeyMode().mode}`,
    line2: `Ready`
  });
});

UI.modeSelect.addEventListener("change", () => {
  updateActiveKeyUI();
  sendDisplayUpdateToBackend({
    line1: `Key: ${getCurrentKeyMode().tonic} ${getCurrentKeyMode().mode}`,
    line2: `Ready`
  });
});

UI.playModeSelect.addEventListener("change", () => {
  sendDisplayUpdateToBackend({
    line1: `Mode: ${UI.playModeSelect.value}`,
    line2: `Ready`
  });
});

UI.instrumentSelect.addEventListener("change", async () => {
  if (!isStarted) return;
  try {
    if (UI.instrumentSelect.value === "flute") await loadFluteSamples();
    if (UI.instrumentSelect.value === "guitar") await loadGuitarSamples();
  } catch (e) {}
});

updateDetectButtonVisibility();
updateActiveKeyUI();
updateLiveInfo();
connectWebSocket();
