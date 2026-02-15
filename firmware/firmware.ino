#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>

// ---------------------------
// FILL THESE IN
// ---------------------------
const char* WIFI_SSID = "SSID";
const char* WIFI_PASS = "PASSWORD";

// Example: http://192.168.0.123:5000
const char* SERVER_BASE = "FLASK SERVER";

// ---------------- ADC constants ----------------
const float VCC = 3.3f;
const int ADC_MAX = 4095;

// ---------------- I2C pins ----------------
const int I2C_SDA = 21;
const int I2C_SCL = 22;

// ---------------- Buttons ----------------
const int BTN_COUNT = 8;
const int BTN_PINS[BTN_COUNT] = {13, 14, 16, 17, 18, 19, 23, 25};
int lastBtnState[BTN_COUNT];

// ---------------- Flex sensor ----------------
const int FLEX_PIN = 34;
int flexRaw = 0;
int FLEX_ON_THRESHOLD  = 2300;
int FLEX_OFF_THRESHOLD = 2000;
bool flexActive = false;

// ---------------- FSR ----------------
const int FSR_PIN = 32;
int fsrRaw = 0;

// Map to 0.2..1.0 for note velocity
int FSR_MIN_ACTIVE = 900;
int FSR_MAX_ACTIVE = 3000;
float currentVelocity = 0.80f;

// FSR level events
int FSR_LOW_MAX = 1200;
int FSR_MID_MAX = 2600;
enum ForceLevel { FORCE_LOW, FORCE_MID, FORCE_HIGH };
ForceLevel fsrLevel = FORCE_LOW;
ForceLevel lastFsrLevel = FORCE_LOW;

// ---------------- OLED ----------------
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 32
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

// ---------------- MPU6050 ----------------
Adafruit_MPU6050 mpu;
float currentVibrato = 0.0f;

// ---------------- Timing ----------------
const unsigned long BTN_DEBOUNCE_MS = 8;

const unsigned long FLEX_PERIOD_MS = 40;
const unsigned long FSR_PERIOD_MS  = 50;
const unsigned long OLED_POLL_MS   = 200;
const unsigned long VIBRATO_MS     = 40;   // 25 Hz
const unsigned long STATS_MS       = 1000;

unsigned long lastFlexMs = 0;
unsigned long lastFsrMs  = 0;
unsigned long lastOledMs = 0;
unsigned long lastVibMs  = 0;
unsigned long lastStatsMs = 0;

// ---------------- HTTP stats ----------------
uint32_t postOk = 0;
uint32_t postFail = 0;
uint32_t getOk = 0;
uint32_t getFail = 0;
int lastHttpCode = 0;

// ---------------- Display state ----------------
int activeDegree = 0;
char serverLine1[65] = {0};
char serverLine2[65] = {0};

// ---------------- Helpers ----------------
static float clampf(float x, float a, float b) {
  if (x < a) return a;
  if (x > b) return b;
  return x;
}

String urlJoin(const char* base, const char* path) {
  String s(base);
  s += path;
  return s;
}

void oledShowTwoLines(const char* l1, const char* l2) {
  display.clearDisplay();
  display.setCursor(0, 0);
  display.println(l1);
  display.println(l2);
  display.display();
}

const char* levelToStr(ForceLevel lvl) {
  switch (lvl) {
    case FORCE_LOW: return "LOW";
    case FORCE_MID: return "MID";
    case FORCE_HIGH: return "HIGH";
  }
  return "LOW";
}

ForceLevel computeLevel(int raw) {
  if (raw <= FSR_LOW_MAX) return FORCE_LOW;
  if (raw <= FSR_MID_MAX) return FORCE_MID;
  return FORCE_HIGH;
}

float computeVelocityFromFSR(int raw) {

  const float DEFAULT_VEL = 0.5f;  // <-- strong default loudness
  const float MAX_VEL     = 1.00f;

  // Below activation threshold → ignore FSR, use default loud velocity
  if (raw <= FSR_MIN_ACTIVE) {
    return DEFAULT_VEL;
  }

  // Above max threshold → full velocity
  if (raw >= FSR_MAX_ACTIVE) {
    return MAX_VEL;
  }

  // Scale between default and max
  float t = float(raw - FSR_MIN_ACTIVE) / float(FSR_MAX_ACTIVE - FSR_MIN_ACTIVE);
  t = clampf(t, 0.0f, 1.0f);

  return DEFAULT_VEL + (MAX_VEL - DEFAULT_VEL) * t;
}



void printJsonToSerial(const JsonDocument& doc) {
  String s;
  serializeJson(doc, s);
  Serial.println(s);
}

bool httpPostJson(const char* path, const JsonDocument& doc) {
  if (WiFi.status() != WL_CONNECTED) {
    lastHttpCode = -1;
    postFail++;
    Serial.println("[HTTP] POST blocked, WiFi not connected");
    return false;
  }

  HTTPClient http;
  String url = urlJoin(SERVER_BASE, path);

  String body;
  serializeJson(doc, body);

  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST((uint8_t*)body.c_str(), body.length());
  lastHttpCode = code;
  http.end();

  if (code >= 200 && code < 300) {
    postOk++;
    Serial.print("[HTTP] POST ok code=");
    Serial.println(code);
    return true;
  } else {
    postFail++;
    Serial.print("[HTTP] POST fail code=");
    Serial.println(code);
    return false;
  }
}

bool httpGetJson(const char* path, JsonDocument& outDoc) {
  if (WiFi.status() != WL_CONNECTED) {
    lastHttpCode = -1;
    getFail++;
    Serial.println("[HTTP] GET blocked, WiFi not connected");
    return false;
  }

  HTTPClient http;
  String url = urlJoin(SERVER_BASE, path);

  http.begin(url);
  int code = http.GET();
  lastHttpCode = code;

  if (!(code >= 200 && code < 300)) {
    http.end();
    getFail++;
    Serial.print("[HTTP] GET fail code=");
    Serial.println(code);
    return false;
  }

  String payload = http.getString();
  http.end();

  DeserializationError err = deserializeJson(outDoc, payload);
  if (err) {
    getFail++;
    Serial.print("[HTTP] JSON parse fail: ");
    Serial.println(err.c_str());
    return false;
  }

  getOk++;
  Serial.print("[HTTP] GET ok code=");
  Serial.println(code);
  return true;
}

// ---------------- WiFi ----------------
void connectWiFiBlocking() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.disconnect(true, true);
  delay(200);

  Serial.print("Connecting to WiFi SSID: ");
  Serial.println(WIFI_SSID);

  oledShowTwoLines("WiFi connecting", "Check hotspot");

  WiFi.begin(WIFI_SSID, WIFI_PASS);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
    if (millis() - start > 25000) break;
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("WiFi connected");
    Serial.print("IP: ");
    Serial.println(WiFi.localIP());
    Serial.print("RSSI: ");
    Serial.println(WiFi.RSSI());
    oledShowTwoLines("WiFi OK", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("WiFi failed");
    oledShowTwoLines("WiFi FAIL", "Use 2.4GHz");
  }
}

// ---------------- Sensor reads and event sends ----------------
void readFSRAndMaybeSendLevel() {
  fsrRaw = analogRead(FSR_PIN);
  currentVelocity = computeVelocityFromFSR(fsrRaw);

  fsrLevel = computeLevel(fsrRaw);
  if (fsrLevel != lastFsrLevel) {
    lastFsrLevel = fsrLevel;

    StaticJsonDocument<128> doc;
    doc["type"] = "pressure";
    doc["raw"] = fsrRaw;
    doc["level"] = levelToStr(fsrLevel);
    doc["velocity"] = currentVelocity;

    Serial.print("[SEND] pressure level change -> ");
    printJsonToSerial(doc);
    httpPostJson("/esp/event", doc);
  }
}

void readFlexAndMaybeSend() {
  flexRaw = analogRead(FLEX_PIN);

  bool wasActive = flexActive;
  if (!flexActive && flexRaw >= FLEX_ON_THRESHOLD) flexActive = true;
  else if (flexActive && flexRaw <= FLEX_OFF_THRESHOLD) flexActive = false;

  if (!wasActive && flexActive) {
    StaticJsonDocument<128> doc;
    doc["type"] = "flex";
    doc["action"] = "cycle_mode";
    doc["raw"] = flexRaw;

    Serial.print("[SEND] flex cycle -> ");
    printJsonToSerial(doc);
    httpPostJson("/esp/event", doc);
  }
}

void readMPUAndSendVibrato() {
  sensors_event_t a, g, t;
  mpu.getEvent(&a, &g, &t);

  float mag = fabs(g.gyro.x) + fabs(g.gyro.y) + fabs(g.gyro.z);

  const float MAG_MIN = 0.15f;
  const float MAG_MAX = 2.20f;

  float amt = (mag - MAG_MIN) / (MAG_MAX - MAG_MIN);
  amt = clampf(amt, 0.0f, 1.0f);

  currentVibrato = 0.75f * currentVibrato + 0.25f * amt;

  StaticJsonDocument<128> doc;
  doc["type"] = "vibrato";
  doc["amount"] = currentVibrato;

  Serial.print("[SEND] vibrato -> ");
  printJsonToSerial(doc);
  httpPostJson("/esp/event", doc);
}

void scanButtonsAndSend() {
  for (int i = 0; i < BTN_COUNT; i++) {
    int now = digitalRead(BTN_PINS[i]);
    int last = lastBtnState[i];

    // press edge
    if (last == HIGH && now == LOW) {
      int degree = i + 1;
      activeDegree = degree;

      // OLED must show note being played immediately
      char l1[32];
      char l2[32];
      snprintf(l1, sizeof(l1), "Playing Deg %d", degree);
      snprintf(l2, sizeof(l2), "Vel %.2f", currentVelocity);
      oledShowTwoLines(l1, l2);

      StaticJsonDocument<160> doc;
      doc["type"] = "note_on";
      doc["degree"] = degree;
      doc["velocity"] = currentVelocity;

      Serial.print("[SEND] note_on -> ");
      printJsonToSerial(doc);
      httpPostJson("/esp/event", doc);
    }

    // release edge
    if (last == LOW && now == HIGH) {
      int degree = i + 1;
      if (activeDegree == degree) activeDegree = 0;

      StaticJsonDocument<128> doc;
      doc["type"] = "note_off";
      doc["degree"] = degree;

      Serial.print("[SEND] note_off -> ");
      printJsonToSerial(doc);
      httpPostJson("/esp/event", doc);
    }

    lastBtnState[i] = now;
  }

  delay(BTN_DEBOUNCE_MS);
}

void pollDisplayFromServer() {
  StaticJsonDocument<256> doc;
  if (!httpGetJson("/esp/display", doc)) return;

  const char* l1 = doc["line1"] | "";
  const char* l2 = doc["line2"] | "";

  strncpy(serverLine1, l1, 64);
  strncpy(serverLine2, l2, 64);
  serverLine1[64] = '\0';
  serverLine2[64] = '\0';

  // Only overwrite OLED with server display when not actively pressing a note
  if (activeDegree == 0) {
    oledShowTwoLines(serverLine1, serverLine2);
  }
}

// ---------------- Setup and loop ----------------
void setup() {
  Serial.begin(115200);
  delay(200);

  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);

  for (int i = 0; i < BTN_COUNT; i++) {
    pinMode(BTN_PINS[i], INPUT_PULLUP);
    lastBtnState[i] = digitalRead(BTN_PINS[i]);
  }

  Wire.begin(I2C_SDA, I2C_SCL);

  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    while (true) { delay(1000); }
  }
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("Jam Assist");
  display.println("Booting...");
  display.display();

  if (!mpu.begin()) {
    oledShowTwoLines("MPU6050 FAIL", "Check wiring");
    while (true) { delay(1000); }
  }

  connectWiFiBlocking();
  readFSRAndMaybeSendLevel();

  Serial.println("Ready.");
}

void loop() {
  // Reconnect if WiFi drops
  static unsigned long lastReconnectAttempt = 0;
  if (WiFi.status() != WL_CONNECTED) {
    unsigned long now = millis();
    if (now - lastReconnectAttempt > 3000) {
      lastReconnectAttempt = now;
      Serial.println("WiFi reconnect attempt...");
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASS);
    }
  }

  scanButtonsAndSend();

  unsigned long now = millis();

  if (now - lastFsrMs >= FSR_PERIOD_MS) {
    lastFsrMs = now;
    readFSRAndMaybeSendLevel();
  }

  if (now - lastFlexMs >= FLEX_PERIOD_MS) {
    lastFlexMs = now;
    readFlexAndMaybeSend();
  }

  if (now - lastVibMs >= VIBRATO_MS) {
    lastVibMs = now;
    readMPUAndSendVibrato();
  }

  if (now - lastOledMs >= OLED_POLL_MS) {
    lastOledMs = now;
    pollDisplayFromServer();
  }

  if (now - lastStatsMs >= STATS_MS) {
    lastStatsMs = now;
    Serial.println("---- STATS ----");
    Serial.print("WiFi status: "); Serial.println(WiFi.status());
    Serial.print("IP: "); Serial.println(WiFi.localIP());
    Serial.print("RSSI: "); Serial.println(WiFi.RSSI());
    Serial.print("FSR raw: "); Serial.print(fsrRaw);
    Serial.print(" vel: "); Serial.println(currentVelocity, 3);
    Serial.print("Vibrato: "); Serial.println(currentVibrato, 3);
    Serial.print("HTTP last code: "); Serial.println(lastHttpCode);
    Serial.print("POST ok/fail: "); Serial.print(postOk); Serial.print("/"); Serial.println(postFail);
    Serial.print("GET ok/fail: "); Serial.print(getOk); Serial.print("/"); Serial.println(getFail);
    Serial.println("--------------");
  }
}

