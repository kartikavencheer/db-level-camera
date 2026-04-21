import Constants from 'expo-constants';
import * as Haptics from 'expo-haptics';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Reanimated, {
  Extrapolation,
  FadeIn,
  FadeOut,
  interpolate,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { runOnJS } from 'react-native-worklets';

let VisionCamera: any = {
  Camera: () => null,
  useCameraDevice: () => null,
  useCameraFormat: () => null,
};
let LiveAudioStream: any = {
  init: () => {},
  on: () => {},
  start: () => {},
  stop: () => {},
};

if (Constants.appOwnership !== 'expo') {
  try {
    VisionCamera = require('react-native-vision-camera');
    LiveAudioStream =
      require('react-native-live-audio-stream').default ||
      require('react-native-live-audio-stream');
  } catch (error) {
    console.error('Failed to load native modules', error);
  }
}

const { Camera, useCameraDevice, useCameraFormat } = VisionCamera;

const MAX_VIDEO_SECONDS = 7;
const MIN_VIDEO_SECONDS = 2;

type AudioValidationResult = {
  meanDb: number | null;
  maxDb: number | null;
  isSilent: boolean;
  duration: number;
};

type FocusPoint = { x: number; y: number } | null;

export default function Index() {
  const cameraRef = useRef<any>(null);
  const appState = useRef(AppState.currentState);
  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingStartTimeRef = useRef<number | null>(null);
  const focusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRecordingRef = useRef(false);

  const [cameraPosition, setCameraPosition] = useState<'front' | 'back'>('back');
  const [appIsActive, setAppIsActive] = useState(true);
  const [hasPermissions, setHasPermissions] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState('STBY');
  const [result, setResult] = useState<AudioValidationResult | null>(null);
  const [currentDb, setCurrentDb] = useState(-160);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [selfTimer, setSelfTimer] = useState<0 | 3 | 10>(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [torch, setTorch] = useState<'off' | 'on'>('off');
  const [focusPoint, setFocusPoint] = useState<FocusPoint>(null);
  const [zoom, setZoom] = useState(1);
  const [exposure, setExposure] = useState(0);

  const maxDbRef = useRef(-160);
  const sumDbRef = useRef(0);
  const countDbRef = useRef(0);

  const device = useCameraDevice(cameraPosition);
  const format = useCameraFormat(device, [{ videoAspectRatio: 16 / 9 }, { fps: 30 }]);

  const zoomShared = useSharedValue(1);
  const pinchStartZoom = useSharedValue(1);
  const focusScale = useSharedValue(1.5);
  const focusOpacity = useSharedValue(0);
  const exposureShared = useSharedValue(0);
  const startExposure = useSharedValue(0);
  const dotOpacity = useSharedValue(1);

  const minZoom = device?.minZoom ?? 1;
  const maxZoom = Math.min(device?.maxZoom ?? 8, 8);
  const hasExposureControl =
    device?.minExposure !== undefined &&
    device?.maxExposure !== undefined &&
    device.minExposure < device.maxExposure;
  const minExposure = device?.minExposure ?? 0;
  const maxExposure = device?.maxExposure ?? 0;

  const clearRecordingTimers = useCallback(() => {
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
    if (autoStopTimeoutRef.current) {
      clearTimeout(autoStopTimeoutRef.current);
      autoStopTimeoutRef.current = null;
    }
  }, []);

  const requestPermissions = useCallback(async () => {
    const camStatus = await Camera.requestCameraPermission();
    const micStatus = await Camera.requestMicrophonePermission();
    setHasPermissions(camStatus === 'granted' && micStatus === 'granted');
  }, []);

  const calculateDb = (base64Data: string) => {
    try {
      const binaryString = atob(base64Data);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i += 1) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const pcm16 = new Int16Array(bytes.buffer);

      let sumSquares = 0;
      for (let i = 0; i < pcm16.length; i += 1) {
        sumSquares += pcm16[i] * pcm16[i];
      }

      const rms = Math.sqrt(sumSquares / pcm16.length);
      return rms > 0 ? 20 * Math.log10(rms / 32768) : -160;
    } catch {
      return -160;
    }
  };

  const mapDbToUi = (db: number | null) => {
    if (db === null) return 0;
    return Math.max(0, Math.min(60, db + 60));
  };

  const renderDbValue = (val: number | null) => {
    if (val === null) return 'N/A';
    return `${mapDbToUi(val).toFixed(1)} Units`;
  };

  const startRecordingTimers = useCallback(
    (startedAt: number) => {
      clearRecordingTimers();
      setRecordingSeconds(0);

      recordingIntervalRef.current = setInterval(() => {
        const elapsed = (Date.now() - startedAt) / 1000;
        setRecordingSeconds(Math.min(elapsed, MAX_VIDEO_SECONDS));
      }, 100);

      autoStopTimeoutRef.current = setTimeout(() => {
        clearRecordingTimers();
        setRecordingSeconds(MAX_VIDEO_SECONDS);
        if (cameraRef.current && isRecordingRef.current) {
          void stopRecording();
        }
      }, MAX_VIDEO_SECONDS * 1000);
    },
    [clearRecordingTimers],
  );

  const handleTouchToFocus = useCallback(
    async (x: number, y: number) => {
      if (!cameraRef.current || !device) return;

      setFocusPoint({ x, y });
      focusOpacity.value = withSpring(1);
      focusScale.value = 1.5;
      focusScale.value = withSpring(1, { damping: 12 });

      try {
        if (device.supportsFocus) {
          await cameraRef.current.focus({ x, y });
        }
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } catch (error) {
        console.warn('Focus failed:', error);
      }

      if (focusTimeoutRef.current) {
        clearTimeout(focusTimeoutRef.current);
      }
      focusTimeoutRef.current = setTimeout(() => {
        focusOpacity.value = withTiming(0, { duration: 300 });
      }, 800);
    },
    [device, focusOpacity, focusScale],
  );

  const flipCamera = useCallback(() => {
    if (isRecording) return;
    setCameraPosition((prev) => (prev === 'back' ? 'front' : 'back'));
    setTorch('off');
    setZoom(1);
    zoomShared.value = 1;
    setExposure(0);
    exposureShared.value = 0;
  }, [exposureShared, isRecording, zoomShared]);

  const toggleTorch = useCallback(() => {
    if (!device?.hasTorch || cameraPosition !== 'back') return;
    setTorch((prev) => (prev === 'off' ? 'on' : 'off'));
  }, [cameraPosition, device?.hasTorch]);

  const stopAudioMetering = useCallback(() => {
    try {
      LiveAudioStream.stop();
    } catch (error) {
      console.warn('Audio stop failed:', error);
    }
  }, []);

  const startAudioMetering = useCallback(() => {
    maxDbRef.current = -160;
    sumDbRef.current = 0;
    countDbRef.current = 0;
    setCurrentDb(-160);

    LiveAudioStream.init({
      sampleRate: 44100,
      channels: 1,
      bitsPerSample: 16,
      audioSource: 6,
      bufferSize: 4096,
    });

    LiveAudioStream.on('data', (data: string) => {
      const db = calculateDb(data);
      setCurrentDb(db);
      if (db > maxDbRef.current) maxDbRef.current = db;
      sumDbRef.current += db;
      countDbRef.current += 1;
    });

    LiveAudioStream.start();
  }, []);

  const finalizeRecording = useCallback(
    async (video: { duration?: number }) => {
      const finalMax = maxDbRef.current;
      const finalMean = countDbRef.current > 0 ? sumDbRef.current / countDbRef.current : -160;
      const finalDuration = video.duration || 0;

      let errorMsg = '';
      if (finalDuration < MIN_VIDEO_SECONDS) {
        errorMsg = 'Video is too short (minimum 2 seconds).';
      } else if (finalMax <= -35) {
        errorMsg = `Audio too quiet! Max volume was ${mapDbToUi(finalMax).toFixed(1)} Units (minimum 25.0).`;
      } else if (finalMean <= -45) {
        errorMsg = `Audio level too low! Average volume was ${mapDbToUi(finalMean).toFixed(1)} Units (minimum 15.0).`;
      }

      if (errorMsg) {
        Alert.alert('Video Rejected', errorMsg);
        setStatus('REJECTED');
        setResult(null);
        return;
      }

      setResult({
        meanDb: finalMean,
        maxDb: finalMax,
        isSilent: false,
        duration: finalDuration,
      });
      setStatus('SUCCESS');
    },
    [],
  );

  const startRecordingNow = useCallback(async () => {
    if (!cameraRef.current || !device || isRecordingRef.current) return;

    try {
      setResult(null);
      setStatus('REC');
      setIsRecording(true);
      isRecordingRef.current = true;
      recordingStartTimeRef.current = Date.now();
      startRecordingTimers(recordingStartTimeRef.current);
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      startAudioMetering();

      cameraRef.current.startRecording({
        fileType: 'mp4',
        videoCodec: 'h264',
        onRecordingFinished: async (video: { duration?: number }) => {
          clearRecordingTimers();
          stopAudioMetering();
          isRecordingRef.current = false;
          recordingStartTimeRef.current = null;
          setIsRecording(false);
          setTorch('off');
          setStatus('PROCESSING...');

          try {
            await finalizeRecording(video);
          } catch (error: any) {
            setStatus('ERROR');
            Alert.alert('Error', error?.message || 'Processing failed');
          }
        },
        onRecordingError: (error: { message: string }) => {
          clearRecordingTimers();
          stopAudioMetering();
          isRecordingRef.current = false;
          recordingStartTimeRef.current = null;
          setIsRecording(false);
          setTorch('off');
          setStatus('STBY');
          Alert.alert('Camera Error', error.message);
        },
      });
    } catch (error: any) {
      clearRecordingTimers();
      stopAudioMetering();
      isRecordingRef.current = false;
      recordingStartTimeRef.current = null;
      setIsRecording(false);
      setStatus('STBY');
      Alert.alert('Failed to start recording', error?.message || 'Unknown error');
    }
  }, [
    clearRecordingTimers,
    device,
    finalizeRecording,
    startAudioMetering,
    startRecordingTimers,
    stopAudioMetering,
  ]);

  const stopRecording = useCallback(async () => {
    if (!cameraRef.current || !isRecordingRef.current) return;

    clearRecordingTimers();
    setStatus('PROCESSING...');

    const minDurationMs = 500;
    const elapsed = recordingStartTimeRef.current
      ? Date.now() - recordingStartTimeRef.current
      : minDurationMs;

    if (elapsed < minDurationMs) {
      await new Promise((resolve) => setTimeout(resolve, minDurationMs - elapsed));
    }

    await cameraRef.current.stopRecording();
  }, [clearRecordingTimers]);

  const startRecording = useCallback(async () => {
    if (selfTimer === 0) {
      await startRecordingNow();
      return;
    }

    let nextCount = selfTimer;
    setCountdown(nextCount);
    const interval = setInterval(() => {
      nextCount -= 1;
      if (nextCount <= 0) {
        clearInterval(interval);
        setCountdown(null);
        void startRecordingNow();
      } else {
        setCountdown(nextCount);
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    }, 1000);
  }, [selfTimer, startRecordingNow]);

  const handleRecordPress = useCallback(() => {
    if (isRecording) {
      void stopRecording();
      return;
    }
    void startRecording();
  }, [isRecording, startRecording, stopRecording]);

  const setZoomPreset = useCallback(
    (value: number) => {
      const nextZoom = Math.max(minZoom, Math.min(value, maxZoom));
      setZoom(nextZoom);
      zoomShared.value = withTiming(nextZoom, { duration: 180 });
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    },
    [maxZoom, minZoom, zoomShared],
  );

  useAnimatedReaction(
    () => zoomShared.value,
    (value) => {
      runOnJS(setZoom)(value);
    },
  );

  useEffect(() => {
    requestPermissions();
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      appState.current = nextAppState;
      const active = nextAppState === 'active';
      setAppIsActive(active);
      if (!active && isRecordingRef.current) {
        void stopRecording();
      }
    });

    return () => {
      subscription.remove();
      clearRecordingTimers();
      stopAudioMetering();
      if (focusTimeoutRef.current) {
        clearTimeout(focusTimeoutRef.current);
      }
    };
  }, [clearRecordingTimers, requestPermissions, stopAudioMetering, stopRecording]);

  useEffect(() => {
    if (isRecording) {
      dotOpacity.value = withRepeat(withTiming(0, { duration: 500 }), -1, true);
    } else {
      dotOpacity.value = 1;
    }
  }, [dotOpacity, isRecording]);

  useEffect(() => {
    setZoom((prev) => Math.max(minZoom, Math.min(prev, maxZoom)));
  }, [maxZoom, minZoom]);

  useEffect(() => {
    if (!hasExposureControl) {
      setExposure(0);
      exposureShared.value = 0;
      return;
    }
    setExposure((prev) => Math.max(minExposure, Math.min(prev, maxExposure)));
  }, [exposureShared, hasExposureControl, maxExposure, minExposure]);

  const pinchGesture = useMemo(
    () =>
      Gesture.Pinch()
        .onStart(() => {
          pinchStartZoom.value = zoomShared.value;
        })
        .onUpdate((event) => {
          const nextZoom = Math.max(minZoom, Math.min(maxZoom, pinchStartZoom.value * event.scale));
          zoomShared.value = nextZoom;
        }),
    [maxZoom, minZoom, pinchStartZoom, zoomShared],
  );

  const tapGesture = useMemo(
    () =>
      Gesture.Tap().onEnd((event) => {
        runOnJS(handleTouchToFocus)(event.x, event.y);
      }),
    [handleTouchToFocus],
  );

  const exposureGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(hasExposureControl)
        .maxPointers(1)
        .onStart(() => {
          startExposure.value = exposureShared.value;
        })
        .onUpdate((event) => {
          const range = maxExposure - minExposure;
          const nextExposure = Math.max(
            minExposure,
            Math.min(maxExposure, startExposure.value + (-event.translationY / 160) * range),
          );
          exposureShared.value = nextExposure;
          runOnJS(setExposure)(nextExposure);
        }),
    [exposureShared, hasExposureControl, maxExposure, minExposure, startExposure],
  );

  const combinedGesture = useMemo(
    () => Gesture.Simultaneous(pinchGesture, tapGesture),
    [pinchGesture, tapGesture],
  );

  const focusStyle = useAnimatedStyle(() => ({
    opacity: focusOpacity.value,
    transform: [
      { translateX: focusPoint ? focusPoint.x - 35 : 0 },
      { translateY: focusPoint ? focusPoint.y - 35 : 0 },
      { scale: focusScale.value },
    ],
  }));

  const sideBrightnessStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: interpolate(
          exposureShared.value,
          [minExposure, maxExposure || 1],
          [70, -70],
          Extrapolation.CLAMP,
        ),
      },
    ],
  }));

  const dotAnimatedStyle = useAnimatedStyle(() => ({
    opacity: dotOpacity.value,
  }));

  if (Constants.appOwnership === 'expo') {
    return (
      <View style={styles.center}>
        <Text style={styles.timeCode}>EXPO GO DETECTED</Text>
        <Text style={[styles.infoText, styles.centerText]}>
          VisionCamera requires a native build.{"\n\n"}
          Please open the custom dev build instead of Expo Go.
        </Text>
      </View>
    );
  }

  if (process.env.EXPO_OS === 'web') {
    return (
      <View style={styles.center}>
        <Text style={styles.infoText}>VisionCamera is not supported on Web.</Text>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#ff5a36" />
        <Text style={styles.loadingText}>Initializing Camera...</Text>
      </View>
    );
  }

  if (!hasPermissions) {
    return (
      <View style={styles.center}>
        <Text style={styles.infoText}>Camera and microphone access is required.</Text>
        <Pressable style={styles.authButton} onPress={requestPermissions}>
          <Text style={styles.authButtonText}>Grant Permissions</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={styles.container}>
      <GestureDetector gesture={combinedGesture}>
        <View style={styles.container}>
          <Camera
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            device={device}
            format={format}
            isActive={appIsActive}
            video
            audio
            photo
            zoom={zoom}
            exposure={hasExposureControl ? exposure : undefined}
            torch={cameraPosition === 'back' ? torch : 'off'}
            videoStabilizationMode="auto"
          />

          <Reanimated.View pointerEvents="none" style={[styles.focusContainer, focusStyle]}>
            <View style={styles.focusRing} />
          </Reanimated.View>

          <SafeAreaView style={styles.overlay}>
            <View style={styles.topHud}>
              <View style={styles.statusChip}>
                {isRecording && <Reanimated.View style={[styles.redDot, dotAnimatedStyle]} />}
                <Text style={styles.statusText}>{status}</Text>
              </View>

              <View style={styles.hardwareControlsRow}>
                <Pressable
                  style={[styles.iconButton, countdown !== null && styles.iconButtonDisabled]}
                  onPress={() => setSelfTimer((prev) => (prev === 0 ? 3 : prev === 3 ? 10 : 0))}
                  disabled={isRecording || countdown !== null}
                >
                  <Text style={styles.iconText}>{selfTimer === 0 ? 'TIMER OFF' : `${selfTimer}s`}</Text>
                </Pressable>

                {device.hasTorch && cameraPosition === 'back' && (
                  <Pressable style={styles.iconButton} onPress={toggleTorch}>
                    <Text style={styles.iconText}>{torch === 'on' ? 'FLASH ON' : 'FLASH OFF'}</Text>
                  </Pressable>
                )}

                <Pressable style={styles.iconButton} onPress={flipCamera} disabled={isRecording}>
                  <Text style={styles.iconText}>FLIP ↺</Text>
                </Pressable>
              </View>
            </View>

            {isRecording && (
              <View style={styles.recordingTimerWrap}>
                <Text style={styles.recordingTimerText}>
                  {Math.floor(recordingSeconds / 60)
                    .toString()
                    .padStart(2, '0')}
                  :
                  {Math.floor(recordingSeconds % 60)
                    .toString()
                    .padStart(2, '0')}
                </Text>
              </View>
            )}

            <View style={styles.middleHud}>
              <View style={styles.meteringOverlay}>
                <Text style={styles.dbText}>Volume: {mapDbToUi(currentDb).toFixed(1)} / 60</Text>
                <View style={styles.meterBarContainer}>
                  <View style={[styles.meterBar, { width: `${(mapDbToUi(currentDb) / 60) * 100}%` }]} />
                </View>
              </View>

              {result && (
                <View style={styles.validationToast}>
                  <Text style={styles.validationTitle}>Audio Validation Passed</Text>
                  <Text style={styles.validationLog}>
                    mean_volume: {renderDbValue(result.meanDb)}{'\n'}
                    max_volume: {renderDbValue(result.maxDb)}{'\n'}
                    duration: {result.duration.toFixed(1)}s
                  </Text>
                </View>
              )}
            </View>

            <View style={styles.bottomDock}>
              <View style={styles.zoomContainer}>
                {[1, 2].map((preset) => {
                  const active = Math.abs(zoom - preset) < 0.12;
                  return (
                    <Pressable
                      key={preset}
                      style={[styles.zoomButton, active && styles.zoomButtonActive]}
                      onPress={() => setZoomPreset(preset)}
                    >
                      <Text style={[styles.zoomButtonText, active && styles.zoomButtonTextActive]}>
                        {preset}x
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <View style={styles.bottomControls}>
                <View style={styles.sideInfoBlock}>
                  <Text style={styles.sideLabel}>{format ? `${format.maxFps} FPS` : '30 FPS'}</Text>
                  <Text style={styles.sideSubLabel}>{cameraPosition.toUpperCase()}</Text>
                </View>

                <Pressable
                  style={[styles.recordBtn, isRecording && styles.recordBtnActive]}
                  onPress={handleRecordPress}
                >
                  <View style={isRecording ? styles.recordInnerSquare : styles.recordInner} />
                </Pressable>

                <View style={styles.sideInfoBlock}>
                  <Text style={styles.sideLabel}>EXPOSURE</Text>
                  <Text style={styles.sideSubLabel}>
                    {hasExposureControl ? exposure.toFixed(1) : 'AUTO'}
                  </Text>
                </View>
              </View>
            </View>

            {countdown !== null && (
              <View style={styles.countdownContainer} pointerEvents="none">
                <Reanimated.Text
                  key={countdown}
                  entering={FadeIn.duration(150)}
                  exiting={FadeOut.duration(150)}
                  style={styles.countdownText}
                >
                  {countdown}
                </Reanimated.Text>
              </View>
            )}
          </SafeAreaView>

          <GestureDetector gesture={exposureGesture}>
            <View style={styles.sideBrightnessContainer} pointerEvents="box-none">
              {hasExposureControl ? (
                <>
                  <View style={styles.sideBrightnessTrack} />
                  <Reanimated.View style={[styles.sideBrightnessIndicator, sideBrightnessStyle]} />
                </>
              ) : (
                <View style={styles.exposureUnavailable}>
                  <Text style={styles.exposureUnavailableText}>AUTO</Text>
                </View>
              )}
            </View>
          </GestureDetector>
        </View>
      </GestureDetector>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#09090b' },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#09090b',
    padding: 24,
  },
  centerText: { textAlign: 'center', marginTop: 20 },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingBottom: 22,
  },
  topHud: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 12,
    gap: 12,
  },
  statusChip: {
    minHeight: 42,
    borderRadius: 21,
    paddingHorizontal: 14,
    backgroundColor: 'rgba(0,0,0,0.48)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusText: { color: '#fff', fontSize: 15, fontWeight: '700', letterSpacing: 0.6 },
  hardwareControlsRow: { flexDirection: 'row', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  iconButton: {
    backgroundColor: 'rgba(0,0,0,0.48)',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 16,
  },
  iconButtonDisabled: { opacity: 0.5 },
  iconText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  recordingTimerWrap: {
    alignSelf: 'center',
    marginTop: 12,
    backgroundColor: 'rgba(255,90,54,0.92)',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  recordingTimerText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  middleHud: { gap: 12 },
  meteringOverlay: {
    backgroundColor: 'rgba(0,0,0,0.52)',
    padding: 12,
    borderRadius: 16,
    alignSelf: 'stretch',
  },
  dbText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  meterBarContainer: {
    height: 8,
    backgroundColor: '#2a2a2f',
    borderRadius: 999,
    marginTop: 7,
    overflow: 'hidden',
  },
  meterBar: { height: '100%', backgroundColor: '#61f49a' },
  validationToast: {
    backgroundColor: 'rgba(10,10,12,0.78)',
    borderRadius: 16,
    padding: 14,
  },
  validationTitle: { color: '#fff', fontSize: 14, fontWeight: '700', marginBottom: 4 },
  validationLog: { color: '#d3d3d9', fontSize: 12, lineHeight: 18 },
  bottomDock: { gap: 18 },
  zoomContainer: {
    alignSelf: 'center',
    flexDirection: 'row',
    gap: 8,
    backgroundColor: 'rgba(0,0,0,0.42)',
    borderRadius: 999,
    padding: 6,
  },
  zoomButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  zoomButtonActive: { backgroundColor: '#fff' },
  zoomButtonText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  zoomButtonTextActive: { color: '#000' },
  bottomControls: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 20,
  },
  sideInfoBlock: { width: 82, alignItems: 'center', gap: 4 },
  sideLabel: { color: '#fff', fontSize: 12, fontWeight: '800' },
  sideSubLabel: { color: '#bdbdc7', fontSize: 11, fontWeight: '600' },
  recordBtn: {
    width: 88,
    height: 88,
    borderRadius: 44,
    borderWidth: 4,
    borderColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.24)',
  },
  recordBtnActive: { borderColor: '#ff5a36' },
  recordInner: { width: 68, height: 68, borderRadius: 34, backgroundColor: '#ff453a' },
  recordInnerSquare: { width: 30, height: 30, borderRadius: 8, backgroundColor: '#ff453a' },
  infoText: { color: '#fff', fontSize: 16, lineHeight: 24 },
  loadingText: { color: '#bdbdc7', marginTop: 10, fontSize: 15 },
  authButton: {
    backgroundColor: '#fff',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 14,
    marginTop: 12,
  },
  authButtonText: { color: '#000', fontSize: 14, fontWeight: '800' },
  focusContainer: {
    position: 'absolute',
    width: 70,
    height: 70,
    justifyContent: 'center',
    alignItems: 'center',
  },
  focusRing: {
    width: 70,
    height: 70,
    borderRadius: 35,
    borderWidth: 1.5,
    borderColor: '#f6ff57',
    backgroundColor: 'rgba(246,255,87,0.08)',
  },
  sideBrightnessContainer: {
    position: 'absolute',
    right: 8,
    top: '34%',
    width: 48,
    height: 180,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sideBrightnessTrack: {
    width: 4,
    height: 130,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.5)',
  },
  sideBrightnessIndicator: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#f6ff57',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 4,
  },
  exposureUnavailable: {
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  exposureUnavailableText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  countdownContainer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.26)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  countdownText: {
    color: '#fff',
    fontSize: 140,
    fontWeight: '900',
    textShadowColor: 'rgba(0,0,0,0.45)',
    textShadowOffset: { width: 0, height: 4 },
    textShadowRadius: 10,
  },
  redDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#fff',
  },
  timeCode: { fontSize: 28, color: '#fff', fontWeight: '800' },
});
