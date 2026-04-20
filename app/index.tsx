
import Constants from 'expo-constants';
import React, { useEffect, useRef, useState } from 'react';
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

// Conditional imports to prevent Expo Go crashes
let VisionCamera: any = {
  Camera: () => null,
  useCameraDevice: () => null,
  useCameraFormat: () => null,
};
let LiveAudioStream: any = {
  init: () => { },
  on: () => { },
  start: () => { },
  stop: () => { },
};

if (Constants.appOwnership !== 'expo') {
  try {
    VisionCamera = require('react-native-vision-camera');
    LiveAudioStream = require('react-native-live-audio-stream').default || require('react-native-live-audio-stream');
  } catch (e) {
    console.error('Failed to load native modules', e);
  }
}

const { Camera, useCameraDevice, useCameraFormat } = VisionCamera;

type AudioValidationResult = {
  meanDb: number | null;
  maxDb: number | null;
  isSilent: boolean;
  duration: number;
};

// Thresholds
const MIN_VIDEO_SECONDS = 2;

export default function Index() {
  const cameraRef = useRef<any>(null);
  const [cameraPosition, setCameraPosition] = useState<'front' | 'back'>('back');
  const device = useCameraDevice(cameraPosition);

  const format = useCameraFormat(device, [
    { videoResolution: 'max' },
    { fps: 60 }
  ]);

  // Check if we are in Expo Go
  if (Constants.appOwnership === 'expo') {
    return (
      <View style={styles.center}>
        <Text style={styles.timeCode}>EXPO GO DETECTED</Text>
        <Text style={[styles.infoText, { textAlign: 'center', marginTop: 20 }]}>
          VisionCamera requires a native build.{"\n\n"}
          Please close Expo Go and open the custom app named "myApp" from your home screen.
        </Text>
      </View>
    );
  }

  // VisionCamera throws if accessed on unsupported platforms
  if (process.env.EXPO_OS === 'web') {
    return (
      <View style={styles.center}>
        <Text style={styles.infoText}>VisionCamera is not supported on Web.</Text>
      </View>
    );
  }

  const [appIsActive, setAppIsActive] = useState(true);
  const [torch, setTorch] = useState<'off' | 'on'>('off');

  const [hasPermissions, setHasPermissions] = useState<boolean>(false);
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState('STBY');
  const [result, setResult] = useState<AudioValidationResult | null>(null);

  // Audio metering state
  // LiveAudioStream doesn't need to be initialized with 'new'
  const [currentDb, setCurrentDb] = useState<number>(-160);
  const maxDbRef = useRef<number>(-160);
  const sumDbRef = useRef<number>(0);
  const countDbRef = useRef<number>(0);

  // Helper to calculate dB from base64 PCM data
  const calculateDb = (base64Data: string) => {
    try {
      const binaryString = atob(base64Data);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const pcm16 = new Int16Array(bytes.buffer);

      let sumSquares = 0;
      for (let i = 0; i < pcm16.length; i++) {
        sumSquares += pcm16[i] * pcm16[i];
      }

      const rms = Math.sqrt(sumSquares / pcm16.length);
      // dB = 20 * log10(RMS / MaxAmplitude)
      // Max for 16-bit is 32768
      const db = rms > 0 ? 20 * Math.log10(rms / 32768) : -160;
      return db;
    } catch (e) {
      return -160;
    }
  };

  useEffect(() => {
    requestPermissions();
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      setAppIsActive(nextAppState === 'active');
    });
    return () => subscription.remove();
  }, []);

  const requestPermissions = async () => {
    const camStatus = await Camera.requestCameraPermission();
    const micStatus = await Camera.requestMicrophonePermission();
    setHasPermissions(camStatus === 'granted' && micStatus === 'granted');
  };

  const flipCamera = () => {
    if (isRecording) return;
    setCameraPosition((p) => (p === 'back' ? 'front' : 'back'));
  };

  const toggleTorch = () => {
    setTorch((t) => (t === 'off' ? 'on' : 'off'));
  };

  const startRecording = async () => {
    if (!cameraRef.current) return;
    setResult(null);
    try {
      setIsRecording(true);
      setStatus('REC');

      // Start Metering
      maxDbRef.current = -160;
      sumDbRef.current = 0;
      countDbRef.current = 0;

      const options = {
        sampleRate: 44100,
        channels: 1,
        bitsPerSample: 16,
        audioSource: 6, // VOICE_RECOGNITION or DEFAULT
        bufferSize: 4096
      };

      LiveAudioStream.init(options);
      LiveAudioStream.on('data', (data) => {
        const db = calculateDb(data);
        setCurrentDb(db);
        if (db > maxDbRef.current) maxDbRef.current = db;
        sumDbRef.current += db;
        countDbRef.current += 1;
      });
      LiveAudioStream.start();

      cameraRef.current.startRecording({
        fileType: 'mp4',
        onRecordingFinished: async (video) => {
          try {
            setStatus('PROCESSING...');

            // Stop Metering accurately
            LiveAudioStream.stop();

            const finalMax = maxDbRef.current;
            const finalMean = countDbRef.current > 0 ? sumDbRef.current / countDbRef.current : -160;
            const finalDuration = video.duration || 0;

            console.log('Final Audio Stats:', { finalMax, finalMean, finalDuration });

            // VALIDATION LOGIC
            let errorMsg = '';
            if (finalDuration < 2) {
              errorMsg = 'Video is too short (minimum 2 seconds).';
            } else if (finalMax <= -35) {
              errorMsg = `Audio too quiet! Max volume was ${mapDbToUi(finalMax).toFixed(1)} Units (minimum 25.0).`;
            } else if (finalMean <= -45) {
              errorMsg = `Audio level too low! Average volume was ${mapDbToUi(finalMean).toFixed(1)} Units (minimum 15.0).`;
            }

            if (errorMsg) {
              Alert.alert('Video Rejected', errorMsg);
              setStatus('REJECTED');
            } else {
              const audioCheck: AudioValidationResult = {
                meanDb: finalMean,
                maxDb: finalMax,
                isSilent: false,
                duration: finalDuration,
              };
              setResult(audioCheck);
              setStatus('SUCCESS');
            }
          } catch (error: any) {
            setStatus('ERROR');
            Alert.alert('Error', error?.message || 'Processing failed');
          } finally {
            setIsRecording(false);
            setTorch('off');
          }
        },
        onRecordingError: (error) => {
          setIsRecording(false);
          setStatus('STBY');
          setTorch('off');
          Alert.alert('Camera Error', error.message);
        },
      });
    } catch (error: any) {
      setIsRecording(false);
      setStatus('STBY');
      Alert.alert('Failed to start recording', error?.message || 'Unknown error');
    }
  };

  const stopRecording = async () => {
    setIsRecording(false);
    setStatus('PROCESSING...');
    await cameraRef.current?.stopRecording();
  };

  const mapDbToUi = (db: number | null) => {
    if (db === null) return 0;
    // Map -60 dB (quiet) to 0, and 0 dB (loud) to 60
    const val = db + 60;
    return Math.max(0, Math.min(60, val));
  };

  const renderDbValue = (val: number | null) => {
    if (val === null) return 'N/A';
    const uiVal = mapDbToUi(val);
    return `${uiVal.toFixed(1)} Units`;
  };

  if (!device) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#ff3b30" />
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
    <View style={styles.container}>
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        format={format}
        isActive={appIsActive}
        video={true}
        audio={true}
        torch={torch}
        videoStabilizationMode="cinematic"
      />

      <SafeAreaView style={styles.overlay}>
        <View style={styles.topHud}>
          <Text style={styles.timeCode}>{status}</Text>
          <View style={styles.hardwareControlsRow}>
            {device.hasTorch && (
              <Pressable style={styles.iconButton} onPress={toggleTorch}>
                <Text style={styles.iconText}>
                  {torch === 'on' ? 'FLASH ON' : 'FLASH OFF'}
                </Text>
              </Pressable>
            )}
            <Pressable style={styles.iconButton} onPress={flipCamera} disabled={isRecording}>
              <Text style={styles.iconText}>FLIP ↺</Text>
            </Pressable>
          </View>
        </View>

        {isRecording && (
          <View style={styles.meteringOverlay}>
            <Text style={styles.dbText}>Volume: {mapDbToUi(currentDb).toFixed(1)} / 60</Text>
            <View style={styles.meterBarContainer}>
              <View style={[styles.meterBar, { width: `${(mapDbToUi(currentDb) / 60) * 100}%` }]} />
            </View>
          </View>
        )}

        {result && (
          <View style={styles.validationToast}>
            <Text style={styles.validationTitle}>
              ● Audio Validation Passed
            </Text>
            <Text style={styles.validationLog}>
              mean_volume: {renderDbValue(result.meanDb)}{"\n"}
              max_volume: {renderDbValue(result.maxDb)}{"\n"}
              duration: {result.duration.toFixed(1)}s
            </Text>
          </View>
        )}

        <View style={styles.bottomControls}>
          <Text style={styles.sideText}>
            {format ? `${format.maxFps}FPS` : 'RECAP'}
          </Text>
          <Pressable
            style={[styles.recordBtn, isRecording && styles.recordBtnActive]}
            onPress={isRecording ? stopRecording : startRecording}
          >
            <View style={isRecording ? styles.recordInnerSquare : styles.recordInner} />
          </Pressable>
          <Text style={styles.sideText}>GALLERY</Text>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0b' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0a0a0b' },
  overlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'space-between', padding: 24 },
  topHud: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 20, marginHorizontal: 20 },
  hardwareControlsRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  timeCode: { fontSize: 32, color: '#fff' },
  iconButton: { backgroundColor: '#000', padding: 10, borderRadius: 10 },
  iconText: { color: '#fff', fontSize: 12 },
  validationToast: { backgroundColor: '#161618', padding: 15, borderRadius: 10 },
  validationTitle: { color: '#fff', marginBottom: 5 },
  validationLog: { color: '#aaa', fontSize: 12 },
  bottomControls: { flexDirection: 'row', justifyContent: 'space-evenly', marginBottom: 40 },
  recordBtn: { width: 80, height: 80, borderRadius: 40, borderWidth: 4, borderColor: '#fff', justifyContent: 'center', alignItems: 'center' },
  recordBtnActive: { borderColor: '#999' },
  recordInner: { width: 60, height: 60, borderRadius: 30, backgroundColor: 'red' },
  recordInnerSquare: { width: 30, height: 30, backgroundColor: 'red' },
  sideText: { color: '#aaa' },
  infoText: { color: '#fff', marginBottom: 10 },
  loadingText: { color: '#aaa', marginTop: 10 },
  authButton: { backgroundColor: '#fff', padding: 10 },
  authButtonText: { color: '#000' },
  meteringOverlay: { backgroundColor: 'rgba(0,0,0,0.5)', padding: 10, borderRadius: 10, marginBottom: 10 },
  dbText: { color: '#fff', fontSize: 14, fontWeight: 'bold' },
  meterBarContainer: { height: 8, backgroundColor: '#333', borderRadius: 4, marginTop: 5, overflow: 'hidden' },
  meterBar: { height: '100%', backgroundColor: '#4cd964' },
});

