/**
 * crazzychat — Document Scanner
 * Step 1: Scan (camera / gallery)
 * Step 2: Enhance (filters + adjustments)
 * Step 3: Export (8 formats + 6 share targets)
 */
import { BRAND_ACCENT, brandAlpha } from '../constants/theme';
import React, { useState } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet,
  ScrollView, Alert, ActivityIndicator,
  Image, Platform, Share,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";

// -----------------------------------------------------------------------------
const FORMATS = [
  { ext: "PDF",  icon: "??", color: "#EF4444", desc: "Universal" },
  { ext: "JPG",  icon: "???", color: "#3B82F6", desc: "Image" },
  { ext: "PNG",  icon: "??", color: "#8B5CF6", desc: "Lossless" },
  { ext: "DOCX", icon: "??", color: "#2563EB", desc: "Word" },
  { ext: "XLSX", icon: "??", color: BRAND_ACCENT, desc: "Excel" },
  { ext: "TXT",  icon: "??", color: "#F59E0B", desc: "Plain text" },
  { ext: "TIFF", icon: "???", color: "#6366F1", desc: "Print" },
  { ext: "ZIP",  icon: "???", color: "#EC4899", desc: "Compressed" },
];

const FILTERS = [
  { name: "Auto",  label: "Auto" },
  { name: "B&W",   label: "B&W" },
  { name: "Color", label: "Color" },
  { name: "Magic", label: "Magic" },
  { name: "Soft",  label: "Soft" },
];

const SHARE_APPS = [
  { name: "crazzychat", icon: "??", color: "#4A9FFF" },
  { name: "WhatsApp",  icon: "??", color: "#25D366" },
  { name: "Email",     icon: "??", color: "#4A9FFF" },
  { name: "Drive",     icon: "??", color: "#FBBC04" },
  { name: "Telegram",  icon: "??", color: "#2AABEE" },
  { name: "Files",     icon: "??", color: "#8B5CF6" },
];

const STEPS = ["Scan", "Enhance", "Export"];

// -- Step Bar ------------------------------------------------------------------
const StepBar = ({ step }: { step: number }) => (
  <View style={s.stepBar}>
    {STEPS.map((name, i) => (
      <React.Fragment key={i}>
        <View style={s.stepItem}>
          <LinearGradient
            colors={
              step > i  ? [BRAND_ACCENT,"#059669"] :
              step === i ? ["#4A9FFF","#7C3AED"] :
              ["transparent","transparent"]
            }
            style={[s.stepCircle, step < i && s.stepCircleInactive]}>
            <Text style={[s.stepNum, step >= i && { color:"#fff" }]}>
              {step > i ? "?" : `${i+1}`}
            </Text>
          </LinearGradient>
          <Text style={[s.stepLabel, step >= i && { color:"rgba(255,255,255,0.85)" }]}>
            {name}
          </Text>
        </View>
        {i < 2 && (
          <View style={[s.stepLine, step > i && { backgroundColor:BRAND_ACCENT }]} />
        )}
      </React.Fragment>
    ))}
  </View>
);

// -- Format Chip ---------------------------------------------------------------
const FormatChip = ({ fmt, active, onPress }: any) => (
  <TouchableOpacity onPress={onPress} style={[
    s.fmtChip,
    active && { backgroundColor:`${fmt.color}20`, borderColor:`${fmt.color}60` }
  ]}>
    <Text style={s.fmtIcon}>{fmt.icon}</Text>
    <Text style={[s.fmtExt, active && { color: fmt.color }]}>.{fmt.ext}</Text>
    <Text style={s.fmtDesc}>{fmt.desc}</Text>
  </TouchableOpacity>
);

// -- Share App Chip ------------------------------------------------------------
const AppChip = ({ app, active, onPress }: any) => (
  <TouchableOpacity onPress={onPress} style={[
    s.appChip,
    active && { backgroundColor:`${app.color}20`, borderColor:`${app.color}60` }
  ]}>
    <Text style={s.appIcon}>{app.icon}</Text>
    <Text numberOfLines={1} style={[s.appName, active && { color: app.color }]}>{app.name}</Text>
  </TouchableOpacity>
);

// -- Main Screen ---------------------------------------------------------------
export default function ScannerScreen() {
  const router   = useRouter();
  const params   = useLocalSearchParams();
  const chatName = (params.name as string) || "Contact";

  const [step,         setStep]         = useState(0);
  const [imageUri,     setImageUri]     = useState<string | null>(null);
  const [pages,        setPages]        = useState(1);
  const [activeFilter, setActiveFilter] = useState(0);
  const [brightness,   setBrightness]   = useState(72);
  const [contrast,     setContrast]     = useState(58);
  const [sharpness,    setSharpness]    = useState(65);
  const [selectedFmt,  setSelectedFmt]  = useState(0);
  const [selectedApp,  setSelectedApp]  = useState(0);
  const [processing,   setProcessing]   = useState(false);
  const [done,         setDone]         = useState(false);


  // -- Camera ------------------------------------------------------------------
  const openCamera = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission needed", "Camera access required to scan documents.");
      return;
    }
    const result = Platform.OS === 'web'
      ? await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images"],
          quality: 1,
          allowsEditing: true,
        })
      : await ImagePicker.launchCameraAsync({
          mediaTypes: ["images"],
          quality: 1,
          allowsEditing: true,
        });
    if (!result.canceled && result.assets[0]) {
      setImageUri(result.assets[0].uri);
      setTimeout(() => setStep(1), 400);
    }
  };

  // -- Gallery -----------------------------------------------------------------
  const openGallery = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 1,
      allowsEditing: true,
    });
    if (!result.canceled && result.assets[0]) {
      setImageUri(result.assets[0].uri);
      setTimeout(() => setStep(1), 400);
    }
  };

  // -- Export + Share ----------------------------------------------------------
  const handleExport = async () => {
    setProcessing(true);
    try {
      const fmt  = FORMATS[selectedFmt];
      const date = new Date().toLocaleDateString("en-GB").replace(/\//g, "-");
      const dest = `${(FileSystem as any).cacheDirectory}VaultScan_${date}.${fmt.ext.toLowerCase()}`;

      if (imageUri) {
        await FileSystem.copyAsync({ from: imageUri, to: dest });
      }

      await new Promise(r => setTimeout(r, 1200));

      if (selectedApp === 0) {
        Alert.alert("? Document Scanned", `Sending ${fmt.ext} to ${chatName}...`);
      } else {
        const canShare = await Sharing.isAvailableAsync();
        if (canShare && imageUri) {
          await Sharing.shareAsync(dest, {
            mimeType: fmt.ext === "PDF" ? "application/pdf" : `image/${fmt.ext.toLowerCase()}`,
            dialogTitle: `Share via ${SHARE_APPS[selectedApp].name}`,
          });
        } else {
          await Share.share({ title: `VaultScan.${fmt.ext}`, message: `Scanned document (${pages} page${pages>1?"s":""})` });
        }
      }

      setDone(true);
    } catch {
      Alert.alert("Error", "Could not export document. Please try again.");
    } finally {
      setProcessing(false);
    }
  };

  const reset = () => {
    setStep(0); setImageUri(null); setDone(false);
    setProcessing(false); setPages(1);
  };

  const fmt = FORMATS[selectedFmt];

  // -- Render ------------------------------------------------------------------
  return (
    <LinearGradient colors={["#FFFFFF","#071020","#0a1628"]} style={s.root}>

      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="arrow-back" size={22} color="#fff" />
        </TouchableOpacity>
        <View style={s.headerTitleWrap}>
          <LinearGradient colors={["#4A9FFF","#7C3AED"]} style={s.headerIcon}>
            <Text style={{ fontSize: 18 }}>??</Text>
          </LinearGradient>
          <View>
            <Text style={s.headerTitle}>VaultScan</Text>
            <Text style={s.headerSub}>Document Scanner</Text>
          </View>
        </View>
        <View style={s.secBadge}>
          <Text style={s.secText}>?? Secure</Text>
        </View>
      </View>

      {/* Step bar */}
      <StepBar step={step} />

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

        {/* -- STEP 0: SCAN ----------------------------------------------- */}
        {step === 0 && (
          <View>
            <View style={s.viewfinder}>
              <LinearGradient colors={["#0d1929","#0a1420"]} style={s.viewfinderInner}>
                <Text style={{ fontSize: 52, marginBottom: 14 }}>??</Text>
                <Text style={s.vfTitle}>Position your document</Text>
                <Text style={s.vfSub}>Make sure it&apos;s well lit and flat</Text>
                {[[0,0],[1,0],[0,1],[1,1]].map(([x,y], i) => (
                  <View key={i} style={[s.corner,
                    x===1 && { right:16, left:undefined },
                    y===1 && { bottom:16, top:undefined },
                  ]}>
                    <View style={[s.cornerH, x===1 && { right:0, left:undefined }]} />
                    <View style={[s.cornerV, y===1 && { bottom:0, top:undefined }]} />
                  </View>
                ))}
              </LinearGradient>
            </View>

            <View style={s.captureRow}>
              <TouchableOpacity onPress={openGallery} style={s.galleryBtn}>
                <Text style={{ fontSize: 22 }}>???</Text>
                <Text style={s.galleryBtnText}>Gallery</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={openCamera} style={s.cameraBtn}>
                <LinearGradient colors={["#4A9FFF","#7C3AED"]} style={s.cameraBtnInner}>
                  <Text style={{ fontSize: 28 }}>??</Text>
                  <Text style={s.cameraBtnText}>Scan Document</Text>
                </LinearGradient>
              </TouchableOpacity>
              <View style={s.pagesBox}>
                <TouchableOpacity onPress={() => setPages(p => Math.max(1,p-1))}>
                  <Text style={s.pagesBtn}>-</Text>
                </TouchableOpacity>
                <Text style={s.pagesCount}>{pages}</Text>
                <TouchableOpacity onPress={() => setPages(p => p+1)}>
                  <Text style={s.pagesBtn}>+</Text>
                </TouchableOpacity>
              </View>
            </View>

            <View style={s.toolRow}>
              {[{i:"?",l:"Auto\nEdge"},{i:"??",l:"HDR"},{i:"??",l:"Crop"},{i:"??",l:"Grid"},{i:"??",l:"Flash"}].map((t,i) => (
                <TouchableOpacity key={i} style={s.toolBtn}>
                  <Text style={{ fontSize: 20 }}>{t.i}</Text>
                  <Text style={s.toolLabel}>{t.l}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={s.sectionLabel}>Export Format</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
              <View style={{ flexDirection:"row", gap:8, paddingHorizontal:2 }}>
                {FORMATS.map((f,i) => <FormatChip key={i} fmt={f} active={selectedFmt===i} onPress={() => setSelectedFmt(i)} />)}
              </View>
            </ScrollView>

            <Text style={s.sectionLabel}>Share Via</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
              <View style={{ flexDirection:"row", gap:8, paddingHorizontal:2 }}>
                {SHARE_APPS.map((a,i) => <AppChip key={i} app={a} active={selectedApp===i} onPress={() => setSelectedApp(i)} />)}
              </View>
            </ScrollView>

            <View style={s.infoBox}>
              <Text style={s.infoText}>?? Tap camera to scan · ??? Import from gallery · Page count: {pages}</Text>
            </View>
          </View>
        )}

        {/* -- STEP 1: ENHANCE -------------------------------------------- */}
        {step === 1 && (
          <View>
            <View style={s.previewBox}>
              {imageUri ? (
                <Image source={{ uri: imageUri }} style={s.previewImg} resizeMode="cover" />
              ) : (
                <LinearGradient colors={["#f7f3ec","#ede8df"]} style={s.previewPlaceholder}>
                  <Text style={{ fontSize:40 }}>??</Text>
                </LinearGradient>
              )}
              <View style={s.previewBadge}>
                <Text style={s.previewBadgeText}>{pages} page{pages>1?"s":""} · {FILTERS[activeFilter].name}</Text>
              </View>
            </View>

            <Text style={s.sectionLabel}>Enhancement Filter</Text>
            <View style={s.filterRow}>
              {FILTERS.map((f,i) => (
                <TouchableOpacity key={i} onPress={() => setActiveFilter(i)}
                  style={[s.filterBtn, activeFilter===i && s.filterBtnActive]}>
                  <Text numberOfLines={1} style={[s.filterBtnText, activeFilter===i && { color:"#fff" }]}>{f.name}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {[
              { label:"Brightness", icon:"??", val:brightness, set:setBrightness },
              { label:"Contrast",   icon:"?",  val:contrast,   set:setContrast   },
              { label:"Sharpness",  icon:"?",  val:sharpness,  set:setSharpness  },
            ].map((item,i) => (
              <View key={i} style={s.sliderWrap}>
                <View style={s.sliderHeader}>
                  <Text style={s.sliderLabel}>{item.icon} {item.label}</Text>
                  <Text style={s.sliderVal}>{item.val}%</Text>
                </View>
                <View style={s.sliderTrack}>
                  <View style={[s.sliderFill, { width:(`${item.val}%`) as any }]} />
                  <TouchableOpacity
                    style={[s.sliderThumb, { left:(`${item.val}%`) as any }]}
                    onPress={() => item.set(v => Math.min(100, v + 5))}
                  />
                </View>
                <View style={s.sliderBtns}>
                  <TouchableOpacity onPress={() => item.set(v => Math.max(0, v-5))} style={s.sliderAdjBtn}><Text style={s.sliderAdjText}>-</Text></TouchableOpacity>
                  <TouchableOpacity onPress={() => item.set(v => Math.min(100, v+5))} style={s.sliderAdjBtn}><Text style={s.sliderAdjText}>+</Text></TouchableOpacity>
                </View>
              </View>
            ))}

            <Text style={s.sectionLabel}>Export Format</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom:14 }}>
              <View style={{ flexDirection:"row", gap:8, paddingHorizontal:2 }}>
                {FORMATS.map((f,i) => <FormatChip key={i} fmt={f} active={selectedFmt===i} onPress={() => setSelectedFmt(i)} />)}
              </View>
            </ScrollView>

            <Text style={s.sectionLabel}>Share Via</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom:14 }}>
              <View style={{ flexDirection:"row", gap:8, paddingHorizontal:2 }}>
                {SHARE_APPS.map((a,i) => <AppChip key={i} app={a} active={selectedApp===i} onPress={() => setSelectedApp(i)} />)}
              </View>
            </ScrollView>

            <View style={s.rowBtns}>
              <TouchableOpacity onPress={() => setStep(0)} style={s.backStepBtn}>
                <Text style={s.backStepText}>? Rescan</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setStep(2)} style={{ flex:2 }}>
                <LinearGradient colors={["#4A9FFF","#7C3AED"]} style={s.nextBtn}>
                  <Text style={s.nextBtnText}>Export ?</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* -- STEP 2: EXPORT --------------------------------------------- */}
        {step === 2 && !done && (
          <View>
            <View style={s.exportPreview}>
              {imageUri
                ? <Image source={{ uri: imageUri }} style={s.exportImg} resizeMode="cover" />
                : <LinearGradient colors={["#f7f3ec","#ede8df"]} style={s.exportPlaceholder}><Text style={{ fontSize:32 }}>??</Text></LinearGradient>
              }
            </View>

            <Text style={s.sectionLabel}>Choose Format</Text>
            <View style={s.fmtGrid}>
              {FORMATS.map((f,i) => (
                <TouchableOpacity key={i} onPress={() => setSelectedFmt(i)} style={[
                  s.fmtGridItem,
                  selectedFmt===i && { borderColor:f.color, backgroundColor:`${f.color}15` }
                ]}>
                  <Text style={{ fontSize:20 }}>{f.icon}</Text>
                  <View style={{ flex:1 }}>
                    <Text style={[s.fmtGridExt, selectedFmt===i && { color:f.color }]}>.{f.ext}</Text>
                    <Text style={s.fmtGridDesc}>{f.desc}</Text>
                  </View>
                  {selectedFmt===i && <Text style={[s.fmtCheck, { color:f.color }]}>?</Text>}
                </TouchableOpacity>
              ))}
            </View>

            <View style={s.fileCard}>
              <LinearGradient colors={[`${fmt.color}25`,`${fmt.color}10`]} style={s.fileCardIcon}>
                <Text style={{ fontSize:22 }}>{fmt.icon}</Text>
              </LinearGradient>
              <View style={{ flex:1 }}>
                <Text style={s.fileCardName} numberOfLines={1}>
                  VaultScan_{new Date().toLocaleDateString("en-GB").replace(/\//g,"-")}.{fmt.ext.toLowerCase()}
                </Text>
                <Text style={s.fileCardMeta}>
                  {pages} page{pages>1?"s":""} · ~{(pages*0.4+0.3).toFixed(1)} MB · ?? AES-256
                </Text>
              </View>
            </View>

            <Text style={s.sectionLabel}>Share Via</Text>
            <View style={s.shareGrid}>
              {SHARE_APPS.map((a,i) => (
                <TouchableOpacity key={i} onPress={() => setSelectedApp(i)} style={[
                  s.shareGridItem,
                  selectedApp===i && { borderColor:`${a.color}60`, backgroundColor:`${a.color}15` }
                ]}>
                  <Text style={{ fontSize:22 }}>{a.icon}</Text>
                  <Text numberOfLines={1} style={[s.shareGridName, selectedApp===i && { color:a.color }]}>{a.name}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={s.rowBtns}>
              <TouchableOpacity onPress={() => setStep(1)} style={s.backStepBtn}>
                <Text style={s.backStepText}>? Back</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={handleExport} disabled={processing} style={{ flex:2 }}>
                <LinearGradient
                  colors={processing ? ["#1a2a3a","#1a2a3a"] : [BRAND_ACCENT,"#059669"]}
                  style={s.nextBtn}>
                  {processing
                    ? <ActivityIndicator color="#fff" />
                    : <Text style={s.nextBtnText}>?? Export & Share</Text>
                  }
                </LinearGradient>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* -- DONE -------------------------------------------------------- */}
        {done && (
          <View style={s.doneWrap}>
            <Text style={{ fontSize:60, marginBottom:16 }}>?</Text>
            <Text style={s.doneTitle}>Sent Successfully!</Text>
            <Text style={s.doneSub}>
              {fmt.ext} exported via {SHARE_APPS[selectedApp].name} and sent to {chatName}.
            </Text>
            <View style={s.doneEncBadge}>
              <Text style={s.doneEncText}>?? AES-256 Encrypted · Zero Server Storage</Text>
            </View>
            <View style={s.rowBtns}>
              <TouchableOpacity onPress={reset} style={{ flex:1 }}>
                <LinearGradient colors={["#4A9FFF","#7C3AED"]} style={s.nextBtn}>
                  <Text style={s.nextBtnText}>?? Scan More</Text>
                </LinearGradient>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => router.back()} style={[s.backStepBtn,{flex:1}]}>
                <Text style={s.backStepText}>? Done</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

      </ScrollView>
    </LinearGradient>
  );
}

// -- Styles --------------------------------------------------------------------
const s = StyleSheet.create({
  root:              { flex:1 },
  header:            { flexDirection:"row", alignItems:"center", gap:10,
                       paddingTop:Platform.OS==="ios"?54:42, paddingBottom:14, paddingHorizontal:18,
                       backgroundColor:"rgba(1,8,18,0.95)", borderBottomWidth:1,
                       borderBottomColor:"rgba(255,255,255,0.06)" },
  backBtn:           { width:36, height:36, justifyContent:"center", alignItems:"center" },
  backText:          { color:"#fff", fontSize:22, fontWeight:"900" },
  headerTitleWrap:   { flex:1, flexDirection:"row", alignItems:"center", gap:10 },
  headerIcon:        { width:36, height:36, borderRadius:10, justifyContent:"center", alignItems:"center" },
  headerTitle:       { color:"#fff", fontSize:15, fontWeight:"900" },
  headerSub:         { color:"rgba(255,255,255,0.35)", fontSize:11 },
  secBadge:          { backgroundColor:brandAlpha(0.1), borderRadius:8,
                       paddingHorizontal:8, paddingVertical:4,
                       borderWidth:1, borderColor:brandAlpha(0.25) },
  secText:           { color:BRAND_ACCENT, fontSize:10, fontWeight:"800" },
  stepBar:           { flexDirection:"row", alignItems:"center", paddingHorizontal:18,
                       paddingVertical:12, borderBottomWidth:1,
                       borderBottomColor:"rgba(255,255,255,0.05)" },
  stepItem:          { flexDirection:"row", alignItems:"center", gap:5, flexShrink:0 },
  stepCircle:        { width:22, height:22, borderRadius:11,
                       justifyContent:"center", alignItems:"center" },
  stepCircleInactive:{ borderWidth:1, borderColor:"rgba(255,255,255,0.15)" },
  stepNum:           { color:"rgba(255,255,255,0.25)", fontSize:10, fontWeight:"900" },
  stepLabel:         { color:"rgba(255,255,255,0.25)", fontSize:11, fontWeight:"700" },
  stepLine:          { flex:1, height:1.5, backgroundColor:"rgba(255,255,255,0.06)",
                       marginHorizontal:6, borderRadius:1 },
  scroll:            { padding:16, paddingBottom:48 },
  sectionLabel:      { color:"rgba(255,255,255,0.4)", fontSize:10, fontWeight:"700",
                       textTransform:"uppercase", letterSpacing:0.8, marginBottom:8 },
  viewfinder:        { borderRadius:16, overflow:"hidden", marginBottom:14, height:200 },
  viewfinderInner:   { flex:1, justifyContent:"center", alignItems:"center",
                       borderWidth:1, borderColor:"rgba(255,255,255,0.07)", borderRadius:16 },
  vfTitle:           { color:"#fff", fontSize:15, fontWeight:"800", marginTop:4 },
  vfSub:             { color:"rgba(255,255,255,0.4)", fontSize:12, marginTop:4 },
  corner:            { position:"absolute", top:16, left:16, width:24, height:24 },
  cornerH:           { position:"absolute", top:0, left:0, height:2.5, width:20,
                       backgroundColor:"#4A9FFF", borderRadius:1 },
  cornerV:           { position:"absolute", top:0, left:0, width:2.5, height:20,
                       backgroundColor:"#4A9FFF", borderRadius:1 },
  captureRow:        { flexDirection:"row", alignItems:"center", gap:10, marginBottom:12 },
  galleryBtn:        { alignItems:"center", gap:4, backgroundColor:"rgba(255,255,255,0.07)",
                       borderRadius:14, padding:12, borderWidth:1,
                       borderColor:"rgba(255,255,255,0.1)" },
  galleryBtnText:    { color:"rgba(255,255,255,0.6)", fontSize:10, fontWeight:"700" },
  cameraBtn:         { flex:1, borderRadius:14, overflow:"hidden" },
  cameraBtnInner:    { flexDirection:"row", alignItems:"center", justifyContent:"center",
                       gap:10, paddingVertical:14 },
  cameraBtnText:     { color:"#fff", fontSize:14, fontWeight:"900" },
  pagesBox:          { alignItems:"center", backgroundColor:"rgba(255,255,255,0.07)",
                       borderRadius:14, padding:10, borderWidth:1,
                       borderColor:"rgba(255,255,255,0.1)", gap:4 },
  pagesBtn:          { color:"#4A9FFF", fontSize:18, fontWeight:"900", paddingHorizontal:4 },
  pagesCount:        { color:"#fff", fontSize:14, fontWeight:"900" },
  toolRow:           { flexDirection:"row", justifyContent:"space-around",
                       paddingVertical:10, marginBottom:14,
                       borderTopWidth:1, borderTopColor:"rgba(255,255,255,0.05)",
                       borderBottomWidth:1, borderBottomColor:"rgba(255,255,255,0.05)" },
  toolBtn:           { alignItems:"center", gap:4, padding:"4px 6px" as any },
  toolLabel:         { color:"rgba(255,255,255,0.35)", fontSize:9, fontWeight:"700",
                       textAlign:"center" },
  fmtChip:           { alignItems:"center", gap:3, backgroundColor:"rgba(255,255,255,0.06)",
                       borderRadius:12, padding:10, borderWidth:1,
                       borderColor:"rgba(255,255,255,0.08)", minWidth:60 },
  fmtIcon:           { fontSize:18 },
  fmtExt:            { color:"rgba(255,255,255,0.6)", fontSize:10, fontWeight:"800" },
  fmtDesc:           { color:"rgba(255,255,255,0.3)", fontSize:9 },
  appChip:           { alignItems:"center", gap:3, backgroundColor:"rgba(255,255,255,0.06)",
                       borderRadius:12, padding:10, borderWidth:1,
                       borderColor:"rgba(255,255,255,0.08)", minWidth:68 },
  appIcon:           { fontSize:18 },
  appName:           { color:"rgba(255,255,255,0.5)", fontSize:9, fontWeight:"700" },
  infoBox:           { backgroundColor:"rgba(74,159,255,0.06)", borderRadius:10,
                       padding:10, borderWidth:1, borderColor:"rgba(74,159,255,0.12)" },
  infoText:          { color:"rgba(255,255,255,0.35)", fontSize:11, textAlign:"center" },
  previewBox:        { height:180, borderRadius:16, overflow:"hidden", marginBottom:14, position:"relative" },
  previewImg:        { width:"100%", height:"100%" },
  previewPlaceholder:{ flex:1, justifyContent:"center", alignItems:"center" },
  previewBadge:      { position:"absolute", top:8, right:8, backgroundColor:"rgba(0,0,0,0.55)",
                       borderRadius:6, paddingHorizontal:8, paddingVertical:3 },
  previewBadgeText:  { color:"#fff", fontSize:10, fontWeight:"700" },
  filterRow:         { flexDirection:"row", gap:6, marginBottom:14 },
  filterBtn:         { flex:1, paddingVertical:9, borderRadius:10,
                       backgroundColor:"rgba(255,255,255,0.07)",
                       alignItems:"center", borderWidth:1,
                       borderColor:"rgba(255,255,255,0.08)" },
  filterBtnActive:   { backgroundColor:"#4A9FFF", borderColor:"#4A9FFF" },
  filterBtnText:     { color:"rgba(255,255,255,0.5)", fontSize:11, fontWeight:"800" },
  sliderWrap:        { marginBottom:12 },
  sliderHeader:      { flexDirection:"row", justifyContent:"space-between", marginBottom:6 },
  sliderLabel:       { color:"rgba(255,255,255,0.5)", fontSize:12 },
  sliderVal:         { color:"#4A9FFF", fontSize:12, fontWeight:"700" },
  sliderTrack:       { height:4, backgroundColor:"rgba(255,255,255,0.08)", borderRadius:2, overflow:"hidden" },
  sliderFill:        { height:"100%" as any, backgroundColor:"#4A9FFF", borderRadius:2 },
  sliderThumb:       { display:"none" as any },
  sliderBtns:        { flexDirection:"row", gap:6, marginTop:4 },
  sliderAdjBtn:      { flex:1, paddingVertical:5, backgroundColor:"rgba(255,255,255,0.06)",
                       borderRadius:8, alignItems:"center", borderWidth:1,
                       borderColor:"rgba(255,255,255,0.08)" },
  sliderAdjText:     { color:"#4A9FFF", fontSize:16, fontWeight:"900" },
  exportPreview:     { height:120, borderRadius:14, overflow:"hidden", marginBottom:14 },
  exportImg:         { width:"100%", height:"100%" },
  exportPlaceholder: { flex:1, justifyContent:"center", alignItems:"center" },
  fmtGrid:           { flexDirection:"row", flexWrap:"wrap", gap:8, marginBottom:14 },
  fmtGridItem:       { width:"47%", flexDirection:"row", alignItems:"center", gap:8,
                       padding:10, borderRadius:12, backgroundColor:"rgba(255,255,255,0.04)",
                       borderWidth:1.5, borderColor:"rgba(255,255,255,0.07)" },
  fmtGridExt:        { color:"#fff", fontSize:13, fontWeight:"800" },
  fmtGridDesc:       { color:"rgba(255,255,255,0.3)", fontSize:10, marginTop:1 },
  fmtCheck:          { fontSize:12, fontWeight:"900" },
  fileCard:          { flexDirection:"row", alignItems:"center", gap:12,
                       backgroundColor:"rgba(255,255,255,0.04)", borderRadius:14,
                       padding:12, marginBottom:14, borderWidth:1,
                       borderColor:"rgba(255,255,255,0.07)" },
  fileCardIcon:      { width:42, height:42, borderRadius:10, justifyContent:"center",
                       alignItems:"center", flexShrink:0 },
  fileCardName:      { color:"#fff", fontSize:12, fontWeight:"800" },
  fileCardMeta:      { color:"rgba(255,255,255,0.35)", fontSize:11, marginTop:3 },
  shareGrid:         { flexDirection:"row", flexWrap:"wrap", gap:8, marginBottom:14 },
  shareGridItem:     { width:"30%", alignItems:"center", gap:5, padding:12,
                       borderRadius:12, backgroundColor:"rgba(255,255,255,0.04)",
                       borderWidth:1, borderColor:"rgba(255,255,255,0.07)" },
  shareGridName:     { color:"rgba(255,255,255,0.45)", fontSize:10, fontWeight:"700" },
  rowBtns:           { flexDirection:"row", gap:10, marginTop:4 },
  backStepBtn:       { justifyContent:"center", alignItems:"center",
                       backgroundColor:"rgba(255,255,255,0.07)", borderRadius:14,
                       paddingHorizontal:16, borderWidth:1,
                       borderColor:"rgba(255,255,255,0.1)" },
  backStepText:      { color:"rgba(255,255,255,0.6)", fontWeight:"800", fontSize:13 },
  nextBtn:           { paddingVertical:14, alignItems:"center", borderRadius:14 },
  nextBtnText:       { color:"#fff", fontSize:14, fontWeight:"900" },
  doneWrap:          { alignItems:"center", paddingVertical:24 },
  doneTitle:         { color:"#fff", fontSize:20, fontWeight:"900", marginBottom:8 },
  doneSub:           { color:"rgba(255,255,255,0.4)", fontSize:13, textAlign:"center",
                       lineHeight:20, marginBottom:20, paddingHorizontal:10 },
  doneEncBadge:      { backgroundColor:brandAlpha(0.08), borderRadius:12,
                       padding:12, marginBottom:24, borderWidth:1,
                       borderColor:brandAlpha(0.2), width:"100%" },
  doneEncText:       { color:BRAND_ACCENT, fontSize:12, fontWeight:"700", textAlign:"center" },
});
