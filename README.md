# Thesis Project (Client + Inference Server)

This repository contains a **mobile app (Expo / React Native)** and a **Python FastAPI inference server**.

At a high level:

- **M5Timer Camera** streams MJPEG frames on your Wi‑Fi network.
- The **mobile app** reads frames from the M5 stream, periodically sends snapshots to the server (`POST /infer`).
- The **server** runs:
  - **YOLO (Ultralytics)** object detection
  - **Depth Anything V2 (metric depth)** for distance estimation
  - **EasyOCR** for text extraction (full image + per detected object)
- The app speaks results using **text‑to‑speech** and shows a small on‑screen summary.

---

## Project structure

- `client/`: Expo app (React Native + expo-router)
- `server/`: FastAPI server (`server.py`) + model label assets (`server/assets/`)

---

## Requirements

### Server (Windows)

- **Python**: 3.10+ recommended
- **Git**: only needed if you clone external model repos
- **GPU**: optional (CUDA helps a lot). CPU works but will be slower.

The server depends on packages listed in `server/requirements.txt`.

### Client

- **Node.js**: 18+ recommended
- **npm** (or yarn/pnpm)
- **Expo**: you run this via `npx expo ...` (no global install required)
- Android phone or emulator (the app uses native modules; best results with a dev build)

---

## Configuration (important)

### Client network targets

The app reads these from `client/config.ts`:

- `SERVER_URL`: where the FastAPI server runs (default is a LAN IP like `http://...:8000`)
- `M5TIMER_CAMERA_IP`: the M5Timer Camera IP on your LAN

You can set them via environment variables:

- `EXPO_PUBLIC_SERVER_URL`
- `EXPO_PUBLIC_M5TIMER_CAMERA_IP`

Example (PowerShell):

```powershell
$env:EXPO_PUBLIC_SERVER_URL="http://192.1.1.1:8000" ### change the ip of the public server and m5 timer camera accordingly or just uncomment the toggle between camera app and m5 camera in the homescreen if you dont have an m5 camera
$env:EXPO_PUBLIC_M5TIMER_CAMERA_IP="192.1.1.60"
```

### Server model paths (currently hard-coded)

In `server/server.py`, the following paths are **hard-coded** and must exist on the machine running the server:

- `DEPTH_ANYTHING_REPO_ROOT` (Depth-Anything-V2 repo folder)
- `METRIC_CHECKPOINT` (Depth Anything V2 metric checkpoint `.pth`)
- YOLO weights file loaded by Ultralytics: `yolov8m-oiv7.pt` (expected in the server working directory or a resolvable path)

If you move this repo to a different machine, update those paths accordingly.

---

## Run the server

Open PowerShell in the repo root.

```powershell
cd server
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python server.py
```

By default the server listens on:

- `http://0.0.0.0:8000`
- Health check: `GET /health`

If Windows Firewall prompts you, allow access on your private network so your phone can reach it.

---

## Run the client (Expo)

Open a second terminal:

```powershell
cd client
npm install
npx expo start
```

Then:

- Use an Android device on the **same Wi‑Fi** as the server and the M5 camera.
- For best compatibility (native modules like camera/audio), use an **Expo dev build** if you already have one set up.

---

## How inference works

1. The app captures a frame from the M5 MJPEG stream.
2. It compresses/resizes the image (see `client/config.ts`).
3. It uploads the image to `POST /infer`.
4. The server returns JSON including:
   - `objects`: detected objects (label, confidence, position, distance, OCR text, bounding boxes)
   - `fullOcrText`: OCR from the entire image (even if no objects detected)
5. The app:
   - updates the bottom panel (position/distance/confidence)
   - builds a spoken message and plays it using TTS

Note: the server currently returns **up to 4 nearest objects**.

---

## Troubleshooting

### Phone can’t reach server

- Confirm `SERVER_URL` points to the **server machine LAN IP**, not `localhost`.
- Confirm both devices are on the same Wi‑Fi.
- Allow inbound port `8000` in Windows Firewall.

### M5 stream not connecting

- Confirm `M5TIMER_CAMERA_IP` is correct.
- Ensure the camera stream endpoints are reachable from the phone browser:
  - `http://<M5_IP>/stream`
  - `http://<M5_IP>/battery` (if supported)

### Inference is slow / timeouts

- The client uses a ~30s timeout per request.
- CPU-only inference may exceed that depending on hardware and models.
- Running on a machine with CUDA GPU will greatly improve performance.

