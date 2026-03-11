import { Stack } from "expo-router";

export default function RootLayout() {
  return (
    <Stack screenOptions={{ headerShown:false, animation:"fade", contentStyle:{ backgroundColor:"#010812" } }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="welcome" />
      <Stack.Screen name="lock" options={{ gestureEnabled:false }} />
      <Stack.Screen name="phone" />
      <Stack.Screen name="otp" />
      <Stack.Screen name="vault-id" />
      <Stack.Screen name="profile-setup" />
      <Stack.Screen name="security-questions" />
      <Stack.Screen name="secret-code" />
      <Stack.Screen name="biometric-setup" />
      <Stack.Screen name="permissions" />
      <Stack.Screen name="setup-complete" />
      <Stack.Screen name="face-verify-new-device" />
      <Stack.Screen name="chats" />
    </Stack>
  );
}
