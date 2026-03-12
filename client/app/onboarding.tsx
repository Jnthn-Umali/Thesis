import React, { useRef, useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, NativeScrollEvent, NativeSyntheticEvent, Dimensions, Image, Animated, Pressable, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import * as Speech from 'expo-speech';

const API_BASE = process.env.EXPO_PUBLIC_AUTH_URL ?? 'http://10.202.11.238:4000';

type Slide = { title: string; body: string };

const HowItWorksComponent = () => (
  <View style={styles.howItWorksContainer}>
    <Image 
      source={require('../assets/images/howitworks.png')} 
      style={styles.howItWorksImage}
      resizeMode="contain"
    />
  </View>
);

const WeNeedAccessComponent = () => (
  <View style={styles.weNeedAccessContainer}>
    <Image 
      source={require('../assets/images/weneedaccess.png')} 
      style={styles.weNeedAccessImage}
      resizeMode="contain"
    />
  </View>
);

const PauseAndResumeComponent = () => (
  <View style={styles.pauseAndResumeContainer}>
    <View style={styles.pauseAndResumeImageWrapper}>
      <Image 
        source={require('../assets/images/pauseandresume.png')} 
        style={styles.pauseAndResumeImage}
        resizeMode="contain"
      />
      <Image 
        source={require('../assets/images/pauseandresume2.png')} 
        style={styles.pauseAndResume2Overlay}
        resizeMode="contain"
      />
    </View>
  </View>
);

const BatteryPercentageComponent = () => (
  <View style={styles.pauseAndResumeContainer}>
    <View style={styles.pauseAndResumeImageWrapper}>
      <Image 
        source={require('../assets/images/pauseandresume.png')} 
        style={styles.pauseAndResumeImage}
        resizeMode="contain"
      />
      <Image 
        source={require('../assets/images/batteryicon.png')} 
        style={styles.pauseAndResume2Overlay}
        resizeMode="contain"
      />
    </View>
  </View>
);

const HapticAlertsComponent = () => (
  <View style={styles.hapticAlertsContainer}>
    <Image 
      source={require('../assets/images/hapticalerts.png')} 
      style={styles.hapticAlertsImage}
      resizeMode="contain"
    />
  </View>
);

const AudioAlertsComponent = () => (
  <View style={styles.audioAlertsContainer}>
    <Image 
      source={require('../assets/images/audioalerts.png')} 
      style={styles.audioAlertsImage}
      resizeMode="contain"
    />
  </View>
);

const UsageTipsComponent = () => (
  <View style={styles.usageTipsContainer}>
    <Image 
      source={require('../assets/images/usagetips.png')} 
      style={styles.usageTipsImage}
      resizeMode="contain"
    />
  </View>
);

const StartScanningComponent = () => (
  <View style={styles.startScanningContainer}>
    <Image 
      source={require('../assets/images/startscanning.png')} 
      style={styles.startScanningImage}
      resizeMode="contain"
    />
  </View>
);

const SLIDES: Slide[] = [
  { title: 'Welcome!', body: 'This app assists users in understanding their surroundings through real-time audio feedback.' },
  { title: 'How It Works', body: 'The camera captures the user’s surroundings. A I: The app analyzes what the camera sees to understand the user’s environment. Audio: The system provides spoken guidance based on what the app detects and processes. User: The user receives real-time audio guidance to support safe and confident navigation.' },
  { title: 'How to Activate the Camera', body: 'Double-tap the screen to activate the camera. This will let the app see your surroundings.' },
  { title: 'Pause & Resume Touch Gesture', body: 'Double-tap anywhere on the screen to pause or resume the app. The app will announce the action being performed.' },
  { title: 'Battery Percentage Touch Gesture', body: 'Long press the screen to hear the current battery percentage of the phone and camera.' },
  { title: 'Haptic Alerts', body: 'The app gives a vibration warning if the device volume is turned down or off.' },
  { title: 'Audio Alerts', body: 'The app will give audio  alerts for: \n • Slow or no internet connection \n • Camera not connected \n • Low camera battery/phone battery' },
  { title: "Usage Tips", body: ' • Keep the camera clean \n • Point the camera forward \n • Wear wired earphones \n • Check the volume regularly \n • Bring a power bank in case of emergency' },
  { title: 'Start Scanning', body: 'Welcome to Eyesee! Your scanning session begins here.\n\nDouble-tap anywhere on the screen to activate the camera.' },
];

const DOUBLE_TAP_WINDOW_MS = 300;
const SUPPORTS_PAUSE_RESUME = Platform.OS === 'ios' || Platform.OS === 'web';

export default function OnboardingScreen() {
  const [submitting, setSubmitting] = useState(false);
  const [index, setIndex] = useState(0);
  const [speechPaused, setSpeechPaused] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const dotAnimations = useRef(SLIDES.map(() => new Animated.Value(0))).current;
  const doubleTapTimeoutRef = useRef<number | null>(null);
  const speakTokenRef = useRef<number>(0);
  const lastTapAtRef = useRef<number>(0);
  const speechPausedRef = useRef(false);
  const pausedAtSentenceIndexRef = useRef<number>(0);
  const currentSentenceIndexRef = useRef<number>(0);

  const normalizeTextForTts = (text: string) => {
    // Make the app name pronounce as "eye-fie" (rhyming with "buy", not spelled as letters).
    // Handles: "EyeFy", "Eye Fy", "Eye F Y", etc.
    // Visual text stays "Eye Fy" but TTS will say "eye-fie" (pronounced like "buy")
    return text.replace(/\beye\s*f\s*y\b|\beyefy\b|\beye\s*fy\b/gi, 'eye-fie');
  };

  useEffect(() => {
    // Initialize first dot as active
    animateDots(0);
    
    // Cleanup double-tap timeout on unmount
    return () => {
      if (doubleTapTimeoutRef.current) {
        clearTimeout(doubleTapTimeoutRef.current);
      }
    };
  }, []);

  // Build text to speak for a slide (shared for initial speak and resume)
  const getTextToSpeakForSlide = (slideIndex: number) => {
    const currentSlide = SLIDES[slideIndex];
    if (!currentSlide) return '';
    const sequentialWords = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Lastly'];
    const sequentialWord = slideIndex > 0 && slideIndex < SLIDES.length ?
      (slideIndex === SLIDES.length - 1 ? 'Lastly' : sequentialWords[slideIndex - 1]) : '';
    let titleWithSequence = sequentialWord ? `${sequentialWord}, ${currentSlide.title}` : currentSlide.title;
    titleWithSequence = titleWithSequence.replace(/\bResume\b/g, 'Rezume');
    let textToSpeak = titleWithSequence;
    if (currentSlide.body && currentSlide.body.trim().length > 0) {
      textToSpeak += '. ' + currentSlide.body;
    }
    return normalizeTextForTts(textToSpeak);
  };

  // Split into sentences for Android chunked speak (resume from sentence)
  const getSentences = (text: string): string[] => {
    if (!text.trim()) return [];
    const parts = text.split(/(?<=[.!?])\s+/);
    return parts.map(p => p.trim()).filter(Boolean);
  };

  const speechOpts = { language: 'en-US' as const, rate: 0.7, pitch: 1.0, volume: 1 };

  // Speak sentences from startIndex to end; on all done, advance to next slide if applicable
  const speakSentencesFrom = (slideIndex: number, startIndex: number, token: number) => {
    const text = getTextToSpeakForSlide(slideIndex);
    const sentences = getSentences(text);
    if (startIndex >= sentences.length) {
      if (speakTokenRef.current === token && !speechPausedRef.current && slideIndex < SLIDES.length - 1) goTo(slideIndex + 1);
      return;
    }
    currentSentenceIndexRef.current = startIndex;
    Speech.speak(sentences[startIndex], {
      ...speechOpts,
      onDone: () => {
        if (speakTokenRef.current !== token || speechPausedRef.current) return;
        if (startIndex + 1 >= sentences.length) {
          if (slideIndex < SLIDES.length - 1) goTo(slideIndex + 1);
        } else {
          speakSentencesFrom(slideIndex, startIndex + 1, token);
        }
      },
      onStopped: () => {
        if (speakTokenRef.current === token) speakTokenRef.current = 0;
      },
    });
  };

  // Speak the current slide when index changes (skipped when paused)
  useEffect(() => {
    if (speechPausedRef.current) return;
    const currentSlide = SLIDES[index];
    if (currentSlide) {
      Speech.stop();
      const textToSpeak = getTextToSpeakForSlide(index);
      if (!textToSpeak) return;
      const token = Date.now();
      speakTokenRef.current = token;

      if (SUPPORTS_PAUSE_RESUME) {
        Speech.speak(textToSpeak, {
          ...speechOpts,
          onDone: () => {
            if (speakTokenRef.current !== token) return;
            if (speechPausedRef.current) return;
            if (index < SLIDES.length - 1) goTo(index + 1);
          },
          onStopped: () => {
            if (speakTokenRef.current === token) speakTokenRef.current = 0;
          },
        });
      } else {
        speakSentencesFrom(index, 0, token);
      }
    }
    return () => {
      speakTokenRef.current = 0;
      Speech.stop();
    };
  }, [index]);

  useEffect(() => {
    speechPausedRef.current = speechPaused;
  }, [speechPaused]);

  const markSeenAndContinue = async () => {
    try {
      await SecureStore.setItemAsync('onboarding_seen', '1');
    } catch (e) {
      console.warn('[Onboarding] Failed to save onboarding_seen:', e);
    } finally {
      setSubmitting(false);
      router.replace('/(tabs)');
    }
  };

  const animateDots = (newIndex: number) => {
    // Reset all dots
    dotAnimations.forEach((anim, i) => {
      Animated.timing(anim, {
        toValue: i === newIndex ? 1 : 0,
        duration: 300,
        useNativeDriver: false,
      }).start();
    });
  };

  const onMomentumEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const page = Math.round(e.nativeEvent.contentOffset.x / e.nativeEvent.layoutMeasurement.width);
    setIndex(page);
    animateDots(page);
  };

  const goTo = (nextIndex: number) => {
    setIndex(nextIndex);
    animateDots(nextIndex);
    const { width } = Dimensions.get('window');
    scrollRef.current?.scrollTo({ x: nextIndex * width, animated: true });
  };

  // Pause/resume must always allow continuing where it left off — never restart from "First..."
  const pauseSpeech = async () => {
    setSpeechPaused(true);
    speechPausedRef.current = true;
    if (SUPPORTS_PAUSE_RESUME) {
      // iOS: only pause — do not speak "PAUSED" or it clears the utterance and resume() would have nothing to resume
      Speech.pause();
    } else {
      pausedAtSentenceIndexRef.current = currentSentenceIndexRef.current;
      Speech.stop();
      await Speech.speak('PAUSED', { language: 'en-US', rate: 0.7 });
    }
  };

  const resumeSpeech = () => {
    setSpeechPaused(false);
    speechPausedRef.current = false;
    if (SUPPORTS_PAUSE_RESUME) {
      // iOS: only resume — continues from exact word
      Speech.resume();
    } else {
      // Android: continue from the sentence that was playing when paused (never from 0)
      Speech.speak('RESUMED', {
        language: 'en-US',
        rate: 0.7,
        onDone: () => {
          const token = Date.now();
          speakTokenRef.current = token;
          speakSentencesFrom(index, pausedAtSentenceIndexRef.current, token);
        },
      });
    }
  };

  // Double-tap: last slide excluded from pause/resume — double-tap only continues to app; other slides = pause/resume
  const handleDoubleTap = async () => {
    const now = Date.now();
    if (now - lastTapAtRef.current < DOUBLE_TAP_WINDOW_MS) {
      if (doubleTapTimeoutRef.current) {
        clearTimeout(doubleTapTimeoutRef.current);
        doubleTapTimeoutRef.current = null;
      }
      lastTapAtRef.current = 0;
      const isLastSlide = index === SLIDES.length - 1;
      if (isLastSlide && !submitting) {
        setSubmitting(true);
        await markSeenAndContinue();
      } else if (!isLastSlide && speechPaused) {
        resumeSpeech();
      } else if (!isLastSlide) {
        await pauseSpeech();
      }
      return;
    }
    lastTapAtRef.current = now;
    doubleTapTimeoutRef.current = setTimeout(() => {
      lastTapAtRef.current = 0;
      if (doubleTapTimeoutRef.current) {
        clearTimeout(doubleTapTimeoutRef.current);
        doubleTapTimeoutRef.current = null;
      }
    }, DOUBLE_TAP_WINDOW_MS);
  };

  return (
    <SafeAreaView style={styles.container}>

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        scrollEnabled={!speechPaused}
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onMomentumEnd}
        onScroll={(e) => {
          const page = Math.round(e.nativeEvent.contentOffset.x / e.nativeEvent.layoutMeasurement.width);
          if (page !== index) {
            setIndex(page);
            animateDots(page);
          }
        }}
        scrollEventThrottle={16}
        style={styles.scrollView}
      >
        {SLIDES.map((s, i) => {
          const slideContent = (
            <>
              {i === 0 && <Image source={require('../assets/images/iconeyefy.png')} style={styles.logo} />}
              {i === 2 && <WeNeedAccessComponent />}
              {i === 3 && <PauseAndResumeComponent />}
              {i === 4 && <BatteryPercentageComponent />}
              {i === 5 && <HapticAlertsComponent />}
              {i === 6 && <AudioAlertsComponent />}
              {i === 7 && <UsageTipsComponent />}
              {i === 8 && <StartScanningComponent />}
              <View style={i === 1 ? styles.howItWorksContentWrap : (i === 3 || i === 4 || i === 5 || i === 6 || i === 7) ? styles.pauseAndResumeTextBlock : undefined}>
                <Text style={styles.title}>{s.title}</Text>
                {i === 1 ? <HowItWorksComponent /> : <Text style={[styles.subtitle, (i === 6 || i === 7) && styles.subtitleLeftAlign]}>{s.body}</Text>}
              </View>
            </>
          );

          return (
            <Pressable
              key={i}
              onPress={handleDoubleTap}
              style={[styles.page, i === 1 && { paddingHorizontal: 0, justifyContent: 'flex-start', paddingTop: 60 }]}
            >
              {slideContent}
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.controls}>
        {/* Dots */}
        <View style={styles.dotsRow}>
          {SLIDES.map((_, i) => {
            const animatedWidth = dotAnimations[i].interpolate({
              inputRange: [0, 1],
              outputRange: [6, 16],
            });
            
            const animatedOpacity = dotAnimations[i].interpolate({
              inputRange: [0, 1],
              outputRange: [0.3, 1],
            });

            return (
              <Animated.View
                key={i}
                style={[
                  styles.dot,
                  {
                    width: animatedWidth,
                    opacity: animatedOpacity,
                  }
                ]}
              />
            );
          })}
        </View>

        {/* Arrows / Start */}
        <View style={styles.navRow}>
          {index > 0 ? (
            <TouchableOpacity onPress={() => goTo(Math.max(0, index - 1))} style={styles.skipBtn}>
              <Text style={styles.arrowText}>{'<'}</Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.skipBtn} />
          )}
          {index < SLIDES.length - 1 ? (
            <TouchableOpacity onPress={() => goTo(Math.min(SLIDES.length - 1, index + 1))} style={styles.skipBtn}>
              <Text style={styles.arrowText}>{'>'}</Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.skipBtn} />
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFF7DB' },
  scrollView: { flex: 1 },
  page: { 
    width: Dimensions.get('window').width,
    flex: 1,
    paddingHorizontal: 20, 
    alignItems: 'center', 
    justifyContent: 'center',
    paddingBottom: 120
  },
  logo: {
    width: 250,
    height: 254,
    marginBottom: 30,
    resizeMode: 'contain'
  },
  title: { fontSize: 24, fontWeight: '700', marginBottom: 2, color: '#222', textAlign: 'center', fontFamily: 'SpartanMB-Bold' },
  subtitle: { fontSize: 14, color: '#555', marginBottom: 20, textAlign: 'center', fontFamily: 'SpartanMB-Regular' },
  subtitleLeftAlign: { textAlign: 'left', fontFamily: 'SpartanMB-Regular' },
  controls: { paddingHorizontal: 20, paddingBottom: 50 },
  dotsRow: { flexDirection: 'row', justifyContent: 'center', marginBottom: 12 },
  dot: { 
    height: 6, 
    borderRadius: 3, 
    backgroundColor: '#000000', 
    marginHorizontal: 4 
  },
  navRow: { flexDirection: 'row', justifyContent: 'space-between' },
  skipBtn: { paddingVertical: 10, width: 56, alignItems: 'center', justifyContent: 'center' },
  skipText: { color: '#4f8ad9', fontSize: 20, fontWeight: '700', fontFamily: 'SpartanMB-Bold' },
  arrowText: { color: '#000000', fontSize: 22, lineHeight: 22, fontWeight: '700', fontFamily: 'SpartanMB-Bold' },
  allowBtn: { 
    paddingVertical: 10, 
    paddingHorizontal: 18 
  },
  allowText: { color: '#4f8ad9', fontSize: 20, fontWeight: '700', fontFamily: 'SpartanMB-Bold' },
  button: { backgroundColor: '#90bdf2', paddingVertical: 14, borderRadius: 8, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '700', fontFamily: 'SpartanMB-Bold' },
  howItWorksContentWrap: {
    flex: 1,
    width: '100%',
  },
  howItWorksContainer: { 
    flex: 1, 
    width: '100%', 
    justifyContent: 'flex-start', 
    alignItems: 'center',
  },
  howItWorksImage: {
    width: '100%',
    height: '100%',
    maxHeight: 600,
    minHeight: 350,
    resizeMode: 'contain',
  },
  weNeedAccessContainer: { 
    width: '100%', 
    justifyContent: 'center', 
    alignItems: 'center',
    marginTop: 80,
    paddingTop: 40,
    marginBottom: 20,
  },
  weNeedAccessImage: {
    width: '100%',
    maxHeight: 200,
    minHeight: 150,
    resizeMode: 'contain',
  },
  hapticAlertsContainer: { 
    width: '100%', 
    justifyContent: 'center', 
    alignItems: 'center',
    marginTop: 24,
    marginBottom: -50,
  },
  hapticAlertsImage: {
    width: '100%',
    maxHeight: 380,
    minHeight: 220,
    resizeMode: 'contain',
  },
  audioAlertsContainer: { 
    width: '100%', 
    justifyContent: 'center', 
    alignItems: 'center',
    marginTop: 24,
    marginBottom: -130,
  },
  audioAlertsImage: {
    width: '100%',
    maxHeight: 360,
    minHeight: 210,
    resizeMode: 'contain',
  },
  usageTipsContainer: { 
    width: '100%', 
    justifyContent: 'center', 
    alignItems: 'center',
    marginTop: 24,
    marginBottom: -60,
  },
  usageTipsImage: {
    width: '100%',
    maxHeight: 380,
    minHeight: 220,
    resizeMode: 'contain',
  },
  pauseAndResumeContainer: { 
    width: '100%', 
    justifyContent: 'center', 
    alignItems: 'center',
    marginTop: 70,
    marginBottom: 20,
  },
  pauseAndResumeImageWrapper: {
    width: '100%',
    position: 'relative',
    maxHeight: 420,
    minHeight: 280,
  },
  pauseAndResumeImage: {
    width: '100%',
    height: 380,
    maxHeight: 420,
    minHeight: 280,
    resizeMode: 'contain',
  },
  pauseAndResume2Overlay: {
    position: 'absolute',
    top: 8,
    left: 8,
    width: 100,
    height: 140,
    zIndex: 10,
    elevation: 10,
  },
  pauseAndResumeTextBlock: {
    marginTop: 24,
  },
  startScanningContainer: { 
    width: '100%', 
    justifyContent: 'center', 
    alignItems: 'center',
    marginTop: -40,
    marginBottom: -110,
  },
  startScanningImage: {
    width: '100%',
    maxHeight: 450,
    minHeight: 250,
    resizeMode: 'contain',
  },
});
