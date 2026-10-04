// components/root/rootScreens.tsx — the root Stack's route declarations that
// take no theme value, moved out of app/_layout.tsx unchanged and in the same
// order. The root renders them right after its INSET_SCREENS map.
//
// An array, not a component: expo-router reads <Stack.Screen> elements straight
// from the Stack's children (it flattens arrays, not fragments or wrappers), so
// the fragment below is only a way to write them; its children are exported.

import { Children } from 'react';
import { Stack } from 'expo-router';

const declarations = (
  <>
    {/* Security — gesture disabled so user can't swipe back */}
    <Stack.Screen name="blocked" options={{ gestureEnabled: false }} />

    {/* Auth flow */}
    <Stack.Screen name="index" />
    {/* Main app — 6-tab navigation */}
    <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    <Stack.Screen name="chat" />
    <Stack.Screen name="join/[code]" options={{ headerShown: false }} />
    {/* Private Live invitation redeem — the /live/join/<code> link the host
        copies, and vaultchat://live/join/<code>. */}
    <Stack.Screen name="live/join/[code]" options={{ headerShown: false }} />
    <Stack.Screen name="videocall" />
    <Stack.Screen name="voicecall" />
    <Stack.Screen name="qr-contact" />
    <Stack.Screen name="add/[...segments]" options={{ headerShown: false }} />
    <Stack.Screen name="file-preview" />
    <Stack.Screen name="media-viewer" />
    <Stack.Screen name="whiteboard" />
    <Stack.Screen name="bookmarks" />
    {/* NOT declared here: `emergency-sos` is already registered by the
        INSET_SCREENS map in app/_layout.tsx. A SECOND <Stack.Screen> with the
        same name throws "Screen names must be unique" out of expo-router's
        withLayoutContext on every non-production build, and in production
        silently logs `No route named "emergency-sos" exists` because the
        first declaration has already consumed the route. */}
    <Stack.Screen name="receipt-control" />
    <Stack.Screen name="chat-themes" />
    <Stack.Screen name="chat-wallpaper" />
    <Stack.Screen name="chat-export" />
    <Stack.Screen name="in-chat-search" />
    <Stack.Screen name="message-reminder" />
    <Stack.Screen name="contact-info" />
    <Stack.Screen name="create-poll" />
    <Stack.Screen name="schedule-message" />
    <Stack.Screen name="broadcast" />
    <Stack.Screen name="media-gallery" />
    <Stack.Screen name="invite-link" />
    <Stack.Screen name="trusted-contacts" />
    <Stack.Screen name="login-history" />
    <Stack.Screen name="hidden-chats" />
    <Stack.Screen name="camera" options={{ headerShown: false, presentation: 'modal' }} />
    {/* status, calls now in (tabs) */}
    <Stack.Screen name="vault" />
    {/* alerts, profile now in (tabs) */}

    {/* Features */}
    <Stack.Screen name="contacts" />
    <Stack.Screen name="vault-features" />
    <Stack.Screen name="dashboard" />
    {/* The settings screen is NOT declared here — INSET_SCREENS in
        app/_layout.tsx already registers it, and that is the declaration
        carrying the status-bar padding it needs. It was declared in both
        places, which made expo-router throw "Screen names must be unique" out
        of useFilterScreenChildren. That error is FATAL: the app rendered a red
        error screen instead of booting, on every route. A bare second
        declaration adds nothing the map has not already done. */}
    <Stack.Screen name="story-viewer" />
    <Stack.Screen name="finance" options={{ headerShown: false }} />
    <Stack.Screen name="group-admin" />
    <Stack.Screen name="app-lock-chats" />
    <Stack.Screen name="privacy-dashboard" />
    <Stack.Screen name="storage-manager" />
    <Stack.Screen name="chat-backup" />
    <Stack.Screen name="last-seen-privacy" />
    <Stack.Screen name="offline-mode" />
    <Stack.Screen name="image-editor" />
    <Stack.Screen name="file-viewer" />
    <Stack.Screen name="reader" options={{ presentation: 'modal' }} />
    <Stack.Screen name="split" />
    <Stack.Screen name="shelf" />
    <Stack.Screen name="archive-viewer" />
    <Stack.Screen name="video-player" />
    <Stack.Screen name="group-calls" />
    <Stack.Screen name="group-info" />

    {/* Security & Privacy */}
    <Stack.Screen name="ghost-mode" />
    <Stack.Screen name="chat-code" />
    <Stack.Screen name="restore-backup" options={{ gestureEnabled: false }} />
    <Stack.Screen name="delete-account" />
    <Stack.Screen name="aiguardian" />
    <Stack.Screen name="backup-pin" />
    <Stack.Screen name="permissions" />

    {/* Social & Contacts */}
    <Stack.Screen name="communities" />
    <Stack.Screen name="create-group" />

    {/* Utility */}
    <Stack.Screen name="search" />
    <Stack.Screen name="scheduled" />
    <Stack.Screen name="perf-debug" />
    <Stack.Screen name="docscanner" />
    <Stack.Screen name="notifications" />
    <Stack.Screen name="location" />

    {/* Mini Apps destinations */}
    <Stack.Screen name="encrypted-notes" />
  </>
);

export const ROOT_SCREENS = Children.toArray(declarations.props.children);
