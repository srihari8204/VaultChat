import { HEADER_TOP } from '../constants/layout';
import { BRAND_ACCENT } from '../constants/theme';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { Ionicons } from '@expo/vector-icons';

import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState, useMemo } from 'react';
import { Alert, Animated, Dimensions, Easing, Modal, ScrollView, Share, StyleSheet, Text, TextInput, TouchableOpacity, View, useWindowDimensions} from 'react-native';
import { VaultID, destroyVaultID, generateIdentityCertificate, generateVaultID, loadVaultID, shortAddress, signMessage, updateTrustScore } from '../constants/vaultID';
import type { Palette } from '../constants/theme';
import { useColors } from '../lib/theme';
import { KeyboardSafe } from '../components/ui/KeyboardSafe';


const AVATARS = ['🧑','👩','👨','🧔','👧','👦','🧓','👴','👵','🦸','🦹','🧙','🧝','🧛','🤖','👾'];

function VaultIDScreenContent() {
  const c = useColors();
  // Reactive size: follows rotation, folds and split-screen resizes, and is
  // threaded into makeS so the derived featureCard width follows too.
  const {width} = useWindowDimensions();
  const S = useMemo(() => makeS(c, width), [c, width]);

  const router = useRouter();
  const [vaultID, setVaultID] = useState<VaultID | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [showCert, setShowCert] = useState(false);
  const [certificate, setCertificate] = useState('');
  const [creating, setCreating] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [selectedAvatar, setSelectedAvatar] = useState('🧑');
  const [signedMsg, setSignedMsg] = useState('');

  const fadeIn    = useRef(new Animated.Value(0)).current;
  const pulse     = useRef(new Animated.Value(1)).current;
  const rotate    = useRef(new Animated.Value(0)).current;
  const chainAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeIn,{toValue:1,duration:700,useNativeDriver:true}).start();
    Animated.loop(Animated.sequence([
      Animated.timing(pulse,{toValue:1.06,duration:1800,easing:Easing.inOut(Easing.ease),useNativeDriver:true}),
      Animated.timing(pulse,{toValue:1.00,duration:1800,easing:Easing.inOut(Easing.ease),useNativeDriver:true}),
    ])).start();
    Animated.loop(Animated.timing(rotate,{toValue:1,duration:12000,easing:Easing.linear,useNativeDriver:true})).start();
    Animated.loop(Animated.sequence([
      Animated.timing(chainAnim,{toValue:1,duration:2000,useNativeDriver:true}),
      Animated.timing(chainAnim,{toValue:0,duration:2000,useNativeDriver:true}),
    ])).start();
    loadID();
  },[chainAnim, fadeIn, pulse, rotate]);

  const loadID = async () => {
    const id = await loadVaultID();
    setVaultID(id);
    setLoading(false);
    if(!id) setTimeout(()=>setShowCreate(true),800);
  };

  const handleCreate = async () => {
    if(!displayName.trim()){ Alert.alert('Required','Please enter your display name'); return; }
    setCreating(true);
    try {
      const id = await generateVaultID(displayName.trim(), selectedAvatar, bio.trim());
      setVaultID(id);
      setShowCreate(false);
      setDisplayName(''); setBio('');
      Alert.alert('🧬 VaultID Created!', 'Your cryptographic identity is ready.\n\nShare it and nobody learns your number.\n\nYour VaultTag: ' + id.vaultTag);
    } catch {
      Alert.alert('Error','Failed to create VaultID. Try again.');
    }
    setCreating(false);
  };

  const handleGenerateCert = async () => {
    if(!vaultID) return;
    try {
      const cert = await generateIdentityCertificate(vaultID);
      setCertificate(cert);
      setShowCert(true);
    } catch { Alert.alert('Error','Could not generate certificate'); }
  };

  const handleSign = async () => {
    try {
      const msg = 'crazzychat Identity Proof — ' + Date.now();
      const sig = await signMessage(msg);
      setSignedMsg(sig.substring(0,40)+'...');
      Alert.alert('✅ Signed!','Message signed with your private key.\n\nThis proves you own this VaultID without revealing your private key.');
    } catch { Alert.alert('Error','Could not sign message'); }
  };

  const handleShare = async () => {
    if(!vaultID) return;
    await Share.share({
      message: 'Add me on crazzychat!\n\nVaultTag: '+vaultID.vaultTag+'\nWallet: '+shortAddress(vaultID.walletAddress)+'\n\nFind me by VaultTag instead of my number.',
      title: 'My VaultID',
    });
  };

  const handleDestroy = () => {
    Alert.alert('💀 Destroy VaultID','This will permanently delete your cryptographic identity.\n\nThis cannot be undone!',[
      {text:'Cancel',style:'cancel'},
      {text:'DESTROY',style:'destructive',onPress:async()=>{
        await destroyVaultID();
        setVaultID(null);
        setTimeout(()=>setShowCreate(true),500);
      }},
    ]);
  };

  const trustColor = (score: number) => score>=80?BRAND_ACCENT:score>=50?'#F59E0B':'#EF4444';
  const rotateStr = rotate.interpolate({inputRange:[0,1],outputRange:['0deg','360deg']});
  const chainOpacity = chainAnim.interpolate({inputRange:[0,1],outputRange:[0.3,1]});

  if(loading) return (
    <LinearGradient colors={['#FFFFFF','#060F24']} style={{flex:1,justifyContent:'center',alignItems:'center'}}>
      <Text style={{color:'#7C3AED',fontSize:40}}>🧬</Text>
      <Text style={{color:'#4A9FFF',fontSize:14,marginTop:12,letterSpacing:2}}>LOADING VAULT ID...</Text>
    </LinearGradient>
  );

  return (
    <LinearGradient colors={['#FFFFFF','#040F20','#060F24']} style={{flex:1}}>
      <Animated.ScrollView style={[{flex:1,opacity:fadeIn}]} contentContainerStyle={S.container}>

        {/* Header */}
        <View style={S.header}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={()=>router.back()} style={S.backBtn}>
            <Ionicons name="arrow-back" size={24} color="#4A9FFF" />
          </TouchableOpacity>
          <View style={{flex:1}}>
            <Text style={S.headerTitle}>🧬 VaultID</Text>
            <Text style={{color:'#3D5A7A',fontSize:10,letterSpacing:1.5}}>CRYPTOGRAPHIC IDENTITY</Text>
          </View>
          {vaultID&&<TouchableOpacity onPress={handleShare} style={S.shareBtn}>
            <Text style={{color:'#4A9FFF',fontSize:12,fontWeight:'700'}}>Share</Text>
          </TouchableOpacity>}
        </View>

        {vaultID ? (<>

          {/* Main ID Card */}
          <Animated.View style={[S.idCard,{transform:[{scale:pulse}]}]}>
            <LinearGradient colors={['#0D1E3A','#F9FAFB','#060F20']} style={S.idCardInner}>

              {/* Identity spinning ring */}
              <Animated.View style={[S.chainRing,{transform:[{rotate:rotateStr}]}]}/>

              {/* Avatar */}
              <View style={S.avatarContainer}>
                <LinearGradient colors={['#1D4ED8','#7C3AED']} style={S.avatarGrad}>
                  <Text style={{fontSize:44}}>{vaultID.avatar}</Text>
                </LinearGradient>
                {vaultID.isVerified&&<View style={S.verifiedBadge}><Text style={{fontSize:14}}>✅</Text></View>}
              </View>

              {/* Name & VaultTag */}
              <Text numberOfLines={1} style={S.displayName}>{vaultID.displayName}</Text>
              <View style={S.vaultTagRow}>
                <LinearGradient colors={['#1D4ED8','#7C3AED']} style={S.vaultTagBadge} start={{x:0,y:0}} end={{x:1,y:0}}>
                  <Text style={S.vaultTagText}>{vaultID.vaultTag}</Text>
                </LinearGradient>
              </View>

              {vaultID.bio?<Text style={S.bioText}>{vaultID.bio}</Text>:null}

              {/* Wallet Address */}
              <View style={S.walletRow}>
                <Text style={{color:'#3D5A7A',fontSize:10,letterSpacing:1}}>WALLET</Text>
                <Text style={S.walletAddr}>{shortAddress(vaultID.walletAddress)}</Text>
                <View style={S.blockchainDot}/>
              </View>

              {/* Trust Score */}
              <View style={S.trustRow}>
                <Text style={{color:'#3D5A7A',fontSize:10,letterSpacing:1}}>TRUST SCORE</Text>
                <View style={S.trustBar}>
                  <View style={[S.trustFill,{width:(vaultID.trustScore)+'%' as any,backgroundColor:trustColor(vaultID.trustScore)}]}/>
                </View>
                <Text style={[S.trustScore,{color:trustColor(vaultID.trustScore)}]}>{vaultID.trustScore}</Text>
              </View>

              {/* Chain blocks decoration */}
              <Animated.View style={[S.chainBlocks,{opacity:chainOpacity}]}>
                {['🔗','⛓️','🔗','⛓️','🔗'].map((c,i)=>(
                  <Text key={i} style={{fontSize:10,opacity:0.6}}>{c}</Text>
                ))}
              </Animated.View>

              {/* No phone badge */}
              <View style={S.nophone}>
                <Text style={{color:BRAND_ACCENT,fontSize:10,fontWeight:'800',letterSpacing:1}}>📵 NO PHONE NUMBER · EVER</Text>
              </View>
            </LinearGradient>
          </Animated.View>

          {/* Stats row */}
          <View style={S.statsRow}>
            {[
              {label:'CREATED',value:new Date(vaultID.createdAt).toLocaleDateString()},
              {label:'TRUST',value:vaultID.trustScore+'/100'},
              {label:'STATUS',value:vaultID.isVerified?'VERIFIED':'ACTIVE'},
            ].map((s,i)=>(
              <View key={i} style={S.statCard}>
                <Text style={S.statValue}>{s.value}</Text>
                <Text style={S.statLabel}>{s.label}</Text>
              </View>
            ))}
          </View>

          {/* Action buttons */}
          <View style={S.actions}>
            <TouchableOpacity onPress={handleSign} style={S.actionBtn}>
              <LinearGradient colors={['#1D4ED8','#1E40AF']} style={S.actionGrad}>
                <Text style={{fontSize:20}}>✍️</Text>
                <Text style={S.actionText}>Sign Message</Text>
                <Text style={S.actionSub}>Prove ownership</Text>
              </LinearGradient>
            </TouchableOpacity>

            <TouchableOpacity onPress={handleGenerateCert} style={S.actionBtn}>
              <LinearGradient colors={['#7C3AED','#6D28D9']} style={S.actionGrad}>
                <Text style={{fontSize:20}}>📜</Text>
                <Text style={S.actionText}>Certificate</Text>
                <Text style={S.actionSub}>Cryptographic proof</Text>
              </LinearGradient>
            </TouchableOpacity>

            <TouchableOpacity onPress={()=>setShowDetails(true)} style={S.actionBtn}>
              <LinearGradient colors={['#0369A1','#0284C7']} style={S.actionGrad}>
                <Text style={{fontSize:20}}>🔍</Text>
                <Text style={S.actionText}>Full Details</Text>
                <Text style={S.actionSub}>Keys & data</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>

          {/* Trust score actions */}
          <View style={S.trustActions}>
            <Text style={{color:'#3D5A7A',fontSize:11,letterSpacing:1,marginBottom:10}}>TRUST SCORE ACTIONS</Text>
            <View style={{flexDirection:'row',gap:10}}>
              <TouchableOpacity onPress={async()=>{const s=await updateTrustScore(5);setVaultID(v=>v?{...v,trustScore:s}:v);}} style={{flex:1,backgroundColor:'rgba(34,197,94,0.16)',borderRadius:12,padding:12,alignItems:'center',borderWidth:1,borderColor:'#166534'}}>
                <Text style={{color:'#4ADE80',fontSize:13,fontWeight:'700'}}>+5 Verified Contact</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={async()=>{const s=await updateTrustScore(-10);setVaultID(v=>v?{...v,trustScore:s}:v);}} style={{flex:1,backgroundColor:'rgba(239,68,68,0.16)',borderRadius:12,padding:12,alignItems:'center',borderWidth:1,borderColor:'rgba(239,68,68,0.18)'}}>
                <Text style={{color:'#FCA5A5',fontSize:13,fontWeight:'700'}}>-10 Report Spam</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Identity features */}
          <View style={S.featuresGrid}>
            {[
              {icon:'🔐',title:'Zero-Knowledge',sub:'Identity without personal data'},
              {icon:'⛓️',title:'Cryptographic Proof',sub:'Cryptographic ownership'},
              {icon:'📵',title:'Number Stays Private',sub:'VaultTag only'},
              {icon:'🌍',title:'Universal ID',sub:'Works everywhere'},
              {icon:'🛡️',title:'Sovereign Identity',sub:'You own your keys'},
            ].map((f,i)=>(
              <View key={i} style={S.featureCard}>
                <Text style={{fontSize:22,marginBottom:4}}>{f.icon}</Text>
                <Text numberOfLines={1} style={{color:'#fff',fontSize:11,fontWeight:'700',textAlign:'center'}}>{f.title}</Text>
                <Text style={{color:'#3D5A7A',fontSize:9,textAlign:'center',marginTop:2}}>{f.sub}</Text>
              </View>
            ))}
          </View>

          {/* Danger zone */}
          <TouchableOpacity onPress={handleDestroy} style={S.destroyBtn}>
            <Text style={{color:'#EF4444',fontSize:13,fontWeight:'700'}}>💀 Destroy VaultID</Text>
          </TouchableOpacity>

        </>) : (
          /* No VaultID yet */
          <View style={{alignItems:'center',paddingTop:40}}>
            <Text style={{fontSize:80,marginBottom:20}}>🧬</Text>
            <Text style={{color:'#fff',fontSize:22,fontWeight:'900',textAlign:'center'}}>No VaultID Yet</Text>
            <Text style={{color:'#3D5A7A',fontSize:14,textAlign:'center',marginTop:8,lineHeight:22,paddingHorizontal:20}}>Create your cryptographic identity. A handle people can add you by, without your number.</Text>
            <TouchableOpacity onPress={()=>setShowCreate(true)} style={{marginTop:24}}>
              <LinearGradient colors={['#1D4ED8','#7C3AED']} style={{borderRadius:16,paddingVertical:16,paddingHorizontal:40}}>
                <Text style={{color:'#fff',fontSize:16,fontWeight:'800'}}>🧬 Create VaultID</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
        )}

      </Animated.ScrollView>

      {/* Create Modal */}
      <Modal visible={showCreate} transparent animationType="slide">
        <KeyboardSafe keyboardOnly>
        <View style={{flex:1,backgroundColor:'rgba(0,0,0,0.92)',justifyContent:'flex-end'}}>
          <LinearGradient colors={['#F9FAFB','#0D1E3A']} style={{borderTopLeftRadius:28,borderTopRightRadius:28,padding:24,paddingBottom:44}}>
            <Text style={{color:'#fff',fontSize:22,fontWeight:'900',marginBottom:4}}>🧬 Create VaultID</Text>
            <Text style={{color:'#3D5A7A',fontSize:13,marginBottom:20}}>Your cryptographic identity — shareable without your number</Text>

            <Text style={{color:'#4A9FFF',fontSize:11,fontWeight:'700',marginBottom:8,letterSpacing:1}}>CHOOSE AVATAR</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{marginBottom:16}}>
              {AVATARS.map(a=>(
                <TouchableOpacity key={a} onPress={()=>setSelectedAvatar(a)}
                  style={{width:48,height:48,borderRadius:24,marginRight:8,justifyContent:'center',alignItems:'center',backgroundColor:selectedAvatar===a?'#1D4ED8':'#060E22',borderWidth:2,borderColor:selectedAvatar===a?'#3B82F6':'#0D1E3A'}}>
                  <Text style={{fontSize:24}}>{a}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <Text style={{color:'#4A9FFF',fontSize:11,fontWeight:'700',marginBottom:8,letterSpacing:1}}>DISPLAY NAME *</Text>
            <TextInput
              value={displayName} onChangeText={setDisplayName}
              placeholder="Enter your name..." placeholderTextColor="#1D2D44"
              style={{backgroundColor: c.bg,borderRadius:12,padding:14,color:'#fff',fontSize:15,borderWidth:1.5,borderColor:'#0D1E3A',marginBottom:14}}
            />

            <Text style={{color:'#4A9FFF',fontSize:11,fontWeight:'700',marginBottom:8,letterSpacing:1}}>BIO (OPTIONAL)</Text>
            <TextInput
              value={bio} onChangeText={setBio}
              placeholder="Short bio..." placeholderTextColor="#1D2D44"
              style={{backgroundColor: c.bg,borderRadius:12,padding:14,color:'#fff',fontSize:15,borderWidth:1.5,borderColor:'#0D1E3A',marginBottom:20}}
            />

            <TouchableOpacity disabled={creating||!displayName.trim()} style={{opacity:creating||!displayName.trim()?0.5:1}} onPress={handleCreate}>
              <LinearGradient colors={['#1D4ED8','#7C3AED']} style={{borderRadius:16,paddingVertical:16,alignItems:'center',marginBottom:12}}>
                <Text style={{color:'#fff',fontSize:15,fontWeight:'900'}}>{creating?'⛓️ Generating keys...':'🧬 Generate VaultID'}</Text>
              </LinearGradient>
            </TouchableOpacity>

            {!creating&&<TouchableOpacity onPress={()=>setShowCreate(false)} style={{alignItems:'center',paddingVertical:10}}>
              <Text style={{color:'#3D5A7A',fontSize:14}}>Cancel</Text>
            </TouchableOpacity>}
          </LinearGradient>
        </View>
        </KeyboardSafe>
      </Modal>

      {/* Details Modal */}
      <Modal visible={showDetails} transparent animationType="slide">
        <View style={{flex:1,backgroundColor:'rgba(0,0,0,0.92)',justifyContent:'flex-end'}}>
          <LinearGradient colors={['#F9FAFB','#0D1E3A']} style={{borderTopLeftRadius:28,borderTopRightRadius:28,padding:24,paddingBottom:44,maxHeight:'85%'}}>
            <ScrollView>
              <Text style={{color:'#fff',fontSize:20,fontWeight:'900',marginBottom:16}}>🔍 VaultID Details</Text>
              {vaultID&&[
                {label:'VaultTag',value:vaultID.vaultTag},
                {label:'Display Name',value:vaultID.displayName},
                {label:'Wallet Address',value:vaultID.walletAddress},
                {label:'Public Key',value:vaultID.publicKey.substring(0,40)+'...'},
                {label:'Private Key Hash',value:vaultID.privateKeyHash.substring(0,40)+'...'},
                {label:'Trust Score',value:vaultID.trustScore.toString()},
                {label:'Created',value:new Date(vaultID.createdAt).toLocaleString()},
                {label:'Verified',value:vaultID.isVerified?'Yes':'No'},
              ].map((item,i)=>(
                <View key={i} style={{marginBottom:14}}>
                  <Text style={{color:'#3D5A7A',fontSize:10,letterSpacing:1,marginBottom:4}}>{item.label.toUpperCase()}</Text>
                  <Text style={{color:'#fff',fontSize:13,fontFamily:'monospace',backgroundColor: c.bg,padding:10,borderRadius:8}}>{item.value}</Text>
                </View>
              ))}
              {signedMsg?<View style={{marginBottom:14}}>
                <Text style={{color:'#3D5A7A',fontSize:10,letterSpacing:1,marginBottom:4}}>LAST SIGNATURE</Text>
                <Text style={{color:BRAND_ACCENT,fontSize:12,fontFamily:'monospace',backgroundColor: c.bg,padding:10,borderRadius:8}}>{signedMsg}</Text>
              </View>:null}
              <TouchableOpacity onPress={()=>setShowDetails(false)} style={{alignItems:'center',paddingVertical:14,marginTop:8}}>
                <Text style={{color:'#4A9FFF',fontSize:14,fontWeight:'700'}}>Close</Text>
              </TouchableOpacity>
            </ScrollView>
          </LinearGradient>
        </View>
      </Modal>

      {/* Certificate Modal */}
      <Modal visible={showCert} transparent animationType="slide">
        <View style={{flex:1,backgroundColor:'rgba(0,0,0,0.92)',justifyContent:'flex-end'}}>
          <LinearGradient colors={['#F9FAFB','#0D1E3A']} style={{borderTopLeftRadius:28,borderTopRightRadius:28,padding:24,paddingBottom:44}}>
            <Text style={{color:'#fff',fontSize:20,fontWeight:'900',marginBottom:4}}>📜 Identity Certificate</Text>
            <Text style={{color:'#3D5A7A',fontSize:12,marginBottom:16}}>Cryptographic proof of your VaultID ownership</Text>
            <ScrollView style={{backgroundColor: c.bg,borderRadius:12,padding:14,maxHeight:200,marginBottom:16}}>
              <Text style={{color:BRAND_ACCENT,fontSize:10,fontFamily:'monospace',lineHeight:16}}>{certificate}</Text>
            </ScrollView>
            <TouchableOpacity onPress={async()=>{ await Share.share({message:'My crazzychat Identity Certificate:\n\n'+certificate}); }}>
              <LinearGradient colors={['#1D4ED8','#7C3AED']} style={{borderRadius:14,paddingVertical:14,alignItems:'center',marginBottom:12}}>
                <Text style={{color:'#fff',fontSize:14,fontWeight:'800'}}>📤 Share Certificate</Text>
              </LinearGradient>
            </TouchableOpacity>
            <TouchableOpacity onPress={()=>setShowCert(false)} style={{alignItems:'center',paddingVertical:10}}>
              <Text style={{color:'#3D5A7A',fontSize:14}}>Close</Text>
            </TouchableOpacity>
          </LinearGradient>
        </View>
      </Modal>

    </LinearGradient>
  );
}

// Width is threaded in rather than read from a module-level Dimensions.get():
// orientation is 'default', so a frozen value survived rotation and left
// featureCard sized for the previous geometry.
const makeS = (c: Palette, width: number) => StyleSheet.create({
  container: {paddingHorizontal:20,paddingTop:HEADER_TOP,paddingBottom:40},
  header: {flexDirection:'row',alignItems:'center',marginBottom:20,gap:12},
  backBtn: {width:36,height:36,borderRadius:18,backgroundColor: c.glassSoft,justifyContent:'center',alignItems:'center',borderWidth:1,borderColor:'#0D1E3A'},
  headerTitle: {color:'#fff',fontSize:20,fontWeight:'900'},
  shareBtn: {backgroundColor:'#0D1E3A',borderRadius:10,paddingHorizontal:14,paddingVertical:7,borderWidth:1,borderColor:'#1D4ED8'},
  idCard:{borderRadius:24,marginBottom:16,elevation:20,shadowColor:'#7C3AED',shadowOffset: {width:0,height:0},shadowOpacity:0.8,shadowRadius:20},
  idCardInner: {borderRadius:24,padding:24,alignItems:'center',borderWidth:1,borderColor:'#0D1E3A',overflow:'hidden'},
  chainRing: {position:'absolute',width:280,height:280,borderRadius:140,borderWidth:1,borderColor:'rgba(124,58,237,0.2)',borderStyle:'dashed'},
  avatarContainer: {marginBottom:12,position:'relative'},
  avatarGrad: {width:90,height:90,borderRadius:45,justifyContent:'center',alignItems:'center'},
  verifiedBadge: {position:'absolute',bottom:0,right:0,backgroundColor: c.bg,borderRadius:12,padding:2},
  displayName: {color:'#fff',fontSize:22,fontWeight:'900',marginBottom:8},
  vaultTagRow: {marginBottom:10},
  vaultTagBadge: {borderRadius:20,paddingHorizontal:16,paddingVertical:6},
  vaultTagText: {color:'#fff',fontSize:13,fontWeight:'800',letterSpacing:1},
  bioText: {color:'#3D5A7A',fontSize:13,textAlign:'center',marginBottom:10,paddingHorizontal:20},
  walletRow: {flexDirection:'row',alignItems:'center',gap:8,marginBottom:14,backgroundColor: c.bg,borderRadius:10,paddingHorizontal:14,paddingVertical:8},
  walletAddr: {color:'#4A9FFF',fontSize:12,fontFamily:'monospace',fontWeight:'700',flex:1},
  blockchainDot: {width:8,height:8,borderRadius:4,backgroundColor:BRAND_ACCENT},
  trustRow: {width:'100%',gap:6,marginBottom:12},
  trustBar: {height:6,backgroundColor: c.glassSoft,borderRadius:3,flex:1,overflow:'hidden'},
  trustFill: {height:6,borderRadius:3},
  trustScore: {fontSize:14,fontWeight:'900'},
  chainBlocks: {flexDirection:'row',gap:4,marginBottom:8},
  nophone: {backgroundColor: c.bg,borderRadius:8,paddingHorizontal:12,paddingVertical:4,borderWidth:1,borderColor:'#166534'},
  statsRow: {flexDirection:'row',gap:10,marginBottom:16},
  statCard: {flex:1,backgroundColor: c.glassSoft,borderRadius:14,padding:12,alignItems:'center',borderWidth:1,borderColor:'#0D1E3A'},
  statValue: {color:'#fff',fontSize:13,fontWeight:'800',marginBottom:2},
  statLabel: {color:'#3D5A7A',fontSize:9,letterSpacing:1},
  actions: {flexDirection:'row',gap:10,marginBottom:16},
  actionBtn: {flex:1},
  actionGrad: {borderRadius:16,padding:14,alignItems:'center'},
  actionText: {color:'#fff',fontSize:11,fontWeight:'800',marginTop:4},
  actionSub: {color:'rgba(255,255,255,0.5)',fontSize:9,marginTop:2},
  trustActions: {backgroundColor: c.glassSoft,borderRadius:16,padding:16,marginBottom:16,borderWidth:1,borderColor:'#0D1E3A'},
  featuresGrid: {flexDirection:'row',flexWrap:'wrap',gap:10,marginBottom:16},
  featureCard: {width:(width-50)/3,backgroundColor: c.glassSoft,borderRadius:14,padding:12,alignItems:'center',borderWidth:1,borderColor:'#0D1E3A'},
  destroyBtn: {backgroundColor:'rgba(239,68,68,0.16)',borderRadius:14,padding:16,alignItems:'center',borderWidth:1,borderColor:'rgba(239,68,68,0.18)',marginBottom:20},
});

export default function VaultIDScreen() {
  return (
    <ErrorBoundary fallbackTitle="VaultID Error" fallbackMessage="VaultID had a problem. Your identity is secure.">
      <VaultIDScreenContent />
    </ErrorBoundary>
  );
}
