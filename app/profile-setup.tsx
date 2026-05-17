import * as ImagePicker from "expo-image-picker";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Image, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { saveUserProfile, getPendingSignup } from "./(constants)/authService";

export default function ProfileSetupScreen() {
  const router = useRouter();
  const [name,setName]     = useState("");
  const [photo,setPhoto]   = useState("");
  const [loading,setLoading] = useState(false);

  const pickPhoto = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing:true, aspect:[1,1], quality:0.7 });
    if (!result.canceled && result.assets[0]) setPhoto(result.assets[0].uri);
  };

  const handleNext = async () => {
    setLoading(true);
    try {
      const pending = await getPendingSignup();
      if (pending) {
        pending.name = name.trim() || pending.name;
        await saveUserProfile(pending);
      }
      // Navigate to security questions (next step in signup)
      router.replace('/security-questions' as any);
    } catch (e: any) {
      Alert.alert('Profile Error', e?.message || 'Failed to save profile');
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==="ios"?"padding":undefined}>
      <LinearGradient colors={["#FFFFFF","#020E1A","#FFFFFF"]} style={StyleSheet.absoluteFillObject}/>
      <View style={S.container}>
        <View style={S.header}>
          <View style={S.badge}><Text style={{fontSize:36}}>👤</Text></View>
          <Text style={S.title}>Profile Setup</Text>
          <Text style={S.sub}>Optional — helps contacts recognise you</Text>
        </View>
        <View style={S.steps}>{[1,2,3,4,5,6,7,8].map(n=><View key={n} style={[S.dot,n<=3&&S.dotDone,n===4&&S.dotActive]}/>)}</View>
        <Text style={S.stepLbl}>Step 3 of 8 — Profile</Text>
        <TouchableOpacity style={S.avatar} onPress={pickPhoto} activeOpacity={0.8}>
          {photo
            ? <Image source={{uri:photo}} style={S.avatarImg}/>
            : <View style={S.avatarPH}><Text style={{fontSize:36}}>📷</Text><Text style={S.avatarHint}>Tap to add photo</Text></View>
          }
        </TouchableOpacity>
        <TextInput style={S.input} placeholder="Display name (optional)" placeholderTextColor="rgba(255,255,255,0.25)" value={name} onChangeText={setName} maxLength={40}/>
        <View style={S.privBox}>
          <Text style={S.privTxt}>Your real photo and name are optional. Many VaultChat users stay fully anonymous with just a VaultID.</Text>
        </View>
        <TouchableOpacity style={[S.btn,loading&&S.btnOff]} onPress={handleNext} disabled={loading} activeOpacity={0.85}>
          {loading?<ActivityIndicator color="#fff"/>:<Text style={S.btnTxt}>Continue</Text>}
        </TouchableOpacity>
        <TouchableOpacity style={S.skip} onPress={handleNext}><Text style={S.skipTxt}>Skip for now</Text></TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const S = StyleSheet.create({
  container:{ flex:1,padding:24,paddingTop:60,alignItems:"center" },
  header:   { alignItems:"center",marginBottom:24,gap:10 },
  badge:    { width:80,height:80,borderRadius:40,backgroundColor:"rgba(74,159,255,0.12)",borderWidth:1.5,borderColor:"rgba(74,159,255,0.3)",justifyContent:"center",alignItems:"center" },
  title:    { color:"#fff",fontSize:24,fontWeight:"900" },
  sub:      { color:"rgba(255,255,255,0.4)",fontSize:13 },
  steps:    { flexDirection:"row",gap:6,marginBottom:6 },
  dot:      { width:24,height:4,borderRadius:2,backgroundColor:"rgba(255,255,255,0.12)" },
  dotActive:{ backgroundColor:"#4A9FFF",width:32 },
  dotDone:  { backgroundColor:"#22C55E" },
  stepLbl:  { color:"rgba(74,159,255,0.7)",fontSize:11,marginBottom:24 },
  avatar:   { width:110,height:110,borderRadius:55,borderWidth:2,borderColor:"rgba(74,159,255,0.3)",overflow:"hidden",marginBottom:24,justifyContent:"center",alignItems:"center",backgroundColor:"rgba(74,159,255,0.06)" },
  avatarImg:{ width:"100%",height:"100%" },
  avatarPH: { alignItems:"center",gap:4 },
  avatarHint:{ color:"rgba(255,255,255,0.3)",fontSize:11 },
  input:    { width:"100%",backgroundColor:"rgba(255,255,255,0.05)",borderWidth:1,borderColor:"rgba(255,255,255,0.1)",borderRadius:12,padding:14,color:"#fff",fontSize:16,marginBottom:16 },
  privBox:  { backgroundColor:"rgba(74,159,255,0.05)",borderWidth:1,borderColor:"rgba(74,159,255,0.15)",borderRadius:12,padding:14,marginBottom:28,width:"100%" },
  privTxt:  { color:"rgba(255,255,255,0.35)",fontSize:12,lineHeight:18,textAlign:"center" },
  btn:      { backgroundColor:"#4A9FFF",borderRadius:14,paddingVertical:16,alignItems:"center",width:"100%",marginBottom:12 },
  btnOff:   { opacity:0.4 },
  btnTxt:   { color:"#fff",fontSize:16,fontWeight:"800" },
  skip:     { padding:10 },
  skipTxt:  { color:"rgba(255,255,255,0.3)",fontSize:13,fontWeight:"600" },
});
