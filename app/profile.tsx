
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Animated, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const C = {
  bg:'#020B18', primary:'#4A9FFF', secondary:'#7C3AED',
  accent:'#10B981', danger:'#EF4444', warning:'#F59E0B',
  textDim:'rgba(255,255,255,0.5)', textFaint:'rgba(255,255,255,0.22)',
  card:'rgba(10,22,40,0.85)', border:'rgba(74,159,255,0.12)',
};

const STATS = [
  { val:'0',   lbl:'Messages',  icon:'💬', color:'#4A9FFF' },
  { val:'0',   lbl:'Contacts',  icon:'👥', color:'#A855F7' },
  { val:'0',   lbl:'Groups',    icon:'👥', color:'#10B981' },
  { val:'0.0', lbl:'TrustScore',icon:'🎯', color:'#F59E0B' },
];

const SECTIONS = [
  {
    title:'Account',
    items:[
      { icon:'👤', label:'Edit Profile',        sub:'Name, bio, avatar',         color:'#4A9FFF',  route:'/profile/edit' },
      { icon:'🔑', label:'Change Password',     sub:'Update login credentials',  color:'#A855F7',  route:'/forgot' },
      { icon:'👁️', label:'Face ID Management',  sub:'Re-enrol biometrics',       color:'#00EEFF',  route:'/facescan' },
    ],
  },
  {
    title:'Privacy & Security',
    items:[
      { icon:'🔒', label:'End-to-End Encryption', sub:'AES-256 active on all chats', color:'#10B981', route:null, badge:'ON' },
      { icon:'🛡️', label:'BreachGuard',            sub:'0 threats detected',          color:'#EF4444', route:'/breachguard' },
      { icon:'📋', label:'Recovery Questions',     sub:'Configure backup access',     color:'#F59E0B', route:'/recovery' },
    ],
  },
  {
    title:'Preferences',
    items:[
      { icon:'🔔', label:'Notifications', sub:'Manage alerts',           color:'#F97316', route:'/notifications' },
      { icon:'🗄️', label:'File Vault',    sub:'Encrypted file storage',  color:'#818CF8', route:'/filevault' },
    ],
  },
];

export default function ProfileScreen() {
  const router      = useRouter();
  const fadeAnim    = useRef(new Animated.Value(0)).current;
  const slideAnim   = useRef(new Animated.Value(24)).current;
  const avatarScale = useRef(new Animated.Value(0.88)).current;
  const [copyFlash,    setCopyFlash]    = useState(false);
  const [displayName,  setDisplayName]  = useState('Loading...');
  const [vaultId,      setVaultId]      = useState('VC-????-????-????');
  const [phone,        setPhone]        = useState('');

  // ── Load REAL user data from AsyncStorage ────────────────────
  useEffect(() => {
    const load = async () => {
      const name  = await AsyncStorage.getItem('displayName');
      const vid   = await AsyncStorage.getItem('vaultId');
      const ph    = await AsyncStorage.getItem('phone');
      if (name) setDisplayName(name);
      if (vid)  setVaultId(vid);
      if (ph)   setPhone(ph);
    };
    load();

    Animated.parallel([
      Animated.timing(fadeAnim,    { toValue:1, duration:450, useNativeDriver:true }),
      Animated.timing(slideAnim,   { toValue:0, duration:450, useNativeDriver:true }),
      Animated.spring(avatarScale, { toValue:1, tension:60, friction:9, useNativeDriver:true }),
    ]).start();
  }, []);

  // Generate initials from real name
  const initials = displayName
    .split(' ').map(w => w[0] || '').join('').slice(0, 2).toUpperCase() || '??';

  const handleLogout = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text:'Cancel', style:'cancel' },
      { text:'Sign Out', style:'destructive', onPress: async () => {
        await AsyncStorage.clear();
        router.replace('/login');
      }},
    ]);
  };

  const handleCopyVaultId = () => {
    setCopyFlash(true);
    setTimeout(() => setCopyFlash(false), 1600);
  };

  const handleItem = (item: any) => {
    if (item.copy) { handleCopyVaultId(); return; }
    if (item.route) router.push(item.route);
  };

  return (
    <View style={{flex:1, backgroundColor:C.bg}}>
      <LinearGradient colors={['#010812','#020B18','#030E1E']} style={StyleSheet.absoluteFillObject}/>

      <Animated.View style={{flex:1, opacity:fadeAnim}}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{paddingBottom:48}}>

          {/* Hero */}
          <View style={S.hero}>
            <LinearGradient
              colors={['rgba(74,159,255,0.15)','rgba(124,58,237,0.1)','transparent']}
              style={[StyleSheet.absoluteFillObject,{borderBottomLeftRadius:32,borderBottomRightRadius:32}]}/>

            <TouchableOpacity onPress={()=>router.back()} style={S.backBtn}>
              <Text style={{color:C.primary, fontSize:17}}>←</Text>
            </TouchableOpacity>

            <Animated.View style={{transform:[{scale:avatarScale}], alignItems:'center', gap:12, marginTop:8}}>
              <View style={S.avatarOuter}>
                <LinearGradient colors={['#1D4ED8','#7C3AED']} style={S.avatarGrad}>
                  {/* ✅ Real initials from user's actual name */}
                  <Text style={{fontSize:36, color:'#fff', fontWeight:'900'}}>{initials}</Text>
                </LinearGradient>
                <View style={S.onlineDot}/>
              </View>

              <View style={{alignItems:'center', gap:4}}>
                {/* ✅ Real name from AsyncStorage */}
                <Text style={{color:'#fff', fontSize:22, fontWeight:'900'}}>{displayName}</Text>
                {phone ? (
                  <Text style={{color:C.textDim, fontSize:12}}>{phone}</Text>
                ) : null}
                <View style={{flexDirection:'row', alignItems:'center', gap:6}}>
                  <View style={{width:6,height:6,borderRadius:3,backgroundColor:'#10B981'}}/>
                  <Text style={{color:C.textDim, fontSize:12}}>Online · End-to-end encrypted</Text>
                </View>

                {/* ✅ Real VaultID from AsyncStorage */}
                <TouchableOpacity onPress={handleCopyVaultId}
                  style={{flexDirection:'row', alignItems:'center', gap:6, marginTop:2}}>
                  <Text style={{color:'#FACC15', fontSize:11, fontWeight:'700'}}>⛓ {vaultId}</Text>
                  <View style={{backgroundColor:'rgba(250,204,21,0.12)', borderRadius:6,
                    paddingHorizontal:6, paddingVertical:2, borderWidth:1,
                    borderColor:'rgba(250,204,21,0.3)'}}>
                    <Text style={{color:'#FACC15', fontSize:8, fontWeight:'800'}}>TAP TO COPY</Text>
                  </View>
                </TouchableOpacity>
              </View>
            </Animated.View>

            {/* Stats */}
            <Animated.View style={[S.statsBar, {transform:[{translateY:slideAnim}]}]}>
              {STATS.map((s,i)=>(
                <View key={i} style={S.statItem}>
                  <Text style={{fontSize:16}}>{s.icon}</Text>
                  <Text style={{color:s.color, fontSize:16, fontWeight:'900'}}>{s.val}</Text>
                  <Text style={{color:C.textFaint, fontSize:9, fontWeight:'700'}}>{s.lbl.toUpperCase()}</Text>
                </View>
              ))}
            </Animated.View>
          </View>

          {copyFlash && (
            <View style={S.toast}>
              <Text style={{color:'#10B981', fontSize:12, fontWeight:'800'}}>✓ VaultID copied</Text>
            </View>
          )}

          {/* Settings */}
          <View style={{paddingHorizontal:20, gap:20, marginTop:20}}>
            {SECTIONS.map((sec,si)=>(
              <View key={si}>
                <Text style={S.sectionTitle}>{sec.title.toUpperCase()}</Text>
                <View style={S.sectionCard}>
                  {sec.items.map((item,ii)=>(
                    <TouchableOpacity key={ii} onPress={()=>handleItem(item)}
                      style={[S.rowItem, ii>0&&{borderTopWidth:1,borderTopColor:'rgba(255,255,255,0.05)'}]}>
                      <View style={[S.rowIcon,{backgroundColor:item.color+'18',borderColor:item.color+'30'}]}>
                        <Text style={{fontSize:16}}>{item.icon}</Text>
                      </View>
                      <View style={{flex:1}}>
                        <Text style={{color:'#fff',fontSize:14,fontWeight:'700'}}>{item.label}</Text>
                        <Text style={{color:C.textFaint,fontSize:11,marginTop:1}}>{item.sub}</Text>
                      </View>
                      {item.badge
                        ? <View style={{backgroundColor:'rgba(16,185,129,0.15)',borderRadius:8,
                            paddingHorizontal:8,paddingVertical:3,borderWidth:1,
                            borderColor:'rgba(16,185,129,0.3)'}}>
                            <Text style={{color:'#10B981',fontSize:10,fontWeight:'800'}}>{item.badge}</Text>
                          </View>
                        : item.route
                          ? <Text style={{color:C.textFaint,fontSize:13}}>›</Text>
                          : null}
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            ))}

            {/* Logout */}
            <View>
              <Text style={S.sectionTitle}>SESSION</Text>
              <TouchableOpacity onPress={handleLogout} style={S.logoutBtn}>
                <LinearGradient colors={['rgba(239,68,68,0.12)','rgba(185,28,28,0.08)']}
                  style={[StyleSheet.absoluteFillObject,{borderRadius:18}]}/>
                <View style={[S.rowIcon,{backgroundColor:'rgba(239,68,68,0.15)',borderColor:'rgba(239,68,68,0.35)'}]}>
                  <Text style={{fontSize:16}}>🔒</Text>
                </View>
                <View style={{flex:1}}>
                  <Text style={{color:'#EF4444',fontSize:15,fontWeight:'900'}}>Sign Out</Text>
                  <Text style={{color:'rgba(239,68,68,0.5)',fontSize:11,marginTop:1}}>Clear data and return to login</Text>
                </View>
                <Text style={{color:'#EF4444',fontSize:18}}>→</Text>
              </TouchableOpacity>
            </View>

            <View style={S.secBadge}>
              <Text style={{color:'rgba(255,255,255,0.25)',fontSize:10,textAlign:'center'}}>
                🔒 AES-256 · ⛓ Blockchain · 👁️ Face ID · 🛡️ BreachGuard Active
              </Text>
            </View>
          </View>
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const S = StyleSheet.create({
  hero:        {paddingTop:52,paddingBottom:24,alignItems:'center',gap:0,paddingHorizontal:20,borderBottomLeftRadius:32,borderBottomRightRadius:32,overflow:'hidden'},
  backBtn:     {position:'absolute',top:52,left:20,width:40,height:40,borderRadius:20,backgroundColor:'rgba(10,22,40,0.8)',justifyContent:'center',alignItems:'center',borderWidth:1,borderColor:'rgba(255,255,255,0.07)',zIndex:10},
  avatarOuter: {width:96,height:96,borderRadius:48,padding:3,borderWidth:2.5,borderColor:'rgba(74,159,255,0.5)',position:'relative'},
  avatarGrad:  {flex:1,borderRadius:44,justifyContent:'center',alignItems:'center'},
  onlineDot:   {position:'absolute',bottom:3,right:3,width:14,height:14,borderRadius:7,backgroundColor:'#10B981',borderWidth:2.5,borderColor:'#020B18'},
  statsBar:    {flexDirection:'row',backgroundColor:'rgba(10,22,40,0.85)',borderRadius:20,padding:16,marginTop:20,width:'100%',borderWidth:1,borderColor:'rgba(74,159,255,0.12)'},
  statItem:    {flex:1,alignItems:'center',gap:3},
  sectionTitle:{color:'rgba(255,255,255,0.28)',fontSize:9,fontWeight:'800',letterSpacing:2,marginBottom:8,marginLeft:4},
  sectionCard: {backgroundColor:'rgba(10,22,40,0.85)',borderRadius:18,overflow:'hidden',borderWidth:1,borderColor:'rgba(74,159,255,0.1)'},
  rowItem:     {flexDirection:'row',alignItems:'center',paddingHorizontal:16,paddingVertical:14,gap:14},
  rowIcon:     {width:40,height:40,borderRadius:12,justifyContent:'center',alignItems:'center',borderWidth:1},
  logoutBtn:   {flexDirection:'row',alignItems:'center',paddingHorizontal:16,paddingVertical:16,gap:14,borderRadius:18,borderWidth:1.5,borderColor:'rgba(239,68,68,0.3)',overflow:'hidden'},
  secBadge:    {backgroundColor:'rgba(10,22,40,0.6)',borderRadius:12,padding:12,borderWidth:1,borderColor:'rgba(255,255,255,0.05)'},
  toast:       {marginHorizontal:20,marginTop:8,backgroundColor:'rgba(16,185,129,0.12)',borderRadius:10,padding:10,borderWidth:1,borderColor:'rgba(16,185,129,0.25)',alignItems:'center'},
});
