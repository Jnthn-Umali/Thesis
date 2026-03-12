// Use EXPO_PUBLIC_SERVER_URL in production (e.g. in .env or EAS env)
export const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL ?? "http://10.202.11.238:8000";
export const CAPTURE_INTERVAL_MS = 2000; // Fixed 3 second interval for all captures
export const JPEG_QUALITY = 0.7;
export const RESIZE = 512;
export const CONFIDENCE_THRESHOLD = 0.28;
export const COOLDOWN_MS = 8000;
export const POST_SPEECH_WAIT_MS = 2000; // Wait 3 seconds after speech ends before capturing

// Volume: system volume controller; app uses full TTS volume (1)
export const MAX_VOLUME_WITH_HEADPHONES = 0.7; // Headphone warning threshold: TTS alert when system volume exceeds 70%
export const VIBRATE_VOLUME_THRESHOLD = 0.30; // Vibrate when volume below 30% (user likely can't hear)
export const ENABLE_VOLUME_RESTRICTION = true; // Set to false to allow full volume (not recommended)

// M5Timer Camera configuration (EXPO_PUBLIC_M5TIMER_CAMERA_IP for production)
export const M5TIMER_CAMERA_IP = process.env.EXPO_PUBLIC_M5TIMER_CAMERA_IP ?? "10.202.11.186";
export const M5TIMER_CAMERA_STREAM_URL = `http://${M5TIMER_CAMERA_IP}/stream`;
export const M5TIMER_CAMERA_BATTERY_URL = `http://${M5TIMER_CAMERA_IP}/battery`;
