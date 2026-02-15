/* =========================
   Global audio + UI state
   ========================= */

let audioCtx = null;
let compressor = null;
let masterGain = null;
let isStarted = false;

const activeVoices = new Map(); // voiceId -> { nodes: [{ src, gain, baseRate, kind, baseFreq? }] }

let currentVelocity = 0.85; // updated by ESP32 FSR
let vibratoAmount = 0.0;    // updated by ESP32 accel, [0..1]
let vibratoHz = 6.0;        // LFO rate
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
  lastMsg: document.getElementById("lastMsg")
};

/* =========================
   Utility helpers
   ========================= */

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function ensureAudioStarted() {
  if (!audioCtx || !isStarted) {
    setStatus("Click Start Audio first.");
    return false;
  }
  return true;
}

function setStatus(msg) {
  if (UI.status) UI.status.textContent = msg;
}

function connectToOutput(node) {
  if (!masterGain) return;
  node.connect(masterGain);
}

/* =========================
   Musical mapping
   ========================= */

const NOTE_TO_PC = {
  "C": 0, "C#": 1, "Db": 1,
  "D": 2, "D#": 3, "Eb": 3,
  "E": 4,
  "F": 5, "F#": 6, "Gb": 6,
  "G": 7, "G#": 8, "Ab": 8,
  "A": 9, "A#": 10, "Bb": 10,
  "B": 11
};

const PC_TO_NOTE_FLAT = ["C","Db","D","Eb","E","F","Gb","G","Ab","A","Bb","B"];

const SCALE_INTERVALS = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10]
};

function getCurrentKeyMode() {
  const tonicRaw = UI.keySelect.value;
  const mode = UI.modeSelect.value;

  if (tonicRaw === "auto") {
    return {
      tonic: autoKey.tonic ?? "C",
      mode: autoKey.mode ?? "major"
    };
  }

  return { tonic: tonicRaw, mode };
}

function degreeToMidi(degree) {
  const km = getCurrentKeyMode();
  const tonicPc = NOTE_TO_PC[km.tonic] ?? 0;
  const intervals = SCALE_INTERVALS[km.mode] ?? SCALE_INTERVALS.major;

  const deg = clamp(degree, 1, 8);
  const within = (deg - 1) % 7;
  const octShift = deg === 8 ? 12 : 0;

  // base octave anchor (C4 = MIDI 60)
  const base = 60 + tonicPc;

  return base + intervals[within] + octShift;
}

function degreeToMidiOffset(degree, offsetSteps) {
  const km = getCurrentKeyMode();
  const tonicPc = NOTE_TO_PC[km.tonic] ?? 0;
  const intervals = SCALE_INTERVALS[km.mode] ?? SCALE_INTERVALS.major;

  const idx = (degree - 1 + offsetSteps) % 7;
  let oct = Math.floor((degree - 1 + offsetSteps) / 7) * 12;

  const base = 60 + tonicPc;
  return base + intervals[idx] + oct;
}

function midiToNoteName(midi) {
  const pc = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  return `${PC_TO_NOTE_FLAT[pc]}${oct}`;
}

function noteNameToMidi(note) {
  const m = note.match(/^([A-G])([b#]?)(-?\d+)$/);
  if (!m) return null;
  const name = m[1] + (m[2] || "");
  const oct = parseInt(m[3], 10);
  const pc = NOTE_TO_PC[name];
  if (pc === undefined) return null;
  return (oct + 1) * 12 + pc;
}

/* =========================
   Samples: file lists
   ========================= */

const GUITAR_FILES = [
  "Guitar.pluck.ff.C3toE3.stereo.wav",
  "Guitar.pluck.ff.F3toA3.stereo.wav",
  "Guitar.pluck.ff.Bb3toDb4.stereo.wav",
  "Guitar.pluck.ff.E4toG4.stereo.wav",
  "Guitar.pluck.ff.Ab4toB4.stereo.wav",
  "Guitar.pluck.ff.C5toE5.stereo.wav"
];

/* =========================
   Violin samples (arco)
   Looks for: /static/samples/violin/Violin.arco.ff.sulA.<NOTE><OCT>.stereo.wav
   Example: Violin.arco.ff.sulA.Ab4.stereo.wav
   ========================= */

const VIOLIN_NOTE_NAMES = ["C","Db","D","Eb","E","F","Gb","G","Ab","A","Bb","B"];
const VIOLIN_OCTAVES = [3,4,5,6];

function buildViolinCandidateFiles() {
  const files = [];
  for (const oct of VIOLIN_OCTAVES) {
    for (const n of VIOLIN_NOTE_NAMES) {
      files.push(`Violin.arco.ff.sulA.${n}${oct}.stereo.wav`);
    }
  }
  return files;
}

function parseViolinNoteFromFilename(file) {
  // Violin.arco.ff.sulA.Ab4.stereo.wav -> "Ab4"
  const m = file.match(/\.([A-G](?:b|#)?)(\d)\.stereo\.wav$/);
  if (!m) return null;
  return `${m[1]}${m[2]}`;
}

let violinSamples = []; // [{ midi, buffer }]
let violinLoaded = false;

async function loadViolinSamples() {
  if (!audioCtx) return;
  if (violinLoaded) return;

  setStatus("Loading violin samples...");
  const loaded = [];

  const candidates = buildViolinCandidateFiles();

  for (const file of candidates) {
    const note = parseViolinNoteFromFilename(file);
    const midi = noteNameToMidi(note);
    if (midi === null) continue;

    const url = `/static/samples/violin/${file}`;
    let resp;
    try {
      resp = await fetch(url);
    } catch (e) {
      continue;
    }
    if (!resp.ok) continue;

    const arrayBuf = await resp.arrayBuffer();
    const buffer = await audioCtx.decodeAudioData(arrayBuf);

    loaded.push({ midi, buffer });
  }

  violinSamples = loaded.sort((a, b) => a.midi - b.midi);
  violinLoaded = true;

  setStatus(`Audio running. Loaded ${violinSamples.length} violin samples.`);
}

function findNearestViolinSample(targetMidi) {
  if (!violinSamples.length) return null;
  let best = violinSamples[0];
  let bestDist = Math.abs(targetMidi - best.midi);
  for (const s of violinSamples) {
    const d = Math.abs(targetMidi - s.midi);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

function playViolinOneShot(midi, {
  when = audioCtx.currentTime,
  duration = 0.7,
  velocity = 0.9
} = {}) {
  const sample = findNearestViolinSample(midi);
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

function parseFluteNoteFromFilename(file) {
  // Flute.vib.ff.Ab4.stereo.wav -> "Ab4"
  const m = file.match(/\.([A-G](?:b|#)?)(-?\d)\.stereo\.wav$/);
  if (!m) return null;
  return `${m[1]}${m[2]}`;
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

    loaded.push({ midi, buffer });
  }

  fluteSamples = loaded.sort((a, b) => a.midi - b.midi);
  fluteLoaded = true;

  setStatus(`Audio running. Loaded ${fluteSamples.length} flute samples.`);
}

function findNearestFluteSample(targetMidi) {
  if (!fluteSamples.length) return null;

  let best = fluteSamples[0];
  let bestDist = Math.abs(targetMidi - best.midi);

  for (const s of fluteSamples) {
    const d = Math.abs(targetMidi - s.midi);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

let guitarSamples = []; // [{ startMidi, endMidi, isRange, buffer, file }]
let guitarLoaded = false;

function parseGuitarRangeFromFilename(file) {
  // Guitar.pluck.ff.C3toE3.stereo.wav
  const m = file.match(/\.([A-G](?:b|#)?)(-?\d)to([A-G](?:b|#)?)(-?\d)\.stereo\.wav$/);
  if (!m) return null;

  const n1 = `${m[1]}${m[2]}`;
  const n2 = `${m[3]}${m[4]}`;
  const midi1 = noteNameToMidi(n1);
  const midi2 = noteNameToMidi(n2);

  if (midi1 === null || midi2 === null) return null;

  return {
    startMidi: midi1,
    endMidi: midi2,
    isRange: true
  };
}

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

  // Prefer samples whose recorded range contains the target
  const containing = guitarSamples.filter(s => targetMidi >= s.startMidi && targetMidi <= s.endMidi);
  if (containing.length) {
    // pick narrowest containing range for best pitch stretch
    containing.sort((a, b) => (a.endMidi - a.startMidi) - (b.endMidi - b.startMidi));
    return containing[0];
  }

  // Otherwise pick closest by range midpoint
  let best = guitarSamples[0];
  let bestDist = Math.abs(targetMidi - (best.startMidi + best.endMidi) / 2);
  for (const s of guitarSamples) {
    const mid = (s.startMidi + s.endMidi) / 2;
    const d = Math.abs(targetMidi - mid);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

/* =========================
   Audio playback primitives
   ========================= */

function setMasterFromVelocity(velocity) {
  if (!masterGain) return;
  // Keep loud, but scale a little with velocity for expressiveness
  masterGain.gain.value = 1.15 + 0.35 * clamp(velocity, 0.0, 1.0);
}

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

  // Map target to a position inside recorded range
  const range = Math.max(1, sample.endMidi - sample.startMidi);
  const frac = clamp((targetMidi - sample.startMidi) / range, 0, 1);

  // Seek into the buffer to approximate the correct fret region
  // Use up to 60 percent of buffer duration to avoid late decay tail
  const maxSeek = sample.buffer.duration * 0.6;
  offset = frac * maxSeek;

  // Pitch correction via playbackRate relative to midpoint reference
  const refMidi = (sample.startMidi + sample.endMidi) / 2;
  const rate = Math.pow(2, (targetMidi - refMidi) / 12);
  src.playbackRate.value = rate;

  const g = audioCtx.createGain();
  const peak = clamp(velocity, 0.0001, 1.0);

  g.gain.setValueAtTime(0.0001, when);
  g.gain.linearRampToValueAtTime(peak, when + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, when + sliceDur);

  src.connect(g);
  connectToOutput(g);

  src.start(when, offset, sliceDur);
  src.stop(when + sliceDur + 0.03);
}

function playSineOneShot(midi, {
  when = audioCtx.currentTime,
  duration = 0.5,
  velocity = 0.9
} = {}) {
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();

  osc.type = "sine";
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  osc.frequency.setValueAtTime(freq, when);

  const peak = clamp(velocity, 0.0001, 1.0);

  g.gain.setValueAtTime(0.0001, when);
  g.gain.linearRampToValueAtTime(peak, when + 0.01);
  g.gain.setValueAtTime(peak, when + Math.max(0.02, duration - 0.08));
  g.gain.linearRampToValueAtTime(0.0001, when + duration);

  osc.connect(g);
  connectToOutput(g);

  osc.start(when);
  osc.stop(when + duration + 0.03);
}

function playNoteMidiOneShot(midi, opts) {
  if (!ensureAudioStarted()) return;
  const inst = UI.instrumentSelect.value;

  if (inst === "flute") {
    playFluteOneShot(midi, opts);
    return;
  }

  if (inst === "violin") {
    playViolinOneShot(midi, opts);
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

function setVibratoAmount(amount01) {
  vibratoAmount = clamp(amount01, 0, 1);
}

function startVibratoLoop() {
  if (vibratoTimer) return;
  vibratoPhase = 0;

  vibratoTimer = setInterval(() => {
    if (!audioCtx) return;

    const dt = 0.02;
    vibratoPhase += 2 * Math.PI * vibratoHz * dt;

    const depthCents = 40 * vibratoAmount;
    const cents = depthCents * Math.sin(vibratoPhase);
    const ratio = Math.pow(2, cents / 1200);

    for (const voice of activeVoices.values()) {
      for (const n of voice.nodes) {
        if (n.kind !== "sample") continue;
        if (n.baseRate == null) continue;
        try {
          n.src.playbackRate.setValueAtTime(n.baseRate * ratio, audioCtx.currentTime);
        } catch (e) {}
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
   Play modes: single, chord, arp
   ========================= */

function startSingle(degree, velocity) {
  const midi = degreeToMidi(degree);

  if (UI.instrumentSelect.value === "guitar") {
    playNoteMidiOneShot(midi, { duration: 0.8, velocity });
    return { midi, note: midiToNoteName(midi) };
  }

  // flute, violin, sine sustained behavior
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
    // keep guitar chords lower
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

  // flute, violin, sine sustained chord
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
   Sustained implementation for flute/violin/sine
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

  // sample instrument (flute or violin)
  const sample = (inst === "violin") ? findNearestViolinSample(midi) : findNearestFluteSample(midi);
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

  // sustained chord for sample instrument (flute or violin)
  for (const m of chordNotes) {
    const sample = (inst === "violin") ? findNearestViolinSample(m) : findNearestFluteSample(m);
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
   Auto-key detection UI state
   ========================= */

let autoKey = {
  tonic: null,
  mode: null,
  confidence: null,
  notes_heard: null
};

function updateDetectButtonVisibility() {
  // Only show detect button if key is Auto
  if (!UI.detectBtn) return;
  const isAuto = UI.keySelect.value === "auto";
  UI.detectBtn.classList.toggle("hidden", !isAuto);
}

function updateActiveKeyUI() {
  const km = getCurrentKeyMode();
  if (UI.activeKeyDisplay) UI.activeKeyDisplay.textContent = `Active Key: ${km.tonic} ${km.mode}`;
}

function updateDetectedUI() {
  if (!UI.detectedDisplay) return;
  if (!autoKey.tonic) {
    UI.detectedDisplay.textContent = "Last Detected Key: -";
    return;
  }
  UI.detectedDisplay.textContent = `Last Detected Key: ${autoKey.tonic} ${autoKey.mode} (conf ${autoKey.confidence?.toFixed?.(2) ?? "-"})`;
  if (UI.notesHeard) UI.notesHeard.textContent = Array.isArray(autoKey.notes_heard) ? autoKey.notes_heard.join(", ") : "-";
}

/* =========================
   Networking: WebSocket from Flask
   ========================= */

let ws = null;

function setWsConnected(isConn) {
  if (!UI.wsDot || !UI.wsStatus) return;
  UI.wsDot.classList.toggle("on", isConn);
  UI.wsStatus.textContent = isConn ? "Controller: connected" : "Controller: disconnected";
}

function setLastMsg(msg) {
  if (!UI.lastMsg) return;
  UI.lastMsg.textContent = `Last event: ${msg}`;
}

function connectWs() {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${window.location.host}/ws`);

  ws.onopen = () => setWsConnected(true);
  ws.onclose = () => {
    setWsConnected(false);
    setTimeout(connectWs, 800);
  };
  ws.onerror = () => setWsConnected(false);

  ws.onmessage = (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch (e) {
      return;
    }

    if (!data || !data.type) return;

    if (data.type === "note_on") {
      setLastMsg(`note_on deg ${data.degree} vel ${data.velocity}`);
      handleDegreeDown(parseInt(data.degree, 10), parseFloat(data.velocity));
      return;
    }

    if (data.type === "note_off") {
      setLastMsg(`note_off deg ${data.degree}`);
      handleDegreeUp(parseInt(data.degree, 10));
      return;
    }

    if (data.type === "vibrato") {
      setLastMsg(`vibrato ${data.amount}`);
      const a = parseFloat(data.amount);
      if (isFinite(a)) setVibratoAmount(a);
      updateLiveInfo();
      return;
    }

    if (data.type === "flex") {
      setLastMsg("flex mode cycle");
      applyFlexCycleMode();
      return;
    }
  };
}

/* =========================
   Audio start/stop
   ========================= */

async function startAudio() {
  if (isStarted) return;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.resume();

  // masterGain -> compressor -> destination
  masterGain = audioCtx.createGain();

  // Louder default volume
  masterGain.gain.value = 1.35;

  compressor = audioCtx.createDynamicsCompressor();

  // Tuned for clean loud output
  compressor.threshold.value = -12;
  compressor.knee.value = 30;
  compressor.ratio.value = 6;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;

  masterGain.connect(compressor);
  compressor.connect(audioCtx.destination);

  isStarted = true;

  startVibratoLoop();

  const inst = UI.instrumentSelect.value;

  try {
    if (inst === "flute") await loadFluteSamples();
    if (inst === "violin") await loadViolinSamples();
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
  violinLoaded = false;
  violinSamples = [];

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
    lastPlayed.degree = degree;
    lastPlayed.note = result.note;
    updateLiveInfo();

    const lines = buildDisplayLines(degree, result.note);
    sendDisplayUpdateToBackend(lines);
  }
}

function handleDegreeUp(degree) {
  const playMode = UI.playModeSelect.value;
  if (playMode === "single") stopSingle(degree);
  if (playMode === "chord") stopChord(degree);
}

/* =========================
   Auto key detect (mic record -> backend)
   ========================= */

async function detectKey() {
  if (!ensureAudioStarted()) return;

  UI.detectBtn.disabled = true;
  UI.detectBtn.classList.add("loading");

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(stream);

    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);

    const done = new Promise((resolve) => {
      rec.onstop = () => resolve();
    });

    rec.start();
    await new Promise(r => setTimeout(r, 5000));
    rec.stop();

    await done;
    stream.getTracks().forEach(t => t.stop());

    const blob = new Blob(chunks, { type: "audio/webm" });
    const arrayBuf = await blob.arrayBuffer();

    // Convert webm to wav on backend (analyze_file.py handles conversion)
    const resp = await fetch("/detect_key", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: arrayBuf
    });

    if (!resp.ok) throw new Error("detect_key failed");

    const data = await resp.json();

    autoKey = {
      tonic: data.tonic,
      mode: data.mode,
      confidence: data.confidence,
      notes_heard: data.notes_heard
    };

    updateDetectedUI();
    updateActiveKeyUI();
  } catch (e) {
    console.error(e);
    setStatus("Key detect failed.");
  } finally {
    UI.detectBtn.disabled = false;
    UI.detectBtn.classList.remove("loading");
  }
}

/* =========================
   UI event listeners
   ========================= */

UI.startBtn.addEventListener("click", startAudio);
UI.stopBtn.addEventListener("click", stopAudio);

UI.keySelect.addEventListener("change", () => {
  updateDetectButtonVisibility();
  updateActiveKeyUI();
  sendDisplayUpdateToBackend({
    line1: `Mode: ${UI.playModeSelect.value} Key: ${getCurrentKeyMode().tonic} ${getCurrentKeyMode().mode}`,
    line2: `Ready`
  });
});

UI.modeSelect.addEventListener("change", () => {
  updateActiveKeyUI();
  sendDisplayUpdateToBackend({
    line1: `Mode: ${UI.playModeSelect.value} Key: ${getCurrentKeyMode().tonic} ${getCurrentKeyMode().mode}`,
    line2: `Ready`
  });
});

UI.playModeSelect.addEventListener("change", () => {
  sendDisplayUpdateToBackend({
    line1: `Mode: ${UI.playModeSelect.value} Key: ${getCurrentKeyMode().tonic} ${getCurrentKeyMode().mode}`,
    line2: `Ready`
  });
});

UI.instrumentSelect.addEventListener("change", async () => {
  if (!isStarted) return;
  try {
    if (UI.instrumentSelect.value === "flute") await loadFluteSamples();
    if (UI.instrumentSelect.value === "violin") await loadViolinSamples();
    if (UI.instrumentSelect.value === "guitar") await loadGuitarSamples();
  } catch (e) {}
});

if (UI.detectBtn) UI.detectBtn.addEventListener("click", detectKey);

// Mouse degree buttons
if (UI.degreeGrid) {
  UI.degreeGrid.addEventListener("mousedown", (e) => {
    const btn = e.target.closest(".deg");
    if (!btn) return;
    const degree = parseInt(btn.dataset.degree, 10);
    handleDegreeDown(degree);
  });

  UI.degreeGrid.addEventListener("mouseup", (e) => {
    const btn = e.target.closest(".deg");
    if (!btn) return;
    const degree = parseInt(btn.dataset.degree, 10);
    handleDegreeUp(degree);
  });

  UI.degreeGrid.addEventListener("mouseleave", (e) => {
    // stop any held notes if you drag away
  });
}

// Keyboard degrees 1-8
window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  const k = e.key;
  if (k >= "1" && k <= "8") {
    handleDegreeDown(parseInt(k, 10));
  }
});

window.addEventListener("keyup", (e) => {
  const k = e.key;
  if (k >= "1" && k <= "8") {
    handleDegreeUp(parseInt(k, 10));
  }
});

/* =========================
   Boot
   ========================= */

updateDetectButtonVisibility();
updateActiveKeyUI();
updateDetectedUI();
updateLiveInfo();
connectWs();
