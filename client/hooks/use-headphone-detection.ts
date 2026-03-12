import { useIsHeadphonesConnected } from 'react-native-device-info';

export type HeadphoneType = 'wired' | 'bluetooth' | null;

export interface HeadphoneStatus {
  isConnected: boolean;
  type: HeadphoneType;
}

/**
 * Hook to detect if headphones (wired or Bluetooth) are connected.
 * Uses react-native-device-info for native Android/iOS detection.
 * Subscribes to headphone plug/unplug events automatically.
 */
export function useHeadphoneDetection(): HeadphoneStatus {
  const { loading, result } = useIsHeadphonesConnected();

  // When loading, assume not connected (no volume warning until we know)
  const isConnected = !loading && result === true;

  return {
    isConnected,
    type: isConnected ? 'wired' : null, // DeviceInfo doesn't expose type in the hook; both wired+BT are covered
  };
}
