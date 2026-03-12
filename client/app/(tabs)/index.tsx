
import React, { useState, useEffect, useRef } from 'react';
import { View, Text, Image, StyleSheet, Switch, Platform, Vibration, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { VolumeManager } from 'react-native-volume-manager';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Speech from 'expo-speech';
import * as Battery from 'expo-battery';
import { Audio } from 'expo-av';
import { Accelerometer, Gyroscope } from 'expo-sensors'; 
import * as SecureStore from 'expo-secure-store';
import { router } from 'expo-router';
import MJPEGStreamViewer, { MJPEGStreamViewerRef } from '../../components/MJPEGStreamViewer';
import { useHeadphoneDetection } from '../../hooks/use-headphone-detection';
import {
  SERVER_URL,
  CAPTURE_INTERVAL_MS,
  JPEG_QUALITY,
  RESIZE,
  CONFIDENCE_THRESHOLD,
  COOLDOWN_MS,
  POST_SPEECH_WAIT_MS,
  MAX_VOLUME_WITH_HEADPHONES,
  ENABLE_VOLUME_RESTRICTION,
  VIBRATE_VOLUME_THRESHOLD,
} from '../../config';

type CameraSource = 'phone' | 'm5timer';

/**
 * The `HomeScreen` is the main screen of the app.
 *
 * In plain language:
 * - It connects to the camera (on the phone or the M5 device).
 * - It sends what the camera sees to a server that recognises objects and text.
 * - It speaks important information out loud to the user (for example “door ahead”).
 * - It keeps track of battery, internet connection, and safety limits like volume.
 *
 * The many pieces of state and refs below are simply the "memory" of this screen:
 * they remember what is going on so the app can react correctly.
 */
export default function HomeScreen() {
  // --- HIGH‑LEVEL APP / CAMERA STATE (what mode the app is in) ---
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false); // Has the user successfully logged in?
  const [permission, requestPermission] = useCameraPermissions(); // Camera permission status and a way to ask for it.
  // M5-only: use 'm5timer' only; phone camera commented out below
  const [cameraSource, setCameraSource] = useState<CameraSource>('m5timer'); // Which camera we are using: phone or M5 device.
  const [cameraReady, setCameraReady] = useState<boolean>(false); // Has the camera finished starting up and is ready to use?
  const [cameraError, setCameraError] = useState<string | null>(null); // Any problem message related to the camera.
  const [m5timerConnected, setM5timerConnected] = useState<boolean>(false); // Are we currently connected to the M5 device?
  const [scanningPaused, setScanningPaused] = useState<boolean>(false); // Are we temporarily pausing the continuous scanning?

  // --- WHAT THE CAMERA / SERVER IS SEEING AND SAYING ---
  const [detectedObjects, setDetectedObjects] = useState<any[]>([]); // Latest things the server says it can see.
  const [depth, setDepth] = useState<number>(0); // Approximate distance information (how far away something is).
  const [lastSpoken, setLastSpoken] = useState<number>(0); // When we last spoke something aloud (used so we don’t talk too often).
  const [offline, setOffline] = useState(false); // Are we currently offline / unable to talk to the server?
  const [spokenText, setSpokenText] = useState<string>(''); // The latest message that was spoken to the user.
  const [consecutiveFailures, setConsecutiveFailures] = useState<number>(0); // How many times in a row sending/processing failed (used to detect problems).

  // --- DEVICE POSITION AND BATTERY (physical state of the device) ---
  const [deviceOrientation, setDeviceOrientation] = useState<{
    pitch: number; // Tilt forward / backward.
    roll: number;  // Tilt left / right.
    yaw: number;   // Direction the device is facing.
  }>({ pitch: 0, roll: 0, yaw: 0 });
  const [m5BatteryPercent, setM5BatteryPercent] = useState<number | null>(null); // Battery level of the M5 device (if known).

  // Safe area (top / bottom padding) so content doesn’t hide under notches or system bars.
  const insets = useSafeAreaInsets();

  // --- TECHNICAL HANDLES / REFS (low‑level "wiring" the user never sees directly) ---
  const cameraRef = useRef<CameraView | null>(null); // Direct handle to the phone camera component.
  const m5timerStreamRef = useRef<MJPEGStreamViewerRef | null>(null); // Direct handle to the M5 video stream viewer.
  const arSessionRef = useRef<any>(null); // Placeholder for an AR session (advanced tracking of space around the user).
  const lastProcessedFrameRef = useRef<string | null>(null); // ID of the last video frame we sent, so we do not process the same frame twice.

  // --- SPEECH / AUDIO CONTROL (so spoken feedback feels natural and safe) ---
  const isSpeakingRef = useRef<boolean>(false); // Are we currently speaking something aloud right now?
  const speechStartTimeRef = useRef<number>(0); // When the current speech started.
  const speechTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null); // Safety timer in case speech takes too long.
  const lastSpeechEndTimeRef = useRef<number>(0); // When speech last finished, so we can wait a short gap before speaking again.
  const pendingSpeechRef = useRef<string | null>(null); // If a new important message arrives while we are speaking, we store it here to speak next.
  const pendingSpeechPriorityRef = useRef<number>(0); // How urgent the pending message is (0 = normal, 1 = system‑level).

  // --- NAVIGATION / AUTHENTICATION GUARDS (so we don’t repeat actions) ---
  const isNavigatingRef = useRef<boolean>(false); // Are we in the middle of changing screens right now?
  const hasNavigatedRef = useRef<boolean>(false); // Have we already moved away from this screen after login, so we don’t do it twice?
  const hasCheckedAuthRef = useRef<boolean>(false); // Have we already checked if the user is logged in when the app starts?

  // --- AUDIO MODE BOOK‑KEEPING (ensuring the phone audio mode is correct) ---
  const audioSessionActivatedRef = useRef<boolean>(false); // Has the phone’s audio session been prepared for speaking?
  const isRestoringAudioModeRef = useRef<boolean>(false); // Are we currently restoring the audio mode after another feature changed it?

  // --- NETWORK / REQUEST MANAGEMENT ---
  const scanSessionRef = useRef<number>(0); // A simple counter that labels each scanning “session”, to ignore old/cancelled work.
  const activeRequestRef = useRef<AbortController | null>(null); // Allows us to cancel an in‑flight network request if the situation changes.

  // --- SOUND EFFECTS ---
  const captureSoundRef = useRef<Audio.Sound | null>(null); // Sound effect that plays when we take a snapshot.

  // Long-press logout commented out – not needed
  // const logoutHoldTokenRef = useRef<number>(0);
  // const logoutHoldActiveRef = useRef<boolean>(false);
  // const logoutHoldStartTsRef = useRef<number>(0);
  // const logoutCountdownTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  // const logoutHoldArmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // const logoutHoldStartedRef = useRef<boolean>(false);
  // const logoutCompletedRef = useRef<boolean>(false);
  // const wasPausedBeforeLogoutHoldRef = useRef<boolean>(false);

  // Manual tap detection (pure RN touch events)
  const lastTapAtRef = useRef<number>(0);
  const lastTapPointersRef = useRef<number>(0);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressPointersRef = useRef<number>(0);
  const warnedWhileAboveThresholdRef = useRef<boolean>(false); // reset when user lowers below 70%
  const speakVolumeWarningRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const hasSpokenCameraNotConnectedRef = useRef<boolean>(false); // once per connection attempt session
  const hasWarnedPhoneBatteryLowRef = useRef<boolean>(false); // TTS once when phone battery ≤20%
  const hasWarnedUpsideDownTextRef = useRef<boolean>(false); // TTS warning for upside-down text (resets when no upside-down text detected)

  // const clearLogoutCountdownTimeouts = () => { ... };

  const invalidateScanSession = () => {
    scanSessionRef.current += 1;
    if (activeRequestRef.current) {
      activeRequestRef.current.abort();
      activeRequestRef.current = null;
    }
  };

  const playCaptureSound = async () => {
    try {
      let sound = captureSoundRef.current;
      if (!sound) {
        const { sound: s } = await Audio.Sound.createAsync(require('../../assets/sounds/click.wav'));
        captureSoundRef.current = s;
        sound = s;
      }
      await sound.setPositionAsync(0);
      await sound.playAsync();
    } catch {
      // Ignore - e.g. audio not ready or sound load failed
    }
  };

  // Headphone detection for safe volume control
  const { isConnected: headphonesConnected, type: headphoneType } = useHeadphoneDetection();

  const estimateSpeechDurationMs = (text: string) => {
    // Conservative estimate so we don't overlap speech.
    // At rate 0.7: ~1.75 words/sec. Add extra padding for pauses/punctuation.
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const punctuationBoost = (text.match(/[.!?,:;]+/g)?.length ?? 0) * 180;
    return Math.max(700, (wordCount / 1.75) * 1000 + 1200 + punctuationBoost);
  };

  /**
   * Make sure the phone is ready to speak out loud.
   *
   * In plain language:
   * - Some phones (especially iPhones) need their "audio system" to be switched on
   *   before any speech can be played.
   * - This helper does that setup once and remembers it, so later speech works reliably.
   * - If something goes wrong, it quietly reports the error and returns `false`.
   */
  // Ensure audio session is activated and ready for speech (technical note)
  // This is critical for iOS - audio session must be activated before first speech
  const ensureAudioSessionReady = async (): Promise<boolean> => {
    try {
      // If already activated and not restoring, we're good
      if (audioSessionActivatedRef.current && !isRestoringAudioModeRef.current) {
        return true;
      }

      // Set audio mode for playback (TTS)
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
      });

      // On iOS, we need to wait for the audio session to be fully ready
      // This is especially important on first activation
      if (Platform.OS === 'ios') {
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      audioSessionActivatedRef.current = true;
      return true;
    } catch (error) {
      console.error('[Audio Session] Failed to activate audio session:', error);
      return false;
    }
  };

  // Restore audio mode for playback after recording
  // NOTE: Voice-command recording removed; playback mode is initialized at startup.

  /**
   * Actually speak a given piece of text right now.
   *
   * In plain language:
   * - If there is nothing to say, it does nothing.
   * - It first checks that the phone is ready to talk.
   * - Then it uses the system text‑to‑speech to say the words out loud.
   * - While speaking, it:
   *   - Tracks when speech started and ended.
   *   - Vibrates the phone if the volume is very low (so the user knows to turn it up).
   *   - If another message arrives during speech, it remembers the latest one and
   *     plays it next, so the user hears the most relevant information.
   * - There is also a safety timer: if the system forgets to say “I am done”, we stop
   *   waiting after a reasonable time and move on.
   */
  const startSpeakingNow = async (text: string, retryCount: number = 0): Promise<void> => {
    const t = (text || '').trim();
    if (!t) return Promise.resolve();

    // Clear any previous timer
    if (speechTimeoutRef.current) {
      clearTimeout(speechTimeoutRef.current);
      speechTimeoutRef.current = null;
    }

    // Ensure audio session is ready before speaking
    // This is critical for iOS devices, especially on first speech
    const audioReady = await ensureAudioSessionReady();
    if (!audioReady && retryCount < 2) {
      // Retry once after a short delay
      console.log('[Speech] Audio session not ready, retrying...');
      return new Promise((resolve) => {
        setTimeout(() => {
          startSpeakingNow(text, retryCount + 1).then(resolve);
        }, 200);
      });
    }

    if (!audioReady) {
      console.error('[Speech] Failed to activate audio session after retries');
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      try {
        isSpeakingRef.current = true;
        speechStartTimeRef.current = Date.now();

        Speech.speak(t, {
          language: 'en-US',
          rate: 0.7, // slower speech for better clarity
          pitch: 1.0,
          volume: 1,
          onStart: () => {
            // Speech actually started - audio session is working
            audioSessionActivatedRef.current = true;
            // Vibrate when volume below 30% (user likely can't hear) - speaker or earphone
            (async () => {
              try {
                const result = await VolumeManager.getVolume();
                const vol = result?.volume ?? 1;
                if (vol < VIBRATE_VOLUME_THRESHOLD) {
                  Vibration.vibrate([0, 600, 120, 600]); // Double pulse: longer and stronger
                }
              } catch {
                // VolumeManager unavailable (e.g. Expo Go) - skip vibration
              }
            })();
          },
          onDone: () => {
            // Speech finished - clear state and resolve promise
            isSpeakingRef.current = false;
            lastSpeechEndTimeRef.current = Date.now();
            if (speechTimeoutRef.current) {
              clearTimeout(speechTimeoutRef.current);
              speechTimeoutRef.current = null;
            }

            // If something arrived while we were speaking, speak the latest pending next.
            const next = pendingSpeechRef.current;
            const nextPriority = pendingSpeechPriorityRef.current;
            pendingSpeechRef.current = null;
            pendingSpeechPriorityRef.current = 0;

            if (next) {
              // Speak the next pending message
              startSpeakingNow(next);
            }

            resolve();
          },
          onError: (error) => {
            console.error('[Speech] Error during speech:', error);
            isSpeakingRef.current = false;
            lastSpeechEndTimeRef.current = Date.now();
            if (speechTimeoutRef.current) {
              clearTimeout(speechTimeoutRef.current);
              speechTimeoutRef.current = null;
            }
            // Retry if this was the first attempt
            if (retryCount === 0) {
              console.log('[Speech] Retrying after error...');
              startSpeakingNow(text, retryCount + 1).then(resolve);
            } else {
              resolve();
            }
          },
        });

        // Fallback timeout in case onDone doesn't fire (shouldn't happen, but safety net)
        const estimatedDuration = estimateSpeechDurationMs(t);
        speechTimeoutRef.current = setTimeout(() => {
          if (isSpeakingRef.current) {
            console.warn('[Speech] onDone did not fire, using timeout fallback');
            isSpeakingRef.current = false;
            lastSpeechEndTimeRef.current = Date.now();
            speechTimeoutRef.current = null;

            // If something arrived while we were speaking, speak the latest pending next.
            const next = pendingSpeechRef.current;
            const nextPriority = pendingSpeechPriorityRef.current;
            pendingSpeechRef.current = null;
            pendingSpeechPriorityRef.current = 0;

            if (next) {
              // Speak the next pending message
              startSpeakingNow(next);
            }

            resolve();
          }
        }, estimatedDuration);
      } catch (error) {
        console.error('[Speech] Exception during speech:', error);
        isSpeakingRef.current = false;
        if (speechTimeoutRef.current) {
          clearTimeout(speechTimeoutRef.current);
          speechTimeoutRef.current = null;
        }
        // Retry if this was the first attempt
        if (retryCount === 0) {
          console.log('[Speech] Retrying after exception...');
          startSpeakingNow(text, retryCount + 1).then(resolve);
        } else {
          resolve();
        }
      }
    });
  };

  /**
   * Speak a message in a calm, non‑interrupting way.
   *
   * In plain language:
   * - If we are already talking, we do NOT cut off the current sentence.
   * - Instead, we remember the latest thing we should say next, and speak it after.
   * - If we are currently silent, we simply start talking right away.
   */
  // Helper: speak text WITHOUT interrupting ongoing speech.
  // If already speaking, we queue (keep only the latest pending message).
  const speakText = (text: string) => {
    const t = (text || '').trim();
    if (!t) return;

    if (isSpeakingRef.current) {
      // Queue latest normal message (do not interrupt)
      if (pendingSpeechPriorityRef.current <= 0) {
        pendingSpeechRef.current = t;
        pendingSpeechPriorityRef.current = 0;
      }
      return;
    }

    // Ensure audio session is ready before queuing speech
    ensureAudioSessionReady().then(() => {
      startSpeakingNow(t);
    });
  };

  /**
   * Speak a safety warning when the volume is too high while using earphones.
   *
   * In plain language:
   * - This is treated as a safety message, so it is allowed to interrupt anything else.
   * - It stops whatever we are currently saying, clears any queued messages,
   *   and plays: "Volume is high. Please lower the volume to protect your hearing…".
   */
  // Volume warning: INTERRUPT current speech, speak warning via TTS, then app continues
  const speakVolumeWarning = async () => {
    Speech.stop();
    if (speechTimeoutRef.current) {
      clearTimeout(speechTimeoutRef.current);
      speechTimeoutRef.current = null;
    }
    isSpeakingRef.current = false;
    pendingSpeechRef.current = null;
    pendingSpeechPriorityRef.current = 0;
    setSpokenText(formatDisplaySentence('Volume is high. Please lower the volume to protect your hearing when using earphones.'));
    await ensureAudioSessionReady();
    await startSpeakingNow('Volume is high. Please lower the volume to protect your hearing when using earphones.');
  };
  speakVolumeWarningRef.current = speakVolumeWarning;

  /**
   * Speak a warning when the text in view appears upside‑down.
   *
   * In plain language:
   * - If the camera sees text that is flipped, the app warns the user so they can
   *   rotate the page or object.
   * - Like the volume warning, this is allowed to interrupt other speech,
   *   because it helps the user correct the situation.
   */
  // Upside-down text warning: INTERRUPT current speech, speak warning via TTS, then app continues
  const speakUpsideDownTextWarning = async () => {
    Speech.stop();
    if (speechTimeoutRef.current) {
      clearTimeout(speechTimeoutRef.current);
      speechTimeoutRef.current = null;
    }
    isSpeakingRef.current = false;
    pendingSpeechRef.current = null;
    pendingSpeechPriorityRef.current = 0;
    setSpokenText(formatDisplaySentence('Warning: Text appears to be upside down. Please rotate the text.'));
    await ensureAudioSessionReady();
    await startSpeakingNow('Warning: Text appears to be upside down. Please rotate the text.');
  };

  /**
   * Speak short “system” phrases like “I am listening”.
   *
   * In plain language:
   * - These are brief status messages about what the app is doing.
   * - If we are already talking, we line this up to be spoken next with higher priority.
   * - The function returns a promise that completes when the message has finished,
   *   so other code can wait for it if needed.
   */
  // Technical note: for accessibility we do not hard‑interrupt; instead we give this message queue priority.
  // Returns a promise that resolves when speech finishes.
  const speakSystem = async (text: string): Promise<void> => {
    const t = (text || '').trim();
    if (!t) return Promise.resolve();

    // If already speaking, queue this as the next speech (system priority)
    if (isSpeakingRef.current) {
      pendingSpeechRef.current = t;
      pendingSpeechPriorityRef.current = 1;
      // Wait for both current speech and our queued speech to finish
      return new Promise((resolve) => {
        const checkComplete = setInterval(() => {
          // Speech is complete when not speaking AND nothing is pending
          if (!isSpeakingRef.current && pendingSpeechRef.current === null) {
            clearInterval(checkComplete);
            resolve();
          }
        }, 50);
        // Fallback timeout to prevent infinite waiting
        setTimeout(() => {
          clearInterval(checkComplete);
          resolve();
        }, 10000);
      });
    }

    // Ensure audio session is ready before queuing speech
    await ensureAudioSessionReady();
    return startSpeakingNow(t);
  };

  // Long-press logout commented out – not needed
  // const handleLogout = async () => { ... };

  /**
   * Pause the continuous “seeing and speaking” behaviour.
   *
   * In plain language:
   * - Stops any in‑progress server request.
   * - Stops any current speech and clears the speech queue.
   * - Clears the list of visible objects and marks scanning as paused.
   * - Then it clearly says “Scanning Paused” so the user knows the system is resting.
   */
  const pauseScanning = async () => {
    // Interrupt ongoing process: abort inference, stop speech, clear queue
    invalidateScanSession();
    Speech.stop();
    if (speechTimeoutRef.current) {
      clearTimeout(speechTimeoutRef.current);
      speechTimeoutRef.current = null;
    }
    isSpeakingRef.current = false;
    pendingSpeechRef.current = null;
    pendingSpeechPriorityRef.current = 0;

    setDetectedObjects([]);
    setScanningPaused(true);
    setSpokenText(formatDisplaySentence('Scanning Paused'));
    await ensureAudioSessionReady();
    await startSpeakingNow('Scanning Paused');
  };

  /**
   * Resume the continuous “seeing and speaking” behaviour.
   *
   * In plain language:
   * - Stops any current speech and clears the queue, to avoid confusion.
   * - Marks scanning as active again.
   * - Says “Scanning Resumed” so the user knows the system is looking around again.
   */
  const resumeScanning = async () => {
    // Interrupt ongoing speech so "Scanning Resumed" plays immediately
    Speech.stop();
    if (speechTimeoutRef.current) {
      clearTimeout(speechTimeoutRef.current);
      speechTimeoutRef.current = null;
    }
    isSpeakingRef.current = false;
    pendingSpeechRef.current = null;
    pendingSpeechPriorityRef.current = 0;

    setScanningPaused(false);
    setSpokenText(formatDisplaySentence('Scanning Resumed'));
    await ensureAudioSessionReady();
    await startSpeakingNow('Scanning Resumed');
  };

  // Long-press logout commented out – beginLogoutHold / endLogoutHold removed

  /**
   * Clean up messy text that comes back from OCR (text recognition).
   *
   * In plain language:
   * - The text recognition system sometimes returns random characters or very short
   *   fragments that are not useful to read aloud.
   * - Here we:
   *   - Remove extra spaces.
   *   - Throw away very short “words” (less than 3 letters).
   *   - Keep only words made from letters A–Z.
   * - The result is a cleaner sentence that makes more sense when spoken.
   */
  // Helper to clean noisy OCR: keep only plausible English words (3+ letters, A–Z) and join them.
  const cleanOcrText = (text?: string | null): string => {
    if (!text) return '';
    const tokens = text
      .replace(/\s+/g, ' ')
      .split(' ')
      .map(t => t.trim())
      .filter(t => t.length >= 3);

    const wordRegex = /^[A-Za-z]+$/;
    const words = tokens.filter(t => wordRegex.test(t));

    if (words.length === 0) return '';
    return words.join(' ');
  };

  /**
   * Make a short piece of text look like a nice sentence on screen.
   *
   * In plain language:
   * - Trims extra spaces.
   * - Ensures there is a space after commas.
   * - Capitalises the first letter.
   * - Adds a full stop at the end if there is no punctuation.
   * This makes the on‑screen text more readable for sighted helpers or the user.
   */
  // Format text for on-screen display: capitalize first letter, period at end, proper comma spacing.
  const formatDisplaySentence = (text: string): string => {
    if (!text || !text.trim()) return text;
    let s = text.trim().replace(/\s+/g, ' ');
    s = s.replace(/,\s*/g, ', '); // ensure space after comma
    if (s.length === 0) return text;
    s = s.charAt(0).toUpperCase() + s.slice(1);
    const last = s.charAt(s.length - 1);
    if (last !== '.' && last !== '!' && last !== '?') s += '.';
    return s;
  };

  const LONG_PRESS_MS = 700;

  /**
   * Speak out the battery levels of both the camera device and the phone.
   *
   * In plain language:
   * - Cancels any ongoing detection or speech, so the battery message is clear.
   * - Asks the camera stream and the phone for their battery levels (if available).
   * - Builds a simple message like “Camera battery 80 percent. Phone battery 40 percent.”
   * - Speaks that message aloud and also stores it for display on screen.
   */
  const reportBatteries = async () => {
    // Interrupt ongoing process: abort in-flight inference, stop speech, clear queue
    invalidateScanSession();
    Speech.stop();
    if (speechTimeoutRef.current) {
      clearTimeout(speechTimeoutRef.current);
      speechTimeoutRef.current = null;
    }
    isSpeakingRef.current = false;
    pendingSpeechRef.current = null;
    pendingSpeechPriorityRef.current = 0;

    const cameraPercent = m5timerStreamRef.current?.getBatteryPercent?.() ?? null;
    let phonePercent: number | null = null;
    try {
      const level = await Battery.getBatteryLevelAsync();
      if (typeof level === 'number' && level >= 0 && level <= 1) phonePercent = Math.round(level * 100);
    } catch {
      // ignore
    }
    const cameraStr = cameraPercent !== null ? `Camera battery ${cameraPercent} percent.` : 'Camera battery unknown.';
    const phoneStr = phonePercent !== null ? `Phone battery ${phonePercent} percent.` : 'Phone battery unknown.';
    const message = `${cameraStr} ${phoneStr}`;
    setSpokenText(formatDisplaySentence(message));
    await ensureAudioSessionReady();
    await startSpeakingNow(message);
  };

  /**
   * Initial “login” behaviour.
   *
   * In this simplified version of the app, we skip a real login screen
   * and immediately mark the user as authenticated so the camera can be used.
   */
  // Login commented out – always allow camera (no auth check)
  useEffect(() => {
    setIsAuthenticated(true);
    hasCheckedAuthRef.current = true;
  }, []);

  /**
   * Protect the user’s hearing when using earphones.
   *
   * In plain language:
   * - Listens to changes in the system volume.
   * - If earphones are connected and the volume goes above a safe limit,
   *   we trigger a spoken warning (once per “too‑loud” period).
   * - When the user lowers the volume and then raises it too high again,
   *   we warn again.
   */
  // Technical note: Uses `VolumeManager` and headphone detection; on Android uses music volume.
  useEffect(() => {
    if (!ENABLE_VOLUME_RESTRICTION || !headphonesConnected) return;
    const threshold = MAX_VOLUME_WITH_HEADPHONES;
    const getMediaVolume = (result: { volume?: number; music?: number }) => {
      const vol = Platform.OS === 'android' ? (result?.music ?? result?.volume) : result?.volume;
      return typeof vol === 'number' ? vol : 0;
    };
    const checkVolume = (vol: number) => {
      if (vol > threshold) {
        if (!warnedWhileAboveThresholdRef.current) {
          warnedWhileAboveThresholdRef.current = true;
          setTimeout(() => speakVolumeWarningRef.current(), 0);
        }
      } else {
        warnedWhileAboveThresholdRef.current = false;
      }
    };
    const warnIfHigh = async () => {
      try {
        const result = await VolumeManager.getVolume();
        checkVolume(getMediaVolume(result as { volume?: number; music?: number }));
      } catch {
        // VolumeManager unavailable
      }
    };
    warnIfHigh(); // Initial check when earphones connect
    const listener = VolumeManager.addVolumeListener((result: { volume?: number; music?: number }) => {
      checkVolume(getMediaVolume(result));
    });
    return () => listener.remove();
  }, [headphonesConnected]);

  /**
   * Warn the user when the phone battery is getting low.
   *
   * In plain language:
   * - Checks the phone battery roughly once a minute.
   * - If the level drops to 20% or below, it speaks a message like
   *   “Phone battery low. 18 percent remaining. Please charge soon.”
   * - It will only speak once per low‑battery period, until the level
   *   rises above 20% again.
   */
  // TTS warning when phone battery hits 20% or below (once per drop; resets when > 20%)
  useEffect(() => {
    const PHONE_BATTERY_CHECK_MS = 60000; // check every 60 seconds
    const checkPhoneBattery = async () => {
      try {
        const level = await Battery.getBatteryLevelAsync();
        if (typeof level !== 'number' || level < 0) return;
        const percent = Math.round(level * 100);
        if (percent > 20) {
          hasWarnedPhoneBatteryLowRef.current = false;
          return;
        }
        if (!hasWarnedPhoneBatteryLowRef.current) {
          hasWarnedPhoneBatteryLowRef.current = true;
          const msg = `Phone battery low. ${percent} percent remaining. Please charge soon.`;
          setSpokenText(formatDisplaySentence(msg));
          speakSystem(msg);
        }
      } catch {
        // Battery API unavailable
      }
    };
    checkPhoneBattery();
    const interval = setInterval(checkPhoneBattery, PHONE_BATTERY_CHECK_MS);
    return () => clearInterval(interval);
  }, []);

  /**
   * Track how the user is holding the phone (tilt and direction).
   *
   * In plain language:
   * - Listens to the accelerometer and gyroscope sensors.
   * - Estimates whether the phone is tilted up, down, left, or right,
   *   and which direction it is facing.
   * - Smooths these readings so they are not too jumpy.
   * - This information can later be used to give better guidance
   *   about where objects are relative to the user.
   */
  // Device orientation detection
  useEffect(() => {
    let accelerometerSubscription: any;
    let gyroscopeSubscription: any;

    const startOrientationDetection = async () => {
      try {
        // Set update intervals
        Accelerometer.setUpdateInterval(100); // 10Hz
        Gyroscope.setUpdateInterval(100);

        // Subscribe to accelerometer data
        accelerometerSubscription = Accelerometer.addListener((accelerometerData: any) => {
          const { x, y, z } = accelerometerData;
          
          // Calculate pitch (rotation around X-axis)
          const pitch = Math.atan2(-y, Math.sqrt(x * x + z * z)) * (180 / Math.PI);
          
          // Calculate roll (rotation around Y-axis)
          const roll = Math.atan2(x, z) * (180 / Math.PI);
          
          // Smooth the orientation data
          setDeviceOrientation(prev => ({
            pitch: prev.pitch * 0.8 + pitch * 0.2, // Smoothing factor
            roll: prev.roll * 0.8 + roll * 0.2,
            yaw: prev.yaw // Keep yaw from previous calculation
          }));
        });

        // Subscribe to gyroscope data for yaw
        gyroscopeSubscription = Gyroscope.addListener((gyroscopeData: any) => {
          const { z } = gyroscopeData;
          
          // Integrate gyroscope data for yaw (simplified)
          setDeviceOrientation(prev => ({
            ...prev,
            yaw: prev.yaw + z * 0.1 // Simple integration
          }));
        });

      } catch (error) {
        console.log('Orientation detection failed:', error);
      }
    };

    startOrientationDetection();

    // Cleanup
    return () => {
      if (accelerometerSubscription) {
        accelerometerSubscription.remove();
      }
      if (gyroscopeSubscription) {
        gyroscopeSubscription.remove();
      }
    };
  }, []);

  // Remove device-orientation mapping; rely on server screen-space analysis


  /**
   * Decide whether the app should consider itself “offline”.
   *
   * In plain language:
   * - Whenever a network request finishes, we call this helper with success/failure.
   * - On success: we reset the failure counter and mark the app as online.
   * - On failure: we increase a counter, and only after 3 failures in a row
   *   do we mark the app as offline (to avoid over‑reacting to a one‑off glitch).
   */
  // Robust offline detection with retry logic
  const handleNetworkResponse = (success: boolean, error?: any) => {
    if (success) {
      // Reset failure counter on successful request
      setConsecutiveFailures(0);
      setOffline(false);
    } else {
      // Increment failure counter
      const newFailureCount = consecutiveFailures + 1;
      setConsecutiveFailures(newFailureCount);
      
      // Only go offline after 3 consecutive failures
      if (newFailureCount >= 3) {
        setOffline(true);
        console.log('Going offline after 3 consecutive failures');
      } else {
        console.log(`Network issue (${newFailureCount}/3): ${error?.message || 'Unknown error'}`);
      }
    }
  };

  // 1 meter = 3.28084 feet (international foot)
  const METERS_TO_FEET = 3.28084;

  /**
   * Turn an approximate distance in meters into a simple spoken range in feet.
   *
   * In plain language:
   * - The app often only has a rough estimate of distance, not an exact number.
   * - Instead of saying “4.2 feet”, we group distances into friendly ranges:
   *   - 0–3 ft, 3–6 ft, 6–9 ft, 9–12 ft, 12–15 ft.
   * - For small objects (like a phone or cup) we only use the closer ranges,
   *   because beyond 6 ft they are usually less relevant.
   */
  // Convert estimated meters to feet, then to a range label (emphasizes estimation, not exact distance).
  // 3-foot increments: 0-3, 3-6, 6-9, 9-12, 12-15 ft. Max at 15 ft.
  // For small objects only 0-3 ft and 3-6 ft.
  const metersToRangeLabel = (meters: number, isSmallObject?: boolean): string => {
    let feet = Math.max(0, meters) * METERS_TO_FEET;
    if (isSmallObject) feet = Math.min(feet, 6); // Small objects: only 0-3 ft and 3-6 ft
    if (feet <= 3) return '0-3 ft';
    else if (feet <= 6) return '3-6 ft';
    else if (feet <= 9) return '6-9 ft';
    else if (feet <= 12) return '9-12 ft';
    else if (feet <= 15) return '12-15 ft';
    else return '0-3 ft'; // do not changed
  };

  // Same buckets in feet, phrased for TTS. 3-foot increments: 0-3, 3-6, 6-9, 9-12, 12-15 ft.
  // For small objects only "0 to 3 feet" or "3 to 6 feet".
  const metersToRangeTTS = (meters: number, isSmallObject?: boolean): string => {
    let feet = Math.max(0, meters) * METERS_TO_FEET;
    if (isSmallObject) feet = Math.min(feet, 6);
    if (feet <= 3) return '0 to 3 feet';
    else if (feet <= 6) return '3 to 6 feet';
    else if (feet <= 9) return '6 to 9 feet';
    else if (feet <= 12) return '9 to 12 feet';
    else if (feet <= 15) return '12 to 15 feet';
    else return '0 to 3 feet'; // do not changed
  };

  // Distance estimation: return a single distance in meters for display/speech.
  // Prefer server-side physical meters when reliable; otherwise derive an approximate
  // distance from MiDaS closeness.
  const estimateDistanceMeters = (
    miDaSDepth: number, 
    objectName: string, 
    confidence: number,
    bboxHeightRatio?: number,
    bboxAreaRatio?: number,
    isSmallObject?: boolean,
    objectDistanceMeters?: number,
    recommendedSource?: string
  ): number => {
    try {
      const hasMeters = typeof objectDistanceMeters === 'number' && objectDistanceMeters > 0;
      const bh = bboxHeightRatio ?? 0;
      const conf = Math.max(0, Math.min(1, confidence));

      // 1) Preferred path: server-provided distance in meters (metric or physical).
      const shouldUsePhysical =
        hasMeters &&
        (
          recommendedSource === 'physical' ||
          recommendedSource === 'fused' ||
          recommendedSource === 'metric' ||
          (bh > 0.02 && conf >= 0.5)
        );

      if (shouldUsePhysical && hasMeters) {
        const dMetersRaw = objectDistanceMeters as number;
        // Clamp meters to a reasonable band to avoid extreme values.
        const dMeters = Math.max(0.3, Math.min(10, dMetersRaw));

        console.log(
          `[Distance] Using SERVER meters for ${objectName}: d=${dMeters.toFixed(2)}m, bh=${bh.toFixed(
            3
          )}, conf=${conf.toFixed(2)}, source=${recommendedSource || 'auto'}`
        );
        return dMeters;
      }

      // 2) Fallback: MiDaS-only estimation when physical distance is unavailable or not recommended.
      // Server sends MiDaS "closeness" in [0..1] where higher = closer.
      const d = Math.max(0, Math.min(1, miDaSDepth));
      const adjusted = Math.max(0, Math.min(1, d - 0.15 * (1 - conf)));

      // Map MiDaS "closeness" bands into approximate meter distances.
      // These midpoints correspond loosely to the former step buckets assuming ~0.75m/step.
      let dMeters: number;
      if (adjusted >= 0.80) dMeters = 1.0;      // very close
      else if (adjusted >= 0.65) dMeters = 2.0; // near
      else if (adjusted >= 0.50) dMeters = 3.0; // mid
      else if (adjusted >= 0.35) dMeters = 4.0;
      else if (adjusted >= 0.20) dMeters = 5.0;
      else dMeters = 7.0;                      // far

      console.log(
        `[Distance] Using MiDaS for ${objectName}: depth=${d.toFixed(3)}, adjusted=${adjusted.toFixed(
          3
        )}, bh=${bh.toFixed(3)}, conf=${conf.toFixed(2)}, small=${!!isSmallObject} -> ~${dMeters.toFixed(2)}m`
      );

      return dMeters;
    } catch (error) {
      console.log('Distance estimation failed:', error);
      return 1.0;
    }
  };

  /**
   * Early audio setup when the screen first loads.
   *
   * In plain language:
   * - As soon as this screen mounts, we gently prepare the audio system
   *   so that text‑to‑speech works smoothly later.
   * - We do not fully “activate” it yet; that happens the first time we speak.
   * - On iPhones, we wait a short moment to let the system finish setting up.
   */
  // Initialize audio mode for playback (TTS) at startup
  // This ensures audio session is ready for speech from the start
  useEffect(() => {
    (async () => {
      try {
        // Initialize audio session early, but don't mark as activated yet
        // It will be activated on first speech attempt
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          shouldDuckAndroid: true,
        });
        // Small delay to let iOS initialize the session
        if (Platform.OS === 'ios') {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      } catch (e) {
        console.log('Audio mode initialization failed:', e);
      }
    })();
  }, []);

  // Phone camera commented out – permission not needed for M5-only
  // useEffect(() => {
  //   (async () => {
  //     if (!permission?.granted) await requestPermission();
  //   })();
  // }, []);

  // Reset frame tracking when switching camera sources (M5-only: cameraSource fixed to m5timer)
  useEffect(() => {
    lastProcessedFrameRef.current = null;
    // setCameraReady(false);
    console.log(`[Camera] Source: ${cameraSource}, resetting frame state`);
  }, [cameraSource]);


  /**
   * Main “capture and understand” loop.
   *
   * In plain language:
   * - While the user is authenticated, scanning is not paused, and the M5 camera
   *   is connected, the app repeatedly:
   *     1. Waits until we are not currently speaking, and until a short quiet period
   *        has passed after the last speech (so we do not talk over ourselves).
   *     2. Asks the M5 camera for a fresh image (skipping repeated frames).
   *     3. Plays a short click sound to indicate a snapshot.
   *     4. Shrinks and compresses the image to save bandwidth.
   *     5. Sends the image to the server, with a time limit so we do not hang forever.
   *     6. Updates network “online/offline” status based on the result.
   *     7. Reads back any detected objects, distance information, and text.
   *     8. If enough time has passed since we last spoke, builds a friendly
   *        spoken summary (nearest important objects first) and speaks it.
   * - All of this is done carefully so that if scanning is paused, the user logs out,
   *   or a newer session starts, we quietly stop processing old results.
   */
  // Capture loop with dynamic intervals
  useEffect(() => {
    if (!isAuthenticated) return;
    if (scanningPaused) return;
    
    // M5-only: only check M5 connection (phone camera branch commented out)
    // if (cameraSource === 'phone' && (!permission?.granted || !cameraReady)) return;
    if (!m5timerConnected) return;

    const captureAndProcess = async () => {
      if (!isAuthenticated) return;
      if (scanningPaused) return;
      const sessionId = scanSessionRef.current;
      
      // Don't capture while speech is happening
      if (isSpeakingRef.current) {
        return;
      }
      
      // Don't capture within 3 seconds after speech ended (only if speech has actually happened)
      if (lastSpeechEndTimeRef.current > 0) {
        const timeSinceSpeechEnd = Date.now() - lastSpeechEndTimeRef.current;
        if (timeSinceSpeechEnd < POST_SPEECH_WAIT_MS) {
          return;
        }
      }

      // Only one /infer request at a time – skip this tick if one is already in progress
      if (activeRequestRef.current) {
        console.log('Inference already in progress, skipping capture tick');
        return;
      }

      try {
        let imageUri: string | null = null;

        // M5-only: phone camera capture commented out
        // if (cameraSource === 'phone') {
        //   if (!cameraRef.current || !cameraReady) { console.log('Camera not ready'); return; }
        //   const photo = await cameraRef.current.takePictureAsync({ skipProcessing: true });
        //   if (!photo) return;
        //   imageUri = photo.uri;
        // } else {
        if (!m5timerStreamRef.current || !m5timerConnected) {
          console.log('M5Timer Camera not ready');
          return;
        }
        imageUri = await m5timerStreamRef.current.captureFrame();
        if (!imageUri) {
          console.log('No frame available from M5Timer Camera - skipping this capture');
          return;
        }
        if (imageUri === lastProcessedFrameRef.current) {
          console.log('Same frame detected, skipping to avoid infinite loop');
          return;
        }
        lastProcessedFrameRef.current = imageUri;
        // }

        if (!imageUri) return;

        playCaptureSound();

        // Resize & compress
        const resized = await ImageManipulator.manipulateAsync(
          imageUri,
          [{ resize: { width: RESIZE, height: RESIZE } }],
          { compress: JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG }
        );

        // Send to server with timeout
        console.log('Sending request to:', `${SERVER_URL}/infer`);
        
        const controller = new AbortController();
        activeRequestRef.current = controller;
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout for Azure VM (YOLO + depth + OCR)
        
        try {
          const response = await fetch(`${SERVER_URL}/infer`, {
            method: 'POST',
            body: createFormData(resized.uri),
            signal: controller.signal,
          });
          
          clearTimeout(timeoutId);
          if (sessionId !== scanSessionRef.current || scanningPaused || !isAuthenticated) {
            return;
          }
          console.log('Response status:', response.status);

          if (!response.ok) {
            // Handle different error types
            if (response.status >= 500) {
              // Server error - temporary, don't count as failure
              console.log('Server error (temporary):', response.status);
              handleNetworkResponse(false, new Error(`Server error: ${response.status}`));
              return;
            } else if (response.status === 404) {
              // Endpoint not found - likely configuration issue
              console.log('Endpoint not found:', response.status);
              handleNetworkResponse(false, new Error('Server endpoint not found'));
              return;
            } else {
              // Other client errors
              console.log('Client error:', response.status);
              handleNetworkResponse(false, new Error(`Client error: ${response.status}`));
              return;
            }
          }

          // Success - reset offline state
          handleNetworkResponse(true);
          const data = await response.json();
          if (sessionId !== scanSessionRef.current || scanningPaused || !isAuthenticated) {
            return;
          }

          // Update depth
          setDepth(data.depth ?? 0);

          // Check for upside-down text warnings
          let hasUpsideDownText = false;
          
          // Check full-image OCR for upside-down text
          if (data.fullOcrUpsideDown === true) {
            hasUpsideDownText = true;
          }
          
          // Check object-specific OCR for upside-down text
          if (data.objects && data.objects.length > 0) {
            for (const obj of data.objects) {
              if (obj.ocrUpsideDown === true && obj.ocrText) {
                hasUpsideDownText = true;
                break;
              }
            }
          }
          
          // Trigger audio warning if upside-down text detected (only once per detection session)
          if (hasUpsideDownText && !hasWarnedUpsideDownTextRef.current) {
            hasWarnedUpsideDownTextRef.current = true;
            // Use setTimeout to avoid blocking the response processing
            setTimeout(() => {
              speakUpsideDownTextWarning();
            }, 100);
          } else if (!hasUpsideDownText) {
            // Reset warning flag when no upside-down text is detected
            hasWarnedUpsideDownTextRef.current = false;
          }

          // Process all detected objects
          if (data.objects && data.objects.length > 0) {
            // If multiple doors are detected, keep only the one with highest confidence
            let processedObjects = [...data.objects];
            const doorObjects = processedObjects.filter((obj: any) => 
              obj.label && obj.label.toLowerCase().includes('door')
            );
            if (doorObjects.length > 1) {
              // Find the door with highest confidence
              const bestDoor = doorObjects.reduce((best: any, current: any) => 
                (current.confidence || 0) > (best.confidence || 0) ? current : best
              );
              // Remove all doors and add back only the best one
              processedObjects = processedObjects.filter((obj: any) => 
                !obj.label || !obj.label.toLowerCase().includes('door')
              );
              processedObjects.push(bestDoor);
            }
            
            setDetectedObjects(processedObjects);

            // Speak if above threshold & cooldown passed
            const now = Date.now();
            if (now - lastSpoken > COOLDOWN_MS) {
              setLastSpoken(now);

              // Build multi-object TTS message, speaking nearest objects first.
              const ttsMessages: string[] = [];
              // Track how many times we've seen each label so we can say "Another ..."
              const seenLabelCounts: Record<string, number> = {};
              // Track if we have multiple objects with the same label
              const hasDuplicateLabels: Record<string, boolean> = {};

              // Prepare objects with a numeric distance score (lower = closer) so we can sort.
              const objectsForSpeech = processedObjects
                .filter((obj: any) => obj.confidence >= CONFIDENCE_THRESHOLD)
                .map((obj: any) => {
                  const serverMeters =
                    obj.recommendedDistanceSource === 'fused' && typeof obj.fusedDistance === 'number'
                      ? obj.fusedDistance
                      : obj.objectDistance;
                  const distanceMeters = estimateDistanceMeters(
                    obj.midasDistance || 0,
                    obj.label || 'unknown',
                    obj.confidence || 0,
                    obj.bboxHeightRatio,
                    obj.bboxAreaRatio,
                    obj.isSmallObject,
                    serverMeters,
                    obj.recommendedDistanceSource
                  );

                  // Use estimated meters directly as a numeric score for sorting (lower = closer).
                  const score = typeof distanceMeters === 'number' ? distanceMeters : 999;

                  return { obj, distanceMeters, distanceScore: score };
                })
                .sort((a: any, b: any) => a.distanceScore - b.distanceScore);

              for (const { obj, distanceMeters } of objectsForSpeech) {
                // Create base message for this object
                const baseName = obj.label ?? `Class ${obj.classIndex}`;
                const labelKey = baseName.trim().toLowerCase();
                const prevCount = seenLabelCounts[labelKey] ?? 0;
                seenLabelCounts[labelKey] = prevCount + 1;
                
                // Mark if we have duplicates of this label
                if (prevCount > 0) {
                  hasDuplicateLabels[labelKey] = true;
                }

                // Determine if object is near or far based on distance and build text.
                // Use range phrasing in feet (e.g. "0 to 3 feet") so it's clear we're estimating.
                let isNear = false;
                let distanceText = '';
                const d = typeof distanceMeters === 'number' && distanceMeters > 0 ? distanceMeters : 0;
                if (d > 0) {
                  isNear = d <= 1.5;
                  const rangeTTS = metersToRangeTTS(d, obj.isSmallObject);
                  distanceText = `, approximately ${rangeTTS} `;
                }

                const positionText =
                  obj.position === 'left' || obj.position === 'right'
                    ? ` to your ${obj.position}`
                    : obj.position === 'center'
                      ? ' in front of you'
                      : '';

                // Build message based on whether it's near/far and first/duplicate
                let objectMessage = '';
                
                if (prevCount > 0) {
                  // This is a duplicate label
                  if (isNear) {
                    // Near duplicate: "Another [Object] is near, approximately 0 to 4 feet"
                    objectMessage = `Another ${baseName}${positionText} is near${distanceText}`;
                  } else {
                    // Far duplicate: "Another [Object] detected, approximately 4 to 8 feet"
                    objectMessage = `Another ${baseName}${positionText} detected${distanceText}`;
                  }
                } else {
                  // First instance of this label
                  if (isNear) {
                    // Near object: "[Object] is near, approximately 0 to 4 feet"
                    objectMessage = `${baseName}${positionText} is near${distanceText}`;
                  } else {
                    // Far object: "[Object] detected, approximately 4 to 8 feet"
                    objectMessage = `${baseName}${positionText} detected${distanceText}`;
                  }
                }

                // Append cleaned OCR text if available
                const rawOcrText: string | undefined = obj.ocrText;
                const cleanedOcr = cleanOcrText(rawOcrText);

                // Object-specific OCR phrasing:
                // - bottle/book -> "The <object>'s label is ..."
                // - default -> "text says ..."
                let ocrPart = '';
                if (cleanedOcr.length > 0) {
                  const normalizedLabel = baseName.trim().toLowerCase();
                  const normalizedText = cleanedOcr.trim().toLowerCase();

                  // Only add OCR if the text is meaningfully different from the label
                  if (normalizedText !== normalizedLabel) {
                    const isBottle = normalizedLabel.includes('bottle');
                    const isBook = normalizedLabel.includes('book');

                    if (isBottle || isBook) {
                      // Keep the user's chosen object name (e.g. "bottle", "book", "water bottle")
                      ocrPart = `. The ${baseName}'s label is ${cleanedOcr}.`;
                    } else {
                      ocrPart = `, text says ${cleanedOcr}`;
                    }
                  }
                }

                const finalMessage = `${objectMessage}${ocrPart}`.trim();
                ttsMessages.push(finalMessage);
              }

              // Speak all objects in one sentence
              if (ttsMessages.length > 0) {
                let fullText = '';
                
                // Check if we have any duplicate labels
                const hasDuplicates = Object.values(hasDuplicateLabels).some(v => v);
                
                if (ttsMessages.length === 1) {
                  fullText = ttsMessages[0];
                } else if (ttsMessages.length === 2) {
                  fullText = `${ttsMessages[0]} and ${ttsMessages[1]}`;
                } else {
                  const lastObject = ttsMessages[ttsMessages.length - 1];
                  const otherObjects = ttsMessages.slice(0, -1);
                  fullText = `${otherObjects.join(', ')}, and ${lastObject}`;
                }
                
                setSpokenText(formatDisplaySentence(fullText));
                speakText(fullText);
              }
            }
          } else {
            setDetectedObjects([]);

            // If there are no objects but we have full-image OCR, speak cleaned words
            // and also estimate side (left/center/right) and distance using MiDaS
            const fullOcrText: string | undefined = data.fullOcrText;
            const midasPosition: any | undefined = data.midasPosition;
            const now = Date.now();
            const cleanedFullOcr = cleanOcrText(fullOcrText);

            if (cleanedFullOcr.length > 0 && now - lastSpoken > COOLDOWN_MS) {
              const cleanedText = cleanedFullOcr;
              const message = formatDisplaySentence(`Text says: ${cleanedText}`);
              setLastSpoken(now);
              setSpokenText(message);
              speakText(message);
            } else if (cleanedFullOcr.length === 0 && now - lastSpoken > COOLDOWN_MS) {
              const message = formatDisplaySentence('No object or text detected');
              setLastSpoken(now);
              setSpokenText(message);
              speakText(message);
            }
          }
        
        } catch (fetchError: any) {
          clearTimeout(timeoutId);
          
          if (fetchError.name === 'AbortError') {
            console.log('Request timeout');
            handleNetworkResponse(false, new Error('Request timeout'));
          } else if (fetchError.message?.includes('Network request failed')) {
            console.log('Network request failed');
            setSpokenText(formatDisplaySentence('Your internet is slow.'));
            speakText('Your internet is slow.');
            handleNetworkResponse(false, new Error('Network request failed'));
          } else {
            console.log('Fetch error:', fetchError);
            handleNetworkResponse(false, fetchError);
          }
        } finally {
          if (activeRequestRef.current === controller) {
            activeRequestRef.current = null;
          }
        }
      } catch (e) {
        console.log('General error in captureAndProcess:', e);
        handleNetworkResponse(false, e);
      }
    };

    // Initial capture
    captureAndProcess();

    // Set up fixed 5 second interval
    const interval = setInterval(captureAndProcess, CAPTURE_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [isAuthenticated, m5timerConnected, scanningPaused]);

  // Prevent rendering if not authenticated - show loading while checking
  if (!hasCheckedAuthRef.current) {
    return (
      <View style={styles.fullscreenCenter}>
        <Text style={styles.infoText}>Checking authentication...</Text>
      </View>
    );
  }

  // Login commented out – no redirect; camera always shown when ready
  // if (!isAuthenticated) { return (...Redirecting to login...); }

  // Phone camera permission checks – commented out for M5-only (permission not needed)
  // if (cameraSource === 'phone') {
  //   if (!permission) return (
  //     <View style={styles.fullscreenCenter}>
  //       <Text style={styles.infoText}>Requesting camera permission...</Text>
  //     </View>
  //   );
  //   if (!permission.granted) return (
  //     <View style={styles.fullscreenCenter}>
  //       <Text style={styles.infoText}>No access to camera</Text>
  //       <Text style={styles.infoSubtext} onPress={() => requestPermission()}>Tap to request permission</Text>
  //     </View>
  //   );
  // }

  const handleTouchStart = (e: any) => {
    const pointers = e?.nativeEvent?.touches?.length ?? 0;

    if (pointers === 1) {
      longPressPointersRef.current = 1;
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null;
        if (longPressPointersRef.current === 1) {
          reportBatteries();
          lastTapAtRef.current = 0;
        }
      }, LONG_PRESS_MS);
    }

    const now = Date.now();
    const windowMs = 260;
    const isSecondTap = now - lastTapAtRef.current <= windowMs && lastTapPointersRef.current === pointers;

    if (isSecondTap) {
      lastTapAtRef.current = 0;
      lastTapPointersRef.current = 0;
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      if (pointers >= 2) {
        resumeScanning();
      } else if (pointers === 1) {
        if (scanningPaused) {
          resumeScanning();
        } else {
          pauseScanning();
        }
      }
      return;
    }

    lastTapAtRef.current = now;
    lastTapPointersRef.current = pointers;
  };

  const handleTouchEnd = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  // Split spoken text into [bold object name, rest] for object-detection phrases.
  const getSpokenTextSegments = (text: string): { bold: boolean; text: string }[] => {
    if (!text || !text.trim()) return [];
    const separators = [' to your ', ' is near', ' detected', ' in front of you'];
    const segments: { bold: boolean; text: string }[] = [];
    const t = text.trim();
    let clauses: string[];
    if (t.includes(', and ')) {
      const parts = t.split(', and ');
      clauses = [...parts[0].split(',').map((s) => s.trim()), parts[parts.length - 1].trim()];
    } else {
      clauses = t.split(/\s+and\s+/).map((s) => s.trim());
    }
    for (let c = 0; c < clauses.length; c++) {
      const clause = clauses[c];
      if (!clause) continue;
      let earliest = -1;
      let matchedSep = '';
      for (const sep of separators) {
        const i = clause.indexOf(sep);
        if (i !== -1 && (earliest === -1 || i < earliest)) {
          earliest = i;
          matchedSep = sep;
        }
      }
      if (earliest > 0) {
        segments.push({ bold: true, text: clause.slice(0, earliest) });
        segments.push({ bold: false, text: matchedSep + clause.slice(earliest + matchedSep.length) });
      } else {
        segments.push({ bold: false, text: clause });
      }
      if (c < clauses.length - 1) {
        const connector = clauses.length === 2 ? ' and ' : (c < clauses.length - 2 ? ', ' : ', and ');
        segments.push({ bold: false, text: connector });
      }
    }
    return segments;
  };

  const m5BatteryColor = m5BatteryPercent === null ? '#888' : m5BatteryPercent > 50 ? '#34C759' : m5BatteryPercent > 20 ? '#FFCC00' : '#FF3B30';
  const topInset = Math.max(insets.top, 24);

  return (
      <View style={[styles.container, { paddingTop: topInset }]}>
        <StatusBar style="light" />
      {/* 1. M5 camera status row (battery hidden, connection shown) */}
      <View style={styles.m5BatteryBar}>
        {/* Battery icon and percentage temporarily hidden */}
        {/*
        <View style={styles.m5BatteryRowLeft}>
          <View style={styles.m5BatteryOuter}>
            <View
              style={[
                styles.m5BatteryFill,
                {
                  width: `${m5BatteryPercent !== null ? m5BatteryPercent : 0}%`,
                  backgroundColor: m5BatteryColor,
                },
              ]}
            />
          </View>
          <View style={styles.m5BatteryNub} />
          <Text style={styles.m5BatteryPercentText}>
            {m5BatteryPercent !== null ? `${m5BatteryPercent}%` : '--'}
          </Text>
        </View>
        */}
        <View style={styles.m5CameraConnectedRow}>
          <Image
            source={require('../../assets/images/cameraconnected.png')}
            style={styles.m5CameraConnectedIcon}
            resizeMode="contain"
          />
          <Text style={styles.m5CameraConnectedText}>
            {m5timerConnected ? 'Camera Connected' : 'Camera connecting…'}
          </Text>
        </View>
      </View>

      {/* 2. TTS display – always visible */}
      <View style={styles.ttsBar}>
          <View style={styles.ttsBoxOuter}>
            <View style={styles.ttsBoxInner}>
              <ScrollView style={styles.ttsScroll} contentContainerStyle={styles.ttsScrollContent} nestedScrollEnabled showsVerticalScrollIndicator={false}>
                <Text style={styles.ttsBoxText}>
                  {scanningPaused && !spokenText
                    ? 'Paused.'
                    : spokenText
                      ? getSpokenTextSegments(spokenText).map((seg, i) =>
                          seg.bold ? (
                            <Text key={i} style={[styles.ttsBoxText, styles.ttsBoxTextBold]}>{seg.text}</Text>
                          ) : (
                            <Text key={i}>{seg.text}</Text>
                          )
                        )
                      : '—'}
                </Text>
              </ScrollView>
            </View>
          </View>
        </View>

      {/* 3. Camera (MJPEG stream) */}
      {/* {cameraSource === 'phone' ? (
        <CameraView
          ref={cameraRef}
          style={styles.camera}
          facing="back"
          onCameraReady={() => { setCameraReady(true); setCameraError(null); }}
          onMountError={(e) => { setCameraError('Camera mount error'); setCameraReady(false); }}
        />
      ) : ( */}
        <MJPEGStreamViewer
          ref={m5timerStreamRef}
          style={styles.camera}
          showBatteryInOverlay={false}
          onBatteryPercentChange={setM5BatteryPercent}
          onConnectionChange={(connected) => {
            setM5timerConnected(connected);
            setCameraReady(connected);
            if (!connected) {
              setM5BatteryPercent(null);
              setCameraError('M5Timer Camera disconnected');
              if (!hasSpokenCameraNotConnectedRef.current) {
                hasSpokenCameraNotConnectedRef.current = true;
                const msg = 'Camera not connected.';
                setSpokenText(formatDisplaySentence(msg));
                speakText(msg);
              }
            } else {
              setCameraError(null);
              hasSpokenCameraNotConnectedRef.current = false;
            }
          }}
          onError={(error) => {
            setCameraError(error);
            setM5timerConnected(false);
            if (!hasSpokenCameraNotConnectedRef.current) {
              hasSpokenCameraNotConnectedRef.current = true;
              const msg = 'Camera not connected.';
              setSpokenText(formatDisplaySentence(msg));
              speakText(msg);
            }
          }}
          onBatteryLow={(percent) => {
            speakSystem(`M5 camera battery low. ${percent} percent remaining. Please charge soon.`);
          }}
        />
      {/* )} */}
      
      <View
        style={styles.overlay}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        {/* Phone camera status – commented out for M5-only */}
        {/* {cameraSource === 'phone' && !cameraReady && !cameraError && (
          <Text style={styles.statusText}>Opening camera…</Text>
        )} */}
        {!!cameraError && (
          <Text style={styles.errorText}>Camera error: {cameraError}</Text>
        )}
        {offline && <Text style={styles.offline}></Text>}
      </View>
      
      {/* 4. Bottom panel */}
      <View style={styles.bottomPanel}>
        <View style={styles.infoColumn}>
          <Text style={styles.infoPrimary}>
            {detectedObjects.length > 0 && detectedObjects[0].position
              ? detectedObjects[0].position.charAt(0).toUpperCase() + detectedObjects[0].position.slice(1)
              : '—'
            }
          </Text>
          <Text style={styles.infoSecondary}>Position</Text>
        </View>
        <View style={styles.infoColumn}>
          <Text style={styles.infoPrimary}>
              {detectedObjects.length > 0 ? 
              (() => {
                const dMeters = estimateDistanceMeters(
                  detectedObjects[0].midasDistance || 0,
                  detectedObjects[0].label || 'unknown',
                  detectedObjects[0].confidence || 0,
                  detectedObjects[0].bboxHeightRatio,
                  detectedObjects[0].bboxAreaRatio,
                  detectedObjects[0].isSmallObject,
                  detectedObjects[0].objectDistance,
                  detectedObjects[0].recommendedDistanceSource
                );
                return metersToRangeLabel(dMeters, detectedObjects[0].isSmallObject);
              })()
              : '—'
            }
          </Text>
          <Text style={styles.infoSecondary}>Distance</Text>
        </View>
        <View style={styles.infoColumn}>
          <Text style={styles.infoPrimary}>
            {detectedObjects.length > 0 && typeof detectedObjects[0].confidence === 'number'
              ? `${(detectedObjects[0].confidence * 100).toFixed(0)}%`
              : '—'}
          </Text>
          <Text style={styles.infoSecondary}>Confidence</Text>
        </View>
      </View>
    </View>
  );
}

// Helper: multipart/form-data
function createFormData(uri: string) {
  const data = new FormData();
  data.append('file', { uri, name: 'photo.jpg', type: 'image/jpeg' } as any);
  return data;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  camera: { flex: 1, marginTop: -100, marginBottom: 28 },
  overlay: { 
    position: 'absolute', 
    top: 0, 
    left: 0, 
    right: 0, 
    bottom: 0,
    justifyContent: 'flex-start',
    alignItems: 'center',
    paddingTop: 12,
  },
  fullscreenCenter: { flex: 1, backgroundColor: 'black', alignItems: 'center', justifyContent: 'center' },
  infoText: { color: 'white', fontSize: 16, fontWeight: '600' },
  infoSubtext: { color: 'lightblue', marginTop: 8, textDecorationLine: 'underline' },

  // TTS bar above camera – framed box like reference image (#FFE497)
  m5BatteryBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginHorizontal: 16,
    marginTop: 36,
    marginBottom: 4,
    borderRadius: 4,
  },
  m5BatteryRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  m5BatteryOuter: {
    width: 28,
    height: 12,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  m5BatteryFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    minWidth: 0,
    borderRadius: 1,
  },
  m5BatteryNub: {
    width: 2,
    height: 6,
    backgroundColor: 'rgba(255,255,255,0.5)',
    marginLeft: -1,
    borderRadius: 0,
  },
  m5BatteryPercentText: {
    color: 'white',
    fontSize: 11,
    marginLeft: 4,
    fontWeight: '600',
  },
  m5CameraConnectedRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  m5CameraConnectedIcon: {
    width: 22,
    height: 22,
    marginRight: 6,
  },
  m5CameraConnectedText: {
    color: 'white',
    fontSize: 11,
    fontWeight: '600',
  },
  ttsBar: {
    paddingHorizontal: 16,
    paddingTop: 2,
    paddingBottom: 0,
    marginTop: 20,
    height: 102,
    backgroundColor: 'transparent',
    zIndex: 10,
    elevation: 10,
  },
  ttsBoxOuter: {
    backgroundColor: '#D4B85C',
    borderRadius: 14,
    padding: 2,
    alignSelf: 'stretch',
    height: 100,
    shadowColor: '#000',
    shadowOffset: { width: 1, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
    elevation: 3,
  },
  ttsBoxInner: {
    backgroundColor: '#FFE497',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#E8D48B',
    height: 96,
    overflow: 'hidden',
  },
  ttsScroll: {
    flex: 1,
    maxHeight: 72,
  },
  ttsScrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  ttsBoxText: {
    color: '#333',
    fontSize: 13,
    textAlign: 'center',
  },
  ttsBoxTextBold: {
    fontWeight: 'bold',
  },
  
  // Spoken text (legacy; TTS now in ttsBar)
  spokenText: { 
    color: 'white', 
    fontSize: 16, 
    fontWeight: '600', 
    marginBottom: 4,
    textAlign: 'center'
  },
  statusText: { 
    color: 'white', 
    marginBottom: 6,
    textAlign: 'center'
  },
  errorText: { 
    color: 'red', 
    marginBottom: 6,
    textAlign: 'center'
  },
  
  // Object detection display
  objectDetectionContainer: {
    position: 'absolute',
    top: 50, // Move to top of screen with some padding
    left: '50%',
    transform: [{ translateX: -100 }], // Remove translateY to keep it at top
    alignItems: 'center',
  },
  objectInfoBox: {
    backgroundColor: '#FFE4B5', // Light yellow background like in the image
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
    minWidth: 120,
  },
  objectLabel: { 
    fontSize: 16, 
    color: 'black', 
    fontWeight: 'bold',
    textAlign: 'center'
  },
  accuracyLabel: { 
    fontSize: 12, 
    color: 'black', 
    fontWeight: 'normal',
    marginTop: 2,
    textAlign: 'center'
  },
  
  // Bottom panel styling
  bottomPanel: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#FFE497', // Light orange background
    paddingVertical: 16,
    paddingHorizontal: 20,
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  infoColumn: {
    alignItems: 'center',
    flex: 1,
  },
  infoPrimary: {
    fontSize: 16,
    fontWeight: 'bold',
    color: 'black',
    textAlign: 'center',
  },
  infoSecondary: {
    fontSize: 12,
    color: 'black',
    textAlign: 'center',
    marginTop: 2,
  },
  
  offline: { 
    fontSize: 14, 
    color: 'red', 
    marginTop: 5,
    textAlign: 'center'
  },
  
  // Toggle switch styles
  toggleContainer: {
    position: 'absolute',
    top: 50,
    right: 20,
    zIndex: 1000,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
  },
  toggleLabel: {
    color: 'white',
    fontSize: 12,
    fontWeight: '600',
    marginHorizontal: 8,
  },
});
