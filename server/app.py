from flask import Flask, request, jsonify, render_template
from flask_sock import Sock
import json
import os
import re
import time
import threading

try:
    from google import genai
except Exception:
    genai = None


app = Flask(__name__)
sock = Sock(app)

# ----------------------------
# Shared state
# ----------------------------
display_lock = threading.Lock()
display_state = {"line1": "Jam Assist", "line2": "Ready", "ts": time.time()}

clients_lock = threading.Lock()
ws_clients = set()


def log(msg: str) -> None:
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def broadcast(obj: dict) -> int:
    payload = json.dumps(obj, separators=(",", ":"))
    dead = []
    sent = 0

    with clients_lock:
        for ws in list(ws_clients):
            try:
                ws.send(payload)
                sent += 1
            except Exception:
                dead.append(ws)

        for ws in dead:
            try:
                ws_clients.remove(ws)
            except Exception:
                pass

    return sent


# ----------------------------
# Gemini JSON parsing helpers
# ----------------------------
def strip_markdown_fences(text: str) -> str:
    t = (text or "").strip()
    if "```" not in t:
        return t

    # Remove ```json and ``` fences
    t = re.sub(r"```(?:json)?", "", t, flags=re.IGNORECASE)
    t = t.replace("```", "")
    return t.strip()


def extract_first_balanced_json_object(text: str) -> str:
    """
    Returns the substring that is the first balanced {...} object.
    Works without recursive regex.
    """
    t = strip_markdown_fences(text)

    start = t.find("{")
    if start == -1:
        raise ValueError("No '{' found in Gemini output")

    depth = 0
    in_string = False
    escape = False

    for i in range(start, len(t)):
        ch = t[i]

        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue

        if ch == '"':
            in_string = True
            continue

        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return t[start : i + 1]

    raise ValueError("Found '{' but did not find matching '}'")


def extract_json_from_gemini(text: str) -> dict:
    """
    Parses JSON from Gemini response that may contain extra text/markdown.
    """
    if not text or not str(text).strip():
        raise ValueError("Empty Gemini response")

    t = str(text).strip()

    # Try pure JSON
    try:
        return json.loads(t)
    except Exception:
        pass

    # Try after stripping markdown
    t2 = strip_markdown_fences(t)
    try:
        return json.loads(t2)
    except Exception:
        pass

    # Extract first balanced JSON object
    obj_str = extract_first_balanced_json_object(t2)
    return json.loads(obj_str)


def normalize_detected_key(data: dict) -> dict:
    tonic = str(data.get("tonic", "")).strip()
    tonic = tonic.replace("♭", "b").replace("♯", "#").replace(" ", "")

    mode = str(data.get("mode", "")).strip().lower()
    if mode in ("maj", "major"):
        mode = "major"
    elif mode in ("min", "minor"):
        mode = "minor"

    conf = data.get("confidence", 0.0)
    try:
        conf = float(conf)
    except Exception:
        conf = 0.0
    conf = max(0.0, min(1.0, conf))

    if not re.match(r"^[A-G](#|b)?$", tonic):
        raise ValueError(f"Invalid tonic: {tonic}")
    if mode not in ("major", "minor"):
        raise ValueError(f"Invalid mode: {mode}")

    notes_heard = data.get("notes_heard", [])
    if not isinstance(notes_heard, list):
        notes_heard = []

    return {
        "ok": True,
        "tonic": tonic,
        "mode": mode,
        "confidence": conf,
        "notes_heard": notes_heard[:12],
    }


def gemini_detect_key(wav_path: str) -> dict:
    if genai is None:
        return {"ok": False, "error": "google-genai not installed. Run: pip install google-genai"}

    api_key = "ENTER API KEY"

    client = genai.Client(api_key=api_key)
    uploaded = client.files.upload(file=wav_path)

    model_name = os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite")

    prompt = """
Return only JSON (no markdown, no extra text).
Schema:
{
  "tonic": "G",
  "mode": "major",
  "confidence": 0.0,
  "notes_heard": ["G","B","D"]
}
Rules:
- tonic: A-G optionally with # or b
- mode: "major" or "minor"
- confidence: 0.0 to 1.0
"""

    resp = client.models.generate_content(
        model=model_name,
        contents=[prompt, uploaded],
    )

    raw_text = (resp.text or "").strip()

    try:
        parsed = extract_json_from_gemini(raw_text)
        normalized = normalize_detected_key(parsed)
        normalized["raw_text"] = raw_text
        return normalized
    except Exception as e:
        return {"ok": False, "error": f"Failed to parse Gemini output: {e}", "raw_text": raw_text}


# ----------------------------
# Routes
# ----------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/ping")
def ping():
    return jsonify({"ok": True, "ts": time.time()})


@app.route("/esp/event", methods=["POST"])
def esp_event():
    try:
        data = request.get_json(force=True)
    except Exception as e:
        log(f"/esp/event invalid JSON: {e}")
        return jsonify({"ok": False, "error": "Invalid JSON"}), 400

    if not isinstance(data, dict) or "type" not in data:
        log(f"/esp/event bad payload: {data}")
        return jsonify({"ok": False, "error": "Missing type"}), 400

    log(f"ESP32 -> /esp/event: {data}")
    sent = broadcast(data)
    log(f"Broadcasted to {sent} ws client(s)")
    return jsonify({"ok": True, "ws_sent": sent})


@app.route("/display_update", methods=["POST"])
def display_update():
    try:
        data = request.get_json(force=True)
    except Exception as e:
        log(f"/display_update invalid JSON: {e}")
        return jsonify({"ok": False, "error": "Invalid JSON"}), 400

    line1 = str(data.get("line1", ""))[:64]
    line2 = str(data.get("line2", ""))[:64]

    with display_lock:
        display_state["line1"] = line1
        display_state["line2"] = line2
        display_state["ts"] = time.time()

    log(f"Browser -> /display_update: line1='{line1}' line2='{line2}'")
    return jsonify({"ok": True})


@app.route("/esp/display")
def esp_display():
    with display_lock:
        return jsonify(display_state)


@sock.route("/ws")
def ws_route(ws):
    with clients_lock:
        ws_clients.add(ws)
        total = len(ws_clients)

    log(f"WS client connected. Total: {total}")

    try:
        ws.send(json.dumps({"type": "hello", "ts": time.time()}))
        while True:
            msg = ws.receive()
            if msg is None:
                break
            log(f"WS -> server message: {msg}")
    except Exception as e:
        log(f"WS error: {e}")
    finally:
        with clients_lock:
            try:
                ws_clients.remove(ws)
            except Exception:
                pass
            total2 = len(ws_clients)
        log(f"WS client disconnected. Total: {total2}")


@app.route("/detect_key", methods=["POST"])
def detect_key():
    if "audio" not in request.files:
        return jsonify({"ok": False, "error": "No audio uploaded. Field name must be 'audio'."}), 400

    f = request.files["audio"]
    raw = f.read()

    os.makedirs("recordings", exist_ok=True)
    ts = time.strftime("%Y%m%d_%H%M%S")
    wav_path = os.path.join("recordings", f"clip_{ts}.wav")

    with open(wav_path, "wb") as out:
        out.write(raw)

    log(f"/detect_key saved: {wav_path}")

    result = gemini_detect_key(wav_path)
    log(f"/detect_key result ok={result.get('ok')}")
    result["saved_file"] = wav_path
    return jsonify(result)


if __name__ == "__main__":
    log("Starting Flask on 0.0.0.0:5000")
    app.run(host="0.0.0.0", port=5000, debug=True)
