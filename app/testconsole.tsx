import React, { useState, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Animated } from 'react-native';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';

export default function TestConsole() {
  const router = useRouter();
  const [running,    setRunning]    = useState(false);
  const [progress,   setProgress]   = useState(0);
  const [logLines,   setLogLines]   = useState<string[]>([]);
  const [result,     setResult]     = useState<TestResult | null>(null);
  const [userCount,  setUserCount]  = useState('5');
  const [msgsPerUser,setMsgsPerUser]= useState('10');
  const [interval,   setInterval2]  = useState('500');
  const [testType,   setTestType]   = useState<TestConfig['testType']>('round_robin');
  const [serverUrl,  setServerUrl]  = useState('http://10.94.177.151:3001');
  const progAnim = useRef(new Animated.Value(0)).current;
  const scrollRef = useRef<ScrollView>(null);

  const addLog = (msg: string) => {
    const ts  = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    setLogLines(prev => [`[${ts}] ${msg}`, ...prev.slice(0, 99)]);
  };

  const handleProgress = (pct: number, log: string) => {
    setProgress(pct);
    Animated.timing(progAnim, { toValue: pct / 100, duration: 300, useNativeDriver: false }).start();
    addLog(log);
  };

  const startTest = async () => {
    setRunning(true); setResult(null); setLogLines([]);
    setProgress(0);
    addLog('Starting parallel multi-user test...');
    try {
      const config: TestConfig = {
        userCount:       Math.min(parseInt(userCount)  || 5, 10),
        messagesPerUser: Math.min(parseInt(msgsPerUser)|| 10, 50),
        intervalMs:      Math.max(parseInt(interval)   || 500, 100),
        testType, serverUrl,
      };
      const res = await runParallelTest(config, handleProgress);
      setResult(res);
      addLog(`✓ Done — ${res.totalSent} sent, ${res.deliveryRate}% delivered, avg ${res.avgLatencyMs}ms`);
    } catch (e: any) {
      addLog(`✗ Test failed: ${e.message}`);
    } finally {
      setRunning(false);
    }
  };

  const progWidth = progAnim.interpolate({ inputRange:[0,1], outputRange:['0%','100%'] });

  const TEST_TYPES: TestConfig['testType'][] = ['round_robin','random','broadcast','stress'];

  return (
    <View style={{flex:1,backgroundColor:C.bg}}>
      <LinearGradient colors={['#010812','#020B18','#030E1E']} style={StyleSheet.absoluteFillObject}/>

      {/* Header */}
      <View style={Ss.header}>
        <TouchableOpacity onPress={()=>router.back()} style={Ss.backBtn}>
          <Text style={{color:C.primary,fontSize:18}}>←</Text>
        </TouchableOpacity>
        <View style={{flex:1}}>
          <Text style={Ss.title}>Test Console</Text>
          <Text style={Ss.sub}>MULTI-USER PARALLEL TESTING</Text>
        </View>
        <View style={[Ss.badge, running && {borderColor:'rgba(16,185,129,0.5)',backgroundColor:'rgba(16,185,129,0.1)'}]}>
          <Text style={{color: running ? C.accent : C.dim, fontSize:9, fontWeight:'900'}}>
            {running ? '🟢 RUNNING' : '⚫ IDLE'}
          </Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{padding:18,gap:14,paddingBottom:60}} showsVerticalScrollIndicator={false}>

        {/* Config */}
        <View style={Ss.card}>
          <Text style={Ss.cardTitle}>⚙️ Test Configuration</Text>
          <View style={{gap:12}}>
            <View style={{flexDirection:'row',gap:10}}>
              <View style={{flex:1}}>
                <Text style={Ss.label}>USERS</Text>
                <TextInput style={Ss.inp} value={userCount} onChangeText={setUserCount}
                  keyboardType="number-pad" editable={!running}/>
              </View>
              <View style={{flex:1}}>
                <Text style={Ss.label}>MSGS / USER</Text>
                <TextInput style={Ss.inp} value={msgsPerUser} onChangeText={setMsgsPerUser}
                  keyboardType="number-pad" editable={!running}/>
              </View>
              <View style={{flex:1}}>
                <Text style={Ss.label}>INTERVAL ms</Text>
                <TextInput style={Ss.inp} value={interval} onChangeText={setInterval2}
                  keyboardType="number-pad" editable={!running}/>
              </View>
            </View>

            <View>
              <Text style={Ss.label}>SERVER URL</Text>
              <TextInput style={Ss.inp} value={serverUrl} onChangeText={setServerUrl}
                autoCapitalize="none" editable={!running}/>
            </View>

            <View>
              <Text style={Ss.label}>TEST TYPE</Text>
              <View style={{flexDirection:'row',gap:6,flexWrap:'wrap'}}>
                {TEST_TYPES.map(t => (
                  <TouchableOpacity key={t} onPress={()=>!running && setTestType(t)}
                    style={[Ss.typePill, testType===t && Ss.typePillActive]}>
                    <Text style={{color:testType===t?'#fff':C.dim,fontSize:10,fontWeight:'800'}}>
                      {t.replace('_',' ').toUpperCase()}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </View>
        </View>

        {/* Run button */}
        <TouchableOpacity onPress={startTest} disabled={running} style={{opacity:running?0.6:1}}>
          <LinearGradient
            colors={running ? ['#1a2a4a','#2a1a4a'] : ['#1D4ED8','#7C3AED']}
            style={Ss.runBtn}>
            <Text style={{color:'#fff',fontSize:15,fontWeight:'900'}}>
              {running ? '⏳ Test Running...' : '▶ Start Parallel Test'}
            </Text>
          </LinearGradient>
        </TouchableOpacity>

        {/* Progress */}
        {(running || progress > 0) && (
          <View style={Ss.card}>
            <View style={{flexDirection:'row',justifyContent:'space-between',marginBottom:8}}>
              <Text style={{color:'#fff',fontSize:12,fontWeight:'800'}}>Progress</Text>
              <Text style={{color:C.primary,fontSize:12,fontWeight:'900',fontFamily:'monospace'}}>{progress}%</Text>
            </View>
            <View style={{height:5,backgroundColor:'rgba(255,255,255,0.06)',borderRadius:3,overflow:'hidden'}}>
              <Animated.View style={{height:5,width:progWidth,
                backgroundColor:progress===100?C.accent:C.primary,borderRadius:3}}/>
            </View>
          </View>
        )}

        {/* Results */}
        {result && (
          <View style={Ss.card}>
            <Text style={Ss.cardTitle}>📊 Test Results</Text>
            <View style={{gap:8}}>
              {[
                { label:'Total Sent',      val:result.totalSent+'',      color:C.primary },
                { label:'Total Received',  val:result.totalReceived+'',  color:C.accent  },
                { label:'Delivery Rate',   val:result.deliveryRate+'%',  color:result.deliveryRate>90?C.accent:C.yellow },
                { label:'Avg Latency',     val:result.avgLatencyMs+'ms', color:C.primary },
                { label:'Max Latency',     val:result.maxLatencyMs+'ms', color:result.maxLatencyMs>500?C.yellow:C.accent },
                { label:'Total Errors',    val:result.totalErrors+'',    color:result.totalErrors?C.red:C.accent },
                { label:'Duration',        val:Math.round(result.duration/1000)+'s', color:C.dim },
              ].map((row,i) => (
                <View key={i} style={{flexDirection:'row',justifyContent:'space-between',
                  paddingVertical:7,borderTopWidth:i?1:0,borderTopColor:'rgba(255,255,255,0.05)'}}>
                  <Text style={{color:C.dim,fontSize:12}}>{row.label}</Text>
                  <Text style={{color:row.color,fontSize:13,fontWeight:'900',fontFamily:'monospace'}}>{row.val}</Text>
                </View>
              ))}
            </View>

            {/* Per-user breakdown */}
            <Text style={[Ss.cardTitle,{marginTop:14,marginBottom:8}]}>👥 Per-User Breakdown</Text>
            {result.users.map((u,i) => (
              <View key={i} style={{backgroundColor:'rgba(8,20,42,0.8)',borderRadius:10,
                padding:10,marginBottom:6,borderWidth:1,borderColor:'rgba(255,255,255,0.05)'}}>
                <View style={{flexDirection:'row',justifyContent:'space-between'}}>
                  <Text style={{color:'#fff',fontSize:12,fontWeight:'800'}}>{u.name}</Text>
                  <Text style={{color:u.errors.length?C.red:C.accent,fontSize:10,fontWeight:'800'}}>
                    {u.errors.length ? u.errors.length+' errors' : '✓ Clean'}
                  </Text>
                </View>
                <View style={{flexDirection:'row',gap:16,marginTop:4}}>
                  <Text style={{color:C.dim,fontSize:10}}>📤 Sent: <Text style={{color:C.primary,fontWeight:'800'}}>{u.msgSent}</Text></Text>
                  <Text style={{color:C.dim,fontSize:10}}>📥 Received: <Text style={{color:C.accent,fontWeight:'800'}}>{u.msgReceived}</Text></Text>
                  <Text style={{color:C.dim,fontSize:10}}>⚡ Avg: <Text style={{color:C.yellow,fontWeight:'800'}}>{u.latencies.length?Math.round(u.latencies.reduce((a,b)=>a+b,0)/u.latencies.length):0}ms</Text></Text>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* Live log */}
        <View style={Ss.card}>
          <Text style={Ss.cardTitle}>📟 Live Log</Text>
          <View style={{backgroundColor:'rgba(2,8,18,0.9)',borderRadius:10,padding:10,minHeight:120,maxHeight:220}}>
            <ScrollView ref={scrollRef} showsVerticalScrollIndicator={false}>
              {logLines.length === 0
                ? <Text style={{color:C.faint,fontSize:11,fontFamily:'monospace'}}>Logs will appear here...</Text>
                : logLines.map((l,i) => (
                    <Text key={i} style={{color:i===0?'#fff':C.dim,fontSize:10,fontFamily:'monospace',marginBottom:2}}>{l}</Text>
                  ))
              }
            </ScrollView>
          </View>
        </View>

      </ScrollView>
    </View>
  );
}

const Ss = StyleSheet.create({
  header:       { paddingTop:52,paddingBottom:14,paddingHorizontal:18,flexDirection:'row',alignItems:'center',gap:12,borderBottomWidth:1,borderBottomColor:'rgba(74,159,255,0.1)' },
  backBtn:      { width:36,height:36,borderRadius:18,backgroundColor:'rgba(10,22,40,0.8)',justifyContent:'center',alignItems:'center' },
  title:        { color:'#fff',fontSize:19,fontWeight:'900' },
  sub:          { color:'rgba(255,255,255,0.35)',fontSize:9,fontWeight:'800',letterSpacing:1.5,marginTop:2 },
  badge:        { backgroundColor:'rgba(10,22,40,0.8)',borderRadius:10,paddingHorizontal:10,paddingVertical:6,borderWidth:1,borderColor:'rgba(255,255,255,0.1)' },
  card:         { backgroundColor:'rgba(10,22,40,0.88)',borderRadius:18,padding:16,borderWidth:1,borderColor:'rgba(74,159,255,0.12)' },
  cardTitle:    { color:'#fff',fontSize:13,fontWeight:'900',marginBottom:12 },
  label:        { color:'rgba(255,255,255,0.4)',fontSize:8,fontWeight:'800',letterSpacing:1.5,fontFamily:'monospace',marginBottom:5 },
  inp:          { backgroundColor:'rgba(6,14,34,0.9)',borderRadius:10,paddingHorizontal:12,paddingVertical:10,color:'#fff',fontSize:13,fontWeight:'700',borderWidth:1.5,borderColor:'rgba(74,159,255,0.2)' },
  typePill:     { paddingHorizontal:10,paddingVertical:6,borderRadius:8,backgroundColor:'rgba(10,22,40,0.8)',borderWidth:1,borderColor:'rgba(255,255,255,0.08)' },
  typePillActive:{ backgroundColor:'rgba(74,159,255,0.2)',borderColor:'rgba(74,159,255,0.5)' },
  runBtn:       { borderRadius:16,paddingVertical:16,alignItems:'center' },
});

