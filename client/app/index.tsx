import React, { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';

const ONBOARDING_SEEN_KEY = 'onboarding_seen';

export default function IndexScreen() {
  useEffect(() => {
    (async () => {
      try {
        await new Promise(resolve => setTimeout(resolve, 100));
        const seen = await SecureStore.getItemAsync(ONBOARDING_SEEN_KEY);
        if (seen === '1') {
          console.log('[Index] Onboarding already seen, going to camera');
          router.replace('/(tabs)');
        } else {
          console.log('[Index] First time or not seen, going to onboarding');
          router.replace('/onboarding');
        }
      } catch (error) {
        console.error('[Index] Onboarding check error:', error);
        router.replace('/onboarding');
      }
    })();
  }, []);

  // Show loading indicator while checking auth
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#FFF7DB' }}>
      <ActivityIndicator size="large" color="#4f8ad9" />
    </View>
  );
}
