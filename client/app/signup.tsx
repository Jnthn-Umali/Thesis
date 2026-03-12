import React, { useRef, useState } from 'react';
import { View, Text, TextInput, StyleSheet, TouchableOpacity, Platform, KeyboardAvoidingView, ScrollView, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { router, Link } from 'expo-router';

const API_BASE = process.env.EXPO_PUBLIC_AUTH_URL ?? 'http://5.98.238:4000';

export default function SignupScreen() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const nameRef = useRef<TextInput>(null);
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);

  const onSignup = async () => {
    setLoading(true);
    setError('');
    try {
      const payloadName = name.trim();
      const payloadEmail = email.trim().toLowerCase();
      const payloadPassword = password.trim();
      const res = await fetch(`${API_BASE}/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: payloadName, email: payloadEmail, password: payloadPassword })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ message: 'Signup failed' }));
        throw new Error(data.message || 'Signup failed');
      }
      router.replace('/login');
    } catch (e: any) {
      setError(e.message || 'Unable to sign up');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top','left','right']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.select({ ios: 'padding', android: 'height' })}>
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>Create Account</Text>
          <Text style={styles.subtitle}>Sign up to continue.</Text>

          <Text style={styles.label}>Full Name</Text>
          <Pressable onPress={() => nameRef.current?.focus()} style={styles.inputWrapper}>
            <TextInput ref={nameRef} placeholder="Enter your full name" placeholderTextColor="#8a8a8a" value={name} onChangeText={setName} style={styles.input} />
          </Pressable>

          <Text style={[styles.label, { marginTop: 12 }]}>Email Address</Text>
          <Pressable onPress={() => emailRef.current?.focus()} style={styles.inputWrapper}>
            <View style={styles.iconContainer}>
              <Svg width={17} height={14} viewBox="0 0 17 14" fill="none">
                <Path d="M15 0H1.66667C0.75 0 0.00833333 0.75 0.00833333 1.66667L0 11.6667C0 12.5833 0.75 13.3333 1.66667 13.3333H15C15.9167 13.3333 16.6667 12.5833 16.6667 11.6667V1.66667C16.6667 0.75 15.9167 0 15 0ZM14.6667 3.54167L8.775 7.225C8.50833 7.39167 8.15833 7.39167 7.89167 7.225L2 3.54167C1.91644 3.49476 1.84327 3.43138 1.78491 3.35538C1.72655 3.27937 1.68422 3.19232 1.66048 3.09948C1.63674 3.00664 1.63209 2.90995 1.6468 2.81526C1.66151 2.72057 1.69528 2.62984 1.74607 2.54858C1.79686 2.46732 1.8636 2.39721 1.94227 2.3425C2.02094 2.28778 2.10989 2.24959 2.20375 2.23025C2.2976 2.21091 2.3944 2.21081 2.4883 2.22996C2.58219 2.24911 2.67122 2.28711 2.75 2.34167L8.33333 5.83333L13.9167 2.34167C13.9954 2.28711 14.0845 2.24911 14.1784 2.22996C14.2723 2.21081 14.3691 2.21091 14.4629 2.23025C14.5568 2.24959 14.6457 2.28778 14.7244 2.3425C14.8031 2.39721 14.8698 2.46732 14.9206 2.54858C14.9714 2.62984 15.0052 2.72057 15.0199 2.81526C15.0346 2.90995 15.0299 3.00664 15.0062 3.09948C14.9824 3.19232 14.9401 3.27937 14.8818 3.35538C14.8234 3.43138 14.7502 3.49476 14.6667 3.54167Z" fill="#3B3B3B" fillOpacity={0.7} />
              </Svg>
            </View>
            <TextInput ref={emailRef} placeholder="Enter your email address" placeholderTextColor="#8a8a8a" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" style={[styles.input, styles.inputWithIcon]} />
          </Pressable>

          <Text style={[styles.label, { marginTop: 12 }]}>Password</Text>
          <Pressable onPress={() => passwordRef.current?.focus()} style={styles.inputWrapper}>
            <View style={styles.iconContainer}>
              <Svg width={20} height={20} viewBox="0 0 20 20" fill="none">
                <Path d="M5.41732 17.4999C4.8444 17.4999 4.35412 17.3446 3.94648 17.034C3.53885 16.7235 3.33468 16.3497 3.33398 15.9126V7.97611C3.33398 7.5396 3.53815 7.16606 3.94648 6.85547C4.35482 6.54489 4.8451 6.38934 5.41732 6.38881H6.45898V4.80151C6.45898 3.70362 6.96697 2.76791 7.98294 1.99436C8.99891 1.22082 10.227 0.833782 11.6673 0.833252C13.1076 0.832723 14.3361 1.21976 15.3527 1.99436C16.3694 2.76897 16.877 3.70468 16.8756 4.80151V6.38881H17.9173C18.4902 6.38881 18.9809 6.54436 19.3892 6.85547C19.7975 7.16658 20.0013 7.54013 20.0006 7.97611V15.9126C20.0006 16.3491 19.7968 16.7229 19.3892 17.034C18.9816 17.3452 18.4909 17.5004 17.9173 17.4999H5.41732ZM11.6673 13.5317C12.2402 13.5317 12.7309 13.3764 13.1392 13.0658C13.5475 12.7552 13.7513 12.3814 13.7506 11.9444C13.75 11.5073 13.5461 11.1338 13.1392 10.8237C12.7322 10.5137 12.2416 10.3581 11.6673 10.3571C11.093 10.356 10.6027 10.5116 10.1965 10.8237C9.79023 11.1359 9.58607 11.5094 9.58398 11.9444C9.5819 12.3793 9.78607 12.7531 10.1965 13.0658C10.6069 13.3785 11.0972 13.5338 11.6673 13.5317ZM8.54232 6.38881H14.7923V4.80151C14.7923 4.14013 14.4885 3.57796 13.8809 3.115C13.2732 2.65204 12.5354 2.42055 11.6673 2.42055C10.7993 2.42055 10.0614 2.65204 9.45377 3.115C8.84614 3.57796 8.54232 4.14013 8.54232 4.80151V6.38881Z" fill="#3B3B3B" fillOpacity={0.7} />
              </Svg>
            </View>
            <TextInput ref={passwordRef} placeholder="Enter your password" placeholderTextColor="#8a8a8a" value={password} onChangeText={setPassword} secureTextEntry={!showPassword} style={[styles.input, styles.inputWithIcon]} />
            <TouchableOpacity onPress={() => setShowPassword(!showPassword)} style={styles.eyeIconContainer}>
              <Svg width={16} height={12} viewBox="0 0 16 12" fill="none">
                <Path d="M8 0C10.9432 0 14.5296 2.0555 15.784 5.01841C15.9008 5.29735 16 5.62221 16 5.95303C16 6.283 15.9016 6.60872 15.784 6.88766C14.5288 9.85057 10.9424 11.9061 8 11.9061C5.0576 11.9061 1.4704 9.85057 0.216 6.88766C0.0992 6.60787 0 6.28385 0 5.95303C0 5.62307 0.0984 5.29735 0.216 5.01841C1.4712 2.0555 5.0576 0 8 0ZM8 2.5513C7.15131 2.5513 6.33737 2.9097 5.73726 3.54764C5.13714 4.18559 4.8 5.05084 4.8 5.95303C4.8 6.85523 5.13714 7.72047 5.73726 8.35842C6.33737 8.99637 7.15131 9.35477 8 9.35477C8.84869 9.35477 9.66263 8.99637 10.2627 8.35842C10.8629 7.72047 11.2 6.85523 11.2 5.95303C11.2 5.05084 10.8629 4.18559 10.2627 3.54764C9.66263 2.9097 8.84869 2.5513 8 2.5513ZM8 4.25217C8.42435 4.25217 8.83131 4.43137 9.13137 4.75034C9.43143 5.06931 9.6 5.50194 9.6 5.95303C9.6 6.40413 9.43143 6.83675 9.13137 7.15573C8.83131 7.4747 8.42435 7.6539 8 7.6539C7.57565 7.6539 7.16869 7.4747 6.86863 7.15573C6.56857 6.83675 6.4 6.40413 6.4 5.95303C6.4 5.50194 6.56857 5.06931 6.86863 4.75034C7.16869 4.43137 7.57565 4.25217 8 4.25217Z" fill="#505050" fillOpacity={0.75} />
              </Svg>
            </TouchableOpacity>
          </Pressable>

          {!!error && <Text style={styles.error}>{error}</Text>}

          <TouchableOpacity onPress={onSignup} disabled={loading} style={[styles.button, loading && { opacity: 0.6 }]}>
            <Text style={styles.buttonText}>{loading ? 'Signing Up...' : 'Sign Up'}</Text>
          </TouchableOpacity>

          <View style={styles.signupRow}>
            <Text style={styles.signupText}>Already have an account? </Text>
            <Link href="/" style={styles.signupLink}>Log In</Link>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 24, paddingHorizontal: 20, backgroundColor: '#FFF7DB' },
  title: { fontSize: 28, fontWeight: '700', color: '#222', marginTop: 8, marginBottom: 8 },
  subtitle: { fontSize: 14, color: '#555', marginBottom: 20 },
  scrollContent: { paddingBottom: 40 },
  label: { fontSize: 12, color: '#222', marginBottom: 6, fontWeight: '600' },
  inputWrapper: { borderWidth: 1, borderColor: '#cfe3ff', borderRadius: 10, paddingHorizontal: 12, paddingVertical: Platform.select({ ios: 14, android: 8 }), backgroundColor: '#f9fcff', flexDirection: 'row', alignItems: 'center' },
  input: { fontSize: 14, color: '#222' },
  inputWithIcon: { marginLeft: 8, flex: 1 },
  iconContainer: { width: 20, alignItems: 'center', justifyContent: 'center' },
  eyeIconContainer: { padding: 4, marginLeft: 8 },
  error: { color: '#d32f2f', marginTop: 10 },
  button: { marginTop: 20, backgroundColor: '#90bdf2', paddingVertical: 14, borderRadius: 8, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '700' },
  signupRow: { flexDirection: 'row', justifyContent: 'center', marginTop: 18 },
  signupText: { color: '#222' },
  signupLink: { color: '#4f8ad9', textDecorationLine: 'underline' }
});


