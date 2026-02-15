import sys
import numpy as np
import librosa

NOTE_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]

MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], dtype=float)
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17], dtype=float)

def rotate_profile(profile: np.ndarray, tonic: int) -> np.ndarray:
    return np.roll(profile, tonic)

def safe_normalize(v: np.ndarray) -> np.ndarray:
    s = float(np.sum(v))
    if s <= 1e-12 or not np.isfinite(s):
        return v * 0.0
    return v / s

def analyze(y: np.ndarray, sr: int) -> dict:
    if y.ndim > 1:
        y = np.mean(y, axis=0)
    y = y.astype(np.float32)

    duration = float(len(y)) / float(sr) if sr else 0.0
    peak = float(np.max(np.abs(y))) if y.size else 0.0
    rms = float(np.sqrt(np.mean(y**2))) if y.size else 0.0

    if peak == 0 or rms == 0:
        return {"ok": False, "error": "Audio is all zeros.", "duration": duration, "peak": peak, "rms": rms}

    y = y / peak
    y = librosa.effects.preemphasis(y)
    y_harm, _ = librosa.effects.hpss(y)

    chroma = librosa.feature.chroma_cqt(y=y_harm, sr=sr)
    chroma_vec = np.median(chroma, axis=1)
    chroma_vec = safe_normalize(chroma_vec)

    if float(np.sum(chroma_vec)) <= 0:
        return {"ok": False, "error": "No tonal content detected.", "duration": duration, "peak": peak, "rms": rms}

    top_idx = np.argsort(chroma_vec)[::-1]
    notes = []
    for i in top_idx[:7]:
        pct = float(chroma_vec[i]) * 100.0
        if pct < 3.0:
            continue
        notes.append((NOTE_NAMES[int(i)], round(pct, 1)))

    best_score = -1e18
    best = None
    second = -1e18

    for tonic in range(12):
        maj = float(np.dot(chroma_vec, rotate_profile(MAJOR_PROFILE, tonic)))
        minr = float(np.dot(chroma_vec, rotate_profile(MINOR_PROFILE, tonic)))
        for mode, score in [("major", maj), ("minor", minr)]:
            if score > best_score:
                second = best_score
                best_score = score
                best = (tonic, mode)
            elif score > second:
                second = score

    confidence = float(best_score - second)
    tonic, mode = best

    return {
        "ok": True,
        "tonic": NOTE_NAMES[int(tonic)],
        "mode": mode,
        "confidence": confidence,
        "notes": notes,
        "duration": duration,
        "peak": peak,
        "rms": rms
    }

def main():
    if len(sys.argv) < 2:
        print("Usage: python analyze_file.py recordings/clip_YYYYMMDD_HHMMSS.wav")
        sys.exit(1)

    path = sys.argv[1]
    y, sr = librosa.load(path, sr=22050, mono=True)

    result = analyze(y, sr)
    print("File:", path)
    print("Result:", result)

if __name__ == "__main__":
    main()
