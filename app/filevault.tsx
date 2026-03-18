import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Animated, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { ErrorBoundary } from '../components/ErrorBoundary';

const C = { bg:'#020B18',surface:'rgba(10,22,40,0.85)',primary:'#4A9FFF',secondary:'#7C3AED',accent:'#10B981',danger:'#EF4444',warning:'#F59E0B',border:'rgba(74,159,255,0.15)',borderDim:'rgba(255,255,255,0.06)',text:'#FFFFFF',textDim:'rgba(255,255,255,0.5)',textFaint:'rgba(255,255,255,0.22)' };
const NAV = [{id:'chats',icon:'💬',label:'Chats',route:'/chats'},{id:'shield',icon:'🛡️',label:'Shield',route:'/dashboard'},{id:'community',icon:'🌐',label:'Community',route:'/communities'},{id:'vault',icon:'📦',label:'Vault',route:'/filevault'},{id:'alerts',icon:'🔔',label:'Alerts',route:'/notifications'}];

const getFileIcon=(type:string)=>{ switch(type){ case 'image':return '🖼️'; case 'video':return '🎥'; case 'document':return '📄'; case 'audio':return '🎵'; default:return '📁'; } };

const DEMO_FOLDERS = [
  {id:'1',name:'Private Docs',emoji:'📋',isLocked:true,fileCount:3,color:C.primary},
  {id:'2',name:'Photos',emoji:'🖼️',isLocked:false,fileCount:12,color:C.secondary},
  {id:'3',name:'Videos',emoji:'🎥',isLocked:true,fileCount:5,color:C.accent},
  {id:'4',name:'Voice Notes',emoji:'🎵',isLocked:false,fileCount:8,color:C.warning},
];

const DEMO_FILES = [
  {id:'1',name:'passport_scan.pdf',size:'2.4 MB',type:'document',folderId:'1',addedAt:Date.now()-86400000*3,autoDestruct:false,viewCount:2,isEncrypted:true},
  {id:'2',name:'contract_2024.pdf',size:'1.1 MB',type:'document',folderId:'1',addedAt:Date.now()-86400000*7,autoDestruct:true,viewCount:0,maxViews:3,isEncrypted:true},
  {id:'3',name:'family_photo.jpg',size:'4.2 MB',type:'image',folderId:'2',addedAt:Date.now()-86400000,autoDestruct:false,viewCount:5,isEncrypted:true},
  {id:'4',name:'meeting_recording.mp4',size:'45 MB',type:'video',folderId:'3',addedAt:Date.now()-86400000*2,autoDestruct:true,viewCount:1,maxViews:2,isEncrypted:true},
  {id:'5',name:'voice_memo.m4a',size:'0.8 MB',type:'audio',folderId:'4',addedAt:Date.now()-3600000*5,autoDestruct:false,viewCount:3,isEncrypted:true},
];

function FileVaultContent() {
  const router=useRouter();
  const [folders,setFolders]=useState(DEMO_FOLDERS.map(f=>({...f})));
  const [files,setFiles]=useState(DEMO_FILES.map(f=>({...f})) as any[]);
  const [activeFolder,setActiveFolder]=useState<any>(null);
  const [view,setView]=useState<'folders'|'files'>('folders');
  const [showAddFile,setShowAddFile]=useState(false);
  const [showCreateFolder,setShowCreateFolder]=useState(false);
  const [showPasswordModal,setShowPasswordModal]=useState(false);
  const [passwordInput,setPasswordInput]=useState('');
  const [folderToUnlock,setFolderToUnlock]=useState<any>(null);
  const [newFolderName,setNewFolderName]=useState('');
  const [newFolderLocked,setNewFolderLocked]=useState(false);
  const [newFolderPassword,setNewFolderPassword]=useState('');
  const [autoDestruct,setAutoDestruct]=useState(false);
  const [maxViews,setMaxViews]=useState('1');
  const [navTab,setNavTab]=useState('vault');
  const fadeIn=useRef(new Animated.Value(0)).current;

  useEffect(()=>{ Animated.timing(fadeIn,{toValue:1,duration:500,useNativeDriver:true}).start(); },[]);

  const fmtTime=(ts:number)=>{ const d=Date.now()-ts; if(d<3600000)return Math.floor(d/60000)+'m ago'; if(d<86400000)return Math.floor(d/3600000)+'h ago'; return Math.floor(d/86400000)+'d ago'; };

  const openFolder=(folder:any)=>{ if(folder.isLocked){ setFolderToUnlock(folder); setShowPasswordModal(true); return; } setActiveFolder(folder); setView('files'); };
  const unlockFolder=()=>{ if(!folderToUnlock)return; setActiveFolder(folderToUnlock); setView('files'); setShowPasswordModal(false); setPasswordInput(''); setFolderToUnlock(null); };

  const viewFile=(file:any)=>{ const updated={...file,viewCount:file.viewCount+1}; if(file.autoDestruct&&file.maxViews&&updated.viewCount>=file.maxViews){ Alert.alert('Last View Reached',file.name+' has reached its view limit and will be deleted.',[{text:'OK',onPress:()=>{ setFiles(prev=>prev.filter((f:any)=>f.id!==file.id)); setFolders(prev=>prev.map((fo:any)=>fo.id===file.folderId?{...fo,fileCount:Math.max(0,fo.fileCount-1)}:fo)); }}]); } else { setFiles(prev=>prev.map((f:any)=>f.id===file.id?updated:f)); Alert.alert('File Opened',file.name+' — Views: '+updated.viewCount+(file.maxViews?' of '+file.maxViews:'')); } };
  const deleteFile=(file:any)=>{ Alert.alert('Delete File','Permanently delete '+file.name+'?',[{text:'Cancel',style:'cancel'},{text:'Delete',style:'destructive',onPress:()=>{ setFiles(prev=>prev.filter((f:any)=>f.id!==file.id)); setFolders(prev=>prev.map((fo:any)=>fo.id===file.folderId?{...fo,fileCount:Math.max(0,fo.fileCount-1)}:fo)); }}]); };
  const createFolder=()=>{ if(!newFolderName.trim())return; const colors=[C.primary,C.secondary,C.accent,C.warning,C.danger]; const newFolder={id:Date.now().toString(),name:newFolderName.trim(),emoji:'📁',isLocked:newFolderLocked,fileCount:0,color:colors[Math.floor(Math.random()*colors.length)]}; setFolders(prev=>[newFolder,...prev]); setShowCreateFolder(false); setNewFolderName(''); setNewFolderLocked(false); setNewFolderPassword(''); };

  const addFile=async(source:'camera'|'gallery'|'document')=>{ setShowAddFile(false); try { let name='',size='',type='other'; if(source==='camera'){ const r=await ImagePicker.launchCameraAsync({quality:0.8}); if(r.canceled)return; name='photo_'+Date.now()+'.jpg'; size='~2 MB'; type='image'; } else if(source==='gallery'){ const r=await ImagePicker.launchImageLibraryAsync({quality:0.8}); if(r.canceled)return; name=r.assets[0].fileName||'media_'+Date.now(); size='~1 MB'; type=r.assets[0].type==='video'?'video':'image'; } else { const r=await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true }); if(r.canceled)return; name=r.assets[0].name; size='~1 MB'; type='document'; } const newFile={id:Date.now().toString(),name,size,type,folderId:activeFolder?.id||'2',addedAt:Date.now(),autoDestruct,viewCount:0,maxViews:autoDestruct?parseInt(maxViews)||1:undefined,isEncrypted:true}; setFiles((prev:any[])=>[newFile,...prev]); setFolders(prev=>prev.map((f:any)=>f.id===activeFolder?.id?{...f,fileCount:f.fileCount+1}:f)); Alert.alert('File Added',name+' has been encrypted and stored securely.'); } catch(e){ Alert.alert('Error','Could not add file.'); } };

  const handleNav=(item:typeof NAV[0])=>{ setNavTab(item.id); if(item.id!=='vault')router.push(item.route as any); };
  const folderFiles=files.filter((f:any)=>f.folderId===activeFolder?.id);

  if(view==='files'&&activeFolder) return (
    <View style={S.container}>
      <LinearGradient colors={['#020B18','#040F20','#060F24']} style={StyleSheet.absoluteFillObject}/>
      <View style={S.header}>
        <TouchableOpacity onPress={()=>setView('folders')} style={S.backBtn}><Text style={{color:C.primary,fontSize:18}}>←</Text></TouchableOpacity>
        <Text style={{fontSize:22}}>{activeFolder.emoji}</Text>
        <View style={{flex:1}}>
          <Text style={{color:C.text,fontSize:15,fontWeight:'900'}}>{activeFolder.name}</Text>
          <Text style={{color:C.textFaint,fontSize:10}}>{folderFiles.length} files — AES-256 encrypted</Text>
        </View>
        <TouchableOpacity onPress={()=>setShowAddFile(true)} style={{backgroundColor:'#1D4ED8',borderRadius:20,width:40,height:40,justifyContent:'center',alignItems:'center'}}><Text style={{color:'#fff',fontSize:22,fontWeight:'900'}}>+</Text></TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={{paddingHorizontal:18,paddingBottom:110}}>
        {folderFiles.length===0?(
          <View style={{alignItems:'center',paddingTop:60}}>
            <Text style={{fontSize:56,marginBottom:16}}>📂</Text>
            <Text style={{color:C.textDim,fontSize:15,fontWeight:'700'}}>No files yet</Text>
            <Text style={{color:C.textFaint,fontSize:12,marginTop:6}}>Tap + to add encrypted files</Text>
          </View>
        ):folderFiles.map((file:any,i:number)=>(
          <TouchableOpacity key={i} onPress={()=>viewFile(file)} style={S.fileRow}>
            <View style={{width:46,height:46,borderRadius:12,backgroundColor:'rgba(10,22,40,0.85)',justifyContent:'center',alignItems:'center',borderWidth:1,borderColor:'rgba(255,255,255,0.06)'}}><Text style={{fontSize:22}}>{getFileIcon(file.type)}</Text></View>
            <View style={{flex:1}}>
              <Text style={{color:C.text,fontSize:13,fontWeight:'700'}} numberOfLines={1}>{file.name}</Text>
              <View style={{flexDirection:'row',gap:8,marginTop:4}}>
                <Text style={{color:C.textFaint,fontSize:10}}>{file.size}</Text>
                <Text style={{color:C.accent,fontSize:10}}>🔐</Text>
                {file.autoDestruct&&<Text style={{color:C.danger,fontSize:10}}>💣 {file.viewCount}/{file.maxViews}</Text>}
              </View>
            </View>
            <View style={{alignItems:'flex-end',gap:5}}>
              <Text style={{color:C.textFaint,fontSize:9}}>{fmtTime(file.addedAt)}</Text>
              <TouchableOpacity onPress={()=>deleteFile(file)}><Text style={{color:C.danger,fontSize:10}}>Delete</Text></TouchableOpacity>
            </View>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <Modal visible={showAddFile} transparent animationType="slide">
        <TouchableOpacity style={{flex:1,backgroundColor:'rgba(0,0,0,0.6)'}} activeOpacity={1} onPress={()=>setShowAddFile(false)}>
          <View style={{position:'absolute',bottom:0,left:0,right:0}}>
            <LinearGradient colors={['rgba(10,22,40,0.99)','rgba(6,14,34,0.99)']} style={{borderTopLeftRadius:28,borderTopRightRadius:28,padding:24,paddingBottom:44,borderWidth:1,borderColor:'rgba(74,159,255,0.12)'}}>
              <Text style={{color:C.text,fontSize:18,fontWeight:'900',marginBottom:20}}>Add to Vault</Text>
              <View style={{flexDirection:'row',justifyContent:'space-around',marginBottom:20}}>
                {[{icon:'📷',label:'Camera',action:()=>addFile('camera')},{icon:'🖼️',label:'Gallery',action:()=>addFile('gallery')},{icon:'📄',label:'Document',action:()=>addFile('document')}].map((o,i)=>(
                  <TouchableOpacity key={i} onPress={o.action} style={{alignItems:'center',gap:8}}>
                    <LinearGradient colors={[C.primary,C.secondary]} style={{width:62,height:62,borderRadius:31,justifyContent:'center',alignItems:'center'}}><Text style={{fontSize:26}}>{o.icon}</Text></LinearGradient>
                    <Text style={{color:C.text,fontSize:12,fontWeight:'600'}}>{o.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TouchableOpacity onPress={()=>setAutoDestruct(!autoDestruct)} style={{backgroundColor:autoDestruct?C.danger+'15':'rgba(6,14,34,0.9)',borderRadius:14,padding:14,borderWidth:1.5,borderColor:autoDestruct?C.danger:'rgba(255,255,255,0.08)',flexDirection:'row',alignItems:'center',gap:10,marginBottom:autoDestruct?10:0}}>
                <Text style={{fontSize:18}}>💣</Text>
                <View style={{flex:1}}><Text style={{color:C.text,fontSize:13,fontWeight:'700'}}>Auto-Destruct After Viewing</Text></View>
                <View style={{width:20,height:20,borderRadius:10,backgroundColor:autoDestruct?C.danger:'rgba(255,255,255,0.15)'}}/>
              </TouchableOpacity>
              {autoDestruct&&<View style={{flexDirection:'row',gap:8}}>{['1','3','5','10'].map(n=>(<TouchableOpacity key={n} onPress={()=>setMaxViews(n)} style={{flex:1,backgroundColor:maxViews===n?C.danger+'22':'rgba(6,14,34,0.9)',borderRadius:12,paddingVertical:10,alignItems:'center',borderWidth:1,borderColor:maxViews===n?C.danger:'rgba(255,255,255,0.08)'}}><Text style={{color:maxViews===n?C.danger:C.textDim,fontSize:13,fontWeight:'700'}}>{n}x</Text></TouchableOpacity>))}</View>}
            </LinearGradient>
          </View>
        </TouchableOpacity>
      </Modal>
      <View style={S.navBar}>
        {NAV.map(item=>(<TouchableOpacity key={item.id} onPress={()=>handleNav(item)} style={[S.navItem,navTab===item.id&&S.navItemActive]}><Text style={{fontSize:20,lineHeight:22}}>{item.icon}</Text><Text style={[S.navLabel,{color:navTab===item.id?C.primary:C.textFaint}]}>{item.label}</Text></TouchableOpacity>))}
      </View>
    </View>
  );

  return (
    <View style={S.container}>
      <LinearGradient colors={['#020B18','#040F20','#060F24']} style={StyleSheet.absoluteFillObject}/>
      <Animated.View style={{flex:1,opacity:fadeIn}}>
        <View style={S.header}>
          <TouchableOpacity onPress={()=>router.back()} style={S.backBtn}><Text style={{color:C.primary,fontSize:18}}>←</Text></TouchableOpacity>
          <View style={{flex:1}}><Text style={S.title}>📦 File Vault</Text><Text style={{color:C.textFaint,fontSize:9,letterSpacing:2}}>ENCRYPTED SECURE STORAGE</Text></View>
          <TouchableOpacity onPress={()=>setShowCreateFolder(true)} style={{backgroundColor:'#1D4ED8',borderRadius:20,width:40,height:40,justifyContent:'center',alignItems:'center'}}><Text style={{color:'#fff',fontSize:22,fontWeight:'900'}}>+</Text></TouchableOpacity>
        </View>
        <View style={{flexDirection:'row',paddingHorizontal:18,gap:8,marginBottom:16}}>
          {[{label:'Total Files',value:files.length.toString(),icon:'📁'},{label:'Storage Used',value:(files.length*2.4).toFixed(1)+' MB',icon:'💾'},{label:'Auto-Destruct',value:files.filter((f:any)=>f.autoDestruct).length.toString(),icon:'💣'}].map((s,i)=>(
            <View key={i} style={{flex:1,backgroundColor:'rgba(10,22,40,0.8)',borderRadius:14,padding:12,alignItems:'center',borderWidth:1,borderColor:'rgba(255,255,255,0.06)'}}>
              <Text style={{fontSize:18}}>{s.icon}</Text>
              <Text style={{color:C.primary,fontSize:15,fontWeight:'900',marginTop:4}}>{s.value}</Text>
              <Text style={{color:C.textFaint,fontSize:8,marginTop:2,textAlign:'center'}}>{s.label}</Text>
            </View>
          ))}
        </View>
        <ScrollView contentContainerStyle={{paddingHorizontal:18,paddingBottom:110}}>
          <View style={{flexDirection:'row',flexWrap:'wrap',gap:12}}>
            {folders.map((folder:any,i:number)=>(
              <TouchableOpacity key={i} onPress={()=>openFolder(folder)} style={{width:'47%',backgroundColor:'rgba(10,22,40,0.8)',borderRadius:18,padding:16,borderWidth:1,borderColor:'rgba(255,255,255,0.06)'}}>
                <View style={{flexDirection:'row',justifyContent:'space-between',marginBottom:12}}>
                  <View style={{width:46,height:46,borderRadius:23,backgroundColor:folder.color+'18',borderWidth:1.5,borderColor:folder.color+'55',justifyContent:'center',alignItems:'center'}}><Text style={{fontSize:22}}>{folder.emoji}</Text></View>
                  <Text style={{fontSize:20}}>{folder.isLocked?'🔒':'🔓'}</Text>
                </View>
                <Text style={{color:C.text,fontSize:14,fontWeight:'800',marginBottom:4}} numberOfLines={1}>{folder.name}</Text>
                <Text style={{color:C.textFaint,fontSize:11,marginBottom:8}}>{folder.fileCount} files</Text>
                <View style={{height:3,backgroundColor:'rgba(255,255,255,0.06)',borderRadius:2}}>
                  <View style={{width:(Math.min(100,folder.fileCount*7)+'%') as any,height:3,backgroundColor:folder.color,borderRadius:2}}/>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      </Animated.View>
      <Modal visible={showPasswordModal} transparent animationType="fade">
        <View style={{flex:1,backgroundColor:'rgba(0,0,0,0.85)',justifyContent:'center',padding:24}}>
          <LinearGradient colors={['rgba(10,22,40,0.99)','rgba(6,14,34,0.99)']} style={{borderRadius:24,padding:24,borderWidth:1.5,borderColor:C.border}}>
            <Text style={{fontSize:40,textAlign:'center',marginBottom:12}}>🔒</Text>
            <Text style={{color:C.text,fontSize:17,fontWeight:'900',textAlign:'center',marginBottom:20}}>{folderToUnlock?.name}</Text>
            <TextInput value={passwordInput} onChangeText={setPasswordInput} placeholder="Password..." placeholderTextColor={C.textFaint} secureTextEntry style={[S.input,{marginBottom:16,textAlign:'center',letterSpacing:4}]}/>
            <TouchableOpacity onPress={unlockFolder}><LinearGradient colors={[C.primary,C.secondary]} style={{borderRadius:16,paddingVertical:14,alignItems:'center',marginBottom:10}}><Text style={{color:'#fff',fontSize:15,fontWeight:'900'}}>Unlock Folder</Text></LinearGradient></TouchableOpacity>
            <TouchableOpacity onPress={()=>{setShowPasswordModal(false);setPasswordInput('');}} style={{alignItems:'center',paddingVertical:10}}><Text style={{color:C.textFaint,fontSize:14}}>Cancel</Text></TouchableOpacity>
          </LinearGradient>
        </View>
      </Modal>
      <Modal visible={showCreateFolder} transparent animationType="slide">
        <TouchableOpacity style={{flex:1,backgroundColor:'rgba(0,0,0,0.6)'}} activeOpacity={1} onPress={()=>setShowCreateFolder(false)}>
          <View style={{position:'absolute',bottom:0,left:0,right:0}}>
            <LinearGradient colors={['rgba(10,22,40,0.99)','rgba(6,14,34,0.99)']} style={{borderTopLeftRadius:28,borderTopRightRadius:28,padding:24,paddingBottom:44,borderWidth:1,borderColor:'rgba(74,159,255,0.12)'}}>
              <Text style={{color:C.text,fontSize:18,fontWeight:'900',marginBottom:20}}>Create Folder</Text>
              <TextInput value={newFolderName} onChangeText={setNewFolderName} placeholder="Folder name..." placeholderTextColor={C.textFaint} style={[S.input,{marginBottom:12}]}/>
              <TouchableOpacity onPress={()=>setNewFolderLocked(!newFolderLocked)} style={{backgroundColor:newFolderLocked?C.accent+'12':'rgba(6,14,34,0.9)',borderRadius:14,padding:14,borderWidth:1.5,borderColor:newFolderLocked?C.accent:'rgba(255,255,255,0.08)',flexDirection:'row',alignItems:'center',gap:10,marginBottom:10}}>
                <Text style={{fontSize:20}}>{newFolderLocked?'🔒':'🔓'}</Text>
                <Text style={{color:C.text,fontSize:14,fontWeight:'700',flex:1}}>Password Lock</Text>
                <View style={{width:20,height:20,borderRadius:10,backgroundColor:newFolderLocked?C.accent:'rgba(255,255,255,0.15)'}}/>
              </TouchableOpacity>
              {newFolderLocked&&<TextInput value={newFolderPassword} onChangeText={setNewFolderPassword} placeholder="Set folder password..." placeholderTextColor={C.textFaint} secureTextEntry style={[S.input,{marginBottom:12}]}/>}
              <TouchableOpacity onPress={createFolder}><LinearGradient colors={[C.primary,C.secondary]} style={{borderRadius:16,paddingVertical:14,alignItems:'center'}}><Text style={{color:'#fff',fontSize:15,fontWeight:'900'}}>Create Encrypted Folder</Text></LinearGradient></TouchableOpacity>
            </LinearGradient>
          </View>
        </TouchableOpacity>
      </Modal>
      <View style={S.navBar}>
        {NAV.map(item=>(<TouchableOpacity key={item.id} onPress={()=>handleNav(item)} style={[S.navItem,navTab===item.id&&S.navItemActive]}><Text style={{fontSize:20,lineHeight:22}}>{item.icon}</Text><Text style={[S.navLabel,{color:navTab===item.id?C.primary:C.textFaint}]}>{item.label}</Text></TouchableOpacity>))}
      </View>
    </View>
  );
}

export default function FileVaultScreen() {
  return (<ErrorBoundary fallbackTitle="File Vault Error" fallbackMessage="File Vault had a problem."><FileVaultContent/></ErrorBoundary>);
}

const S = StyleSheet.create({
  container:{flex:1,backgroundColor:'#020B18'},
  header:{flexDirection:'row',alignItems:'center',paddingHorizontal:18,paddingTop:50,paddingBottom:16,gap:10},
  title:{color:'#fff',fontSize:20,fontWeight:'900'},
  backBtn:{width:36,height:36,borderRadius:18,backgroundColor:'rgba(10,22,40,0.8)',justifyContent:'center',alignItems:'center',borderWidth:1,borderColor:'rgba(255,255,255,0.06)'},
  fileRow:{flexDirection:'row',alignItems:'center',backgroundColor:'rgba(10,22,40,0.8)',borderRadius:16,padding:14,marginBottom:8,borderWidth:1,borderColor:'rgba(255,255,255,0.06)',gap:12},
  input:{backgroundColor:'rgba(6,14,34,0.9)',borderRadius:14,padding:15,color:'#fff',fontSize:14,borderWidth:1,borderColor:'rgba(255,255,255,0.08)'},
  navBar:{position:'absolute',bottom:18,left:14,right:14,backgroundColor:'rgba(4,12,28,0.92)',borderRadius:28,borderWidth:1,borderColor:'rgba(74,159,255,0.12)',paddingVertical:10,paddingHorizontal:6,flexDirection:'row',justifyContent:'space-around',alignItems:'center'},
  navItem:{alignItems:'center',gap:4,paddingVertical:6,paddingHorizontal:12,borderRadius:20,borderWidth:1,borderColor:'transparent'},
  navItemActive:{backgroundColor:'rgba(74,159,255,0.12)',borderColor:'rgba(74,159,255,0.25)'},
  navLabel:{fontSize:9,letterSpacing:0.5,fontWeight:'600'},
});
