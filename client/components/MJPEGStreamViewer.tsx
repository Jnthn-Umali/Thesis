import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef, useCallback } from 'react';
import { View, StyleSheet, Text, Button, Platform } from 'react-native';
import { WebView } from 'react-native-webview';
import * as FileSystem from 'expo-file-system';
import { M5TIMER_CAMERA_IP, M5TIMER_CAMERA_BATTERY_URL } from '../config';  // e.g., ''

const STREAM_URL = `http://${M5TIMER_CAMERA_IP}/stream`;

export interface MJPEGStreamViewerRef {
  captureFrame: () => Promise<string | null>;
  isConnected: () => boolean;
  /** Current M5 camera battery percent (null if unknown). */
  getBatteryPercent: () => number | null;
}

interface MJPEGStreamViewerProps {
  style?: any;
  onConnectionChange?: (connected: boolean) => void;
  onError?: (error: string) => void;
  /** Called once when battery drops to 20% or below (TTS warning). */
  onBatteryLow?: (percent: number) => void;
  /** Report battery percent to parent (e.g. to show in a top bar). */
  onBatteryPercentChange?: (percent: number | null) => void;
  /** When false, battery is not shown in the overlay (parent shows it). Default true. */
  showBatteryInOverlay?: boolean;
}

const MJPEGStreamViewer = forwardRef<MJPEGStreamViewerRef, MJPEGStreamViewerProps>(
  ({ style, onConnectionChange, onError, onBatteryLow, onBatteryPercentChange, showBatteryInOverlay = true }, ref) => {
    const [isConnected, setIsConnected] = useState(false);
    const [connectionError, setConnectionError] = useState<string | null>(null);
    const [batteryPercent, setBatteryPercent] = useState<number | null>(null);
    const [debugInfo, setDebugInfo] = useState<string>('Initializing WebView...');
    const webViewRef = useRef<WebView>(null);
    const latestFrameRef = useRef<string | null>(null);
    const isMountedRef = useRef(true);
    const captureResolveRef = useRef<((value: string | null) => void) | null>(null);
    const captureTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hasWarnedBatteryLowRef = useRef(false);
    const batteryPercentRef = useRef<number | null>(null);

    useEffect(() => {
      batteryPercentRef.current = batteryPercent;
    }, [batteryPercent]);

    const saveDataUrlToFile = useCallback(async (dataUrl: string): Promise<string | null> => {
      try {
        const commaIndex = dataUrl.indexOf(',');
        const base64Data = commaIndex !== -1 ? dataUrl.slice(commaIndex + 1) : dataUrl;
        if (!base64Data) return null;
        const fileUri = `${FileSystem.cacheDirectory ?? ''}m5timer_${Date.now()}.jpg`;
        await FileSystem.writeAsStringAsync(fileUri, base64Data, { encoding: FileSystem.EncodingType.Base64 });
        return fileUri;
      } catch (error) {
        console.log('[MJPEG] Failed to save frame:', error);
        return null;
      }
    }, []);

    useImperativeHandle(ref, () => ({
      captureFrame: async () => {
        if (!webViewRef.current || !isConnected) {
          return null;
        }
        if (latestFrameRef.current) {
          const cachedUri = await saveDataUrlToFile(latestFrameRef.current);
          if (cachedUri) {
            return cachedUri;
          }
        }
        return new Promise<string | null>((resolve) => {
          captureResolveRef.current = resolve;
          const captureScript = `
            (function() {
              const sendFrame = (data) => window.ReactNativeWebView.postMessage(JSON.stringify({type: 'frame', data}));
              if (window.lastFrameDataUrl) {
                sendFrame(window.lastFrameDataUrl);
                return true;
              }
              const img = document.getElementById('stream');
              if (img && img.complete && img.naturalWidth > 0) {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const ctx = canvas.getContext('2d');
                if (ctx) {
                  ctx.drawImage(img, 0, 0);
                  const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
                  window.lastFrameDataUrl = dataUrl;
                  sendFrame(dataUrl);
                  return true;
                }
              }
              sendFrame(null);
              return true;
            })();
          `;
          webViewRef.current!.injectJavaScript(captureScript);
          // Timeout fallback
          if (captureTimeoutRef.current) {
            clearTimeout(captureTimeoutRef.current);
          }
          captureTimeoutRef.current = setTimeout(() => {
            if (captureResolveRef.current === resolve) {
              captureResolveRef.current = null;
              resolve(null);
            }
          }, 2000);
        });
      },
      isConnected: () => isConnected,
      getBatteryPercent: () => batteryPercentRef.current,
    }));

    const handleMessage = useCallback(async (event: any) => {
      try {
        const msg = JSON.parse(event.nativeEvent.data);
        switch (msg.type) {
          case 'streamConnected':
            if (isMountedRef.current) {
              setIsConnected(true);
              onConnectionChange?.(true);
              setDebugInfo('Stream connected');
            }
            break;
          case 'streamError':
            if (isMountedRef.current) {
              const errMsg = msg.msg || 'Stream load failed';
              setConnectionError(errMsg);
              setIsConnected(false);
              onConnectionChange?.(false);
              onError?.(errMsg);
            }
            break;
          case 'frame': {
            latestFrameRef.current = msg.data;
            if (captureResolveRef.current) {
              const resolver = captureResolveRef.current;
              captureResolveRef.current = null;
              if (captureTimeoutRef.current) {
                clearTimeout(captureTimeoutRef.current);
                captureTimeoutRef.current = null;
              }
              const fileUri = msg.data ? await saveDataUrlToFile(msg.data) : null;
              resolver(fileUri);
            }
            break;
          }
        }
      } catch (e) {
        console.log('[MJPEG] Message parse error:', e);
      }
    }, [onConnectionChange, onError, saveDataUrlToFile]);

    const connectionScript = `
      (function() {
        const sendMessage = (payload) => window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(payload));
        const ensureCanvas = () => {
          if (!window.__captureCanvas) {
            window.__captureCanvas = document.createElement('canvas');
            window.__captureCtx = window.__captureCanvas.getContext('2d');
          }
          return window.__captureCtx;
        };
        const setup = () => {
          const img = document.getElementById('stream');
          if (!img) {
            setTimeout(setup, 500);
            return;
          }
          img.crossOrigin = 'anonymous';
          const captureFrame = () => {
            if (!img.naturalWidth || !img.naturalHeight) return;
            const ctx = ensureCanvas();
            if (!ctx) return;
            const canvas = window.__captureCanvas;
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            try {
              window.lastFrameDataUrl = canvas.toDataURL('image/jpeg', 0.8);
              sendMessage({ type: 'frame', data: window.lastFrameDataUrl });
            } catch (err) {}
          };
          img.onload = () => {
            captureFrame();
            sendMessage({ type: 'streamConnected' });
          };
          img.onerror = () => sendMessage({ type: 'streamError', msg: 'Network or stream error' });
          setInterval(captureFrame, 1000);
        };
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
          setup();
        } else {
          document.addEventListener('DOMContentLoaded', setup);
        }
      })();
      true;
    `;

    const htmlContent = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, maximum-scale=1.0">
          <style>
            html, body {
              margin: 0;
              padding: 0;
              width: 100%;
              height: 100%;
              background: black;
              display: flex;
              justify-content: center;
              align-items: center;
              overflow: hidden;
            }
            #stream {
              max-width: 100%;
              max-height: 100%;
              width: auto;
              height: auto;
              object-fit: contain;
              display: block;
            }
          </style>
        </head>
        <body>
          <img id="stream" src="${STREAM_URL}" crossOrigin="anonymous" />
          <script>${connectionScript}</script>
        </body>
      </html>
    `;

    const handleWebViewError = useCallback((syntheticEvent: any) => {
      const errMsg = syntheticEvent.nativeEvent.description || 'WebView load failed';
      console.error('[MJPEG] WebView error:', errMsg);
      if (isMountedRef.current) {
        setConnectionError(errMsg);
        setIsConnected(false);
        onConnectionChange?.(false);
        onError?.(errMsg);
        setDebugInfo(`Error: ${errMsg}`);
      }
    }, [onConnectionChange, onError]);

    const retryConnection = useCallback(() => {
      setConnectionError(null);
      setDebugInfo('Retrying...');
      webViewRef.current?.reload();
    }, []);

    const batteryColor = batteryPercent === null ? '#888' : batteryPercent > 50 ? '#34C759' : batteryPercent > 20 ? '#FFCC00' : '#FF3B30';

    useEffect(() => {
      isMountedRef.current = true;
      setDebugInfo('Loading MJPEG stream...');

      return () => {
        isMountedRef.current = false;
        setBatteryPercent(null);
        if (captureTimeoutRef.current) {
          clearTimeout(captureTimeoutRef.current);
          captureTimeoutRef.current = null;
        }
        if (captureResolveRef.current) {
          captureResolveRef.current(null);
          captureResolveRef.current = null;
        }
        webViewRef.current?.stopLoading();
      };
    }, []);

    useEffect(() => {
      if (!isConnected) {
        setBatteryPercent(null);
        return;
      }

      let isActive = true;

      const fetchBattery = async () => {
        try {
          const response = await fetch(`${M5TIMER_CAMERA_BATTERY_URL}?t=${Date.now()}`);
          if (!response.ok) return;
          const contentType = response.headers?.get?.('content-type') ?? '';
          const rawText = await response.text();
          let percent: number | null = null;

          if (contentType.includes('application/json')) {
            try {
              const data = JSON.parse(rawText);
              const parsed = Number(data?.batteryPercent);
              if (!Number.isNaN(parsed)) percent = parsed;
            } catch {
              // Fall through to text parsing
            }
          }

          if (percent === null) {
            const match = rawText.match(/(\d{1,3})/);
            if (match) {
              const parsed = Number(match[1]);
              if (!Number.isNaN(parsed)) percent = parsed;
            }
          }

          if (percent === null) return;
          const clamped = Math.max(0, Math.min(100, Math.round(percent)));
          if (isActive) setBatteryPercent(clamped);
        } catch {
          // Ignore transient network errors
        }
      };

      fetchBattery();
      const interval = setInterval(fetchBattery, 8000);

      return () => {
        isActive = false;
        clearInterval(interval);
      };
    }, [isConnected]);

    // Report battery percent to parent
    useEffect(() => {
      onBatteryPercentChange?.(batteryPercent);
    }, [batteryPercent, onBatteryPercentChange]);

    // TTS warning when battery hits 20% or below (once per drop; resets when > 20)
    useEffect(() => {
      if (batteryPercent === null) return;
      if (batteryPercent > 20) {
        hasWarnedBatteryLowRef.current = false;
        return;
      }
      if (!hasWarnedBatteryLowRef.current && onBatteryLow) {
        hasWarnedBatteryLowRef.current = true;
        onBatteryLow(batteryPercent);
      }
    }, [batteryPercent, onBatteryLow]);

    const renderLoading = () => (
      <View style={styles.placeholder}>
        <Text style={styles.placeholderText}>Connecting to M5Timer Camera...</Text>
      </View>
    );

    return (
      <View style={[styles.container, style]}>
        <WebView
          ref={webViewRef}
          source={{ html: htmlContent }}
          style={styles.webview}
          onMessage={handleMessage}
          onError={handleWebViewError}
          renderLoading={renderLoading}
          startInLoadingState={true}
          scrollEnabled={false}
          bounces={false}
          setSupportMultipleWindows={false}
          {...Platform.select({
            android: { androidHardwareAccelerationDisabled: true }
          })}
        />
        {showBatteryInOverlay && (
          <View style={styles.statusOverlay} pointerEvents="none">
            <Text style={styles.statusText}>
              {isConnected ? 'Connected' : connectionError || 'Connecting...'}
            </Text>
            {isConnected && (
              <View style={styles.batteryRow}>
                <View style={styles.batteryOuter}>
                  <View style={[styles.batteryFill, { width: `${batteryPercent !== null ? batteryPercent : 0}%`, backgroundColor: batteryColor }]} />
                </View>
                <View style={styles.batteryNub} />
                <Text style={styles.batteryPercentText}>
                  {batteryPercent !== null ? `${batteryPercent}%` : '--'}
                </Text>
              </View>
            )}
            {debugInfo ? <Text style={styles.debugText}>{debugInfo}</Text> : null}
          </View>
        )}
        {!isConnected && connectionError && (
          <View style={styles.retryButton}>
            <Button title="Retry Connection" onPress={retryConnection} />
          </View>
        )}
      </View>
    );
  }
);

MJPEGStreamViewer.displayName = 'MJPEGStreamViewer';

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'black',
  },
  webview: {
    flex: 1,
  },
  placeholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'black',
  },
  placeholderText: {
    color: 'white',
    fontSize: 16,
    textAlign: 'center',
  },
  statusOverlay: {
    position: 'absolute',
    top: 20,
    left: 20,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 4,
    zIndex: 10,
    elevation: 10,
  },
  statusText: {
    color: 'white',
    fontSize: 12,
  },
  debugText: {
    color: 'yellow',
    fontSize: 10,
    marginTop: 4,
  },
  batteryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
  },
  batteryOuter: {
    width: 28,
    height: 12,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  batteryFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    minWidth: 0,
    borderRadius: 1,
  },
  batteryNub: {
    width: 2,
    height: 6,
    backgroundColor: 'rgba(255,255,255,0.5)',
    marginLeft: -1,
    borderRadius: 0,
  },
  batteryPercentText: {
    color: 'white',
    fontSize: 11,
    marginLeft: 4,
    fontWeight: '600',
  },
  retryButton: {
    position: 'absolute',
    bottom: 20,
    left: 20,
    right: 20,
  },
});

export default MJPEGStreamViewer;