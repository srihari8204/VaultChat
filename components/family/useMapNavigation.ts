// components/family/useMapNavigation.ts — MY OWN turn-by-turn on the family
// map, moved out of app/family-map.tsx unchanged: the session wiring around
// lib/nav/navigationService, the follow camera, reroute failures and the
// one-shot camera reset when a journey ends.
//
// The REAL navigation loop (GPS, adaptive haptic timeline, voice per the
// user's nav settings, missed-turn reroute) renders on the map through
// NavigationLayer. Left running on navigate-away on purpose; STOP (or the
// trip ending) ends it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { startNavigation, stopNavigation, forceReroute, useNavBanner } from '../../lib/nav/navigationService';
import { loadNavSettings } from '../../lib/nav/navSettings';
import { cameraForManeuver, type CameraPlan } from '../../lib/nav/navPresentation';
import { type MeetDestination } from './MeetHereSheet';

export function useMapNavigation(destination: MeetDestination | null) {
  /** True while a navigation session started FROM THIS SCREEN is running —
   *  so ending the trip stops OUR guidance and never someone's unrelated
   *  Navigate-app session. */
  const navHere = useRef(false);
  /** What the navigation dock calls the place we are going. A member route
   *  has no `destination` object, so the name has to travel separately. */
  const [navTargetName, setNavTargetName] = useState<string | null>(null);
  // Warm the nav settings once: the member turn cue reads them synchronously.
  useEffect(() => { loadNavSettings().catch(() => {}); }, []);

  const navBanner = useNavBanner();
  /**
   * AUTO-FOLLOW. On by default while guiding; the map reports the user's own
   * pan/rotate/pinch (FamilyMap onUserMove) and we step out of the way rather
   * than fighting the gesture. The Follow control puts it back — an explicit
   * way in, instead of waiting out the map's silent 10 s timeout.
   */
  const [following, setFollowing] = useState(true);
  /** A reroute that came back empty, so the UI can offer a manual retry
   *  instead of looping. Cleared the moment a fresh route arrives. */
  const [rerouteFailed, setRerouteFailed] = useState(false);
  /**
   * The camera band from the previous frame. Passing it back into
   * cameraForManeuver is what applies the hysteresis — without it the zoom
   * oscillates every time the distance wobbles across a band edge.
   */
  const camRef = useRef<CameraPlan | null>(null);
  const camera = useMemo(() => {
    if (!navBanner.active) { camRef.current = null; return null; }
    const next = cameraForManeuver(navBanner.distanceToManeuver, navBanner.remainingM, camRef.current);
    camRef.current = next;
    return next;
  }, [navBanner.active, navBanner.distanceToManeuver, navBanner.remainingM]);
  // A new route (or the session ending) clears a stale failure.
  useEffect(() => { if (!navBanner.rerouting) setRerouteFailed(false); }, [navBanner.rerouting]);
  // Re-arm follow whenever a session starts, so a previous journey's manual
  // pan does not leave the next one un-followed.
  useEffect(() => { if (navBanner.active) setFollowing(true); }, [navBanner.active]);
  /**
   * PUT THE CAMERA BACK WHEN THE JOURNEY ENDS.
   *
   * Found on the Honor: navigation leaves the map in the pitched, heading-up
   * chase camera, and ending the session used to leave it there — the map
   * stayed rotated with no journey to justify it, which reads as broken. The
   * cameraMode prop is declarative, so simply dropping to `undefined` changes
   * nothing (FamilyMap keeps its last mode); it has to be told 'north' once.
   *
   * One-shot, and only after a session we actually ran: passing 'north'
   * permanently would override the camera the user chose themselves on a map
   * they never navigated from.
   */
  const wasNavigating = useRef(false);
  const [resetCam, setResetCam] = useState(false);
  useEffect(() => {
    if (wasNavigating.current && !navBanner.active) {
      setResetCam(true);
      const t = setTimeout(() => setResetCam(false), 900);
      wasNavigating.current = false;
      return () => clearTimeout(t);
    }
    wasNavigating.current = navBanner.active;
  }, [navBanner.active]);

  /** Start real turn-by-turn to any point. `startNav` below is the Meet-Here
   *  destination form of this and is unchanged; member routes use it directly
   *  with the member's CURRENT position, which is the honest target — a person
   *  is not a fixed point, and a reroute picks up their newer fix. */
  const startNavTo = async (name: string, lat: number, lng: number) => {
    try {
      const s = await loadNavSettings();
      await startNavigation({
        to: { lat, lng },
        profile: s.profile, mode: s.mode, timing: s.timing,
        costing: s.costing, custom: s.custom, routeOpts: s.routeOpts,
      });
      navHere.current = true;
      setNavTargetName(name);
    } catch (e) {
      Alert.alert('Navigation', (e as { message?: string } | null)?.message ?? 'Could not start navigation.');
    }
  };
  const startNav = async () => {
    if (!destination) return;
    await startNavTo(destination.name, destination.lat, destination.lng);
  };
  const stopNav = () => { stopNavigation(); navHere.current = false; setNavTargetName(null); };
  /** The trip is over — guidance started for it (from here) stops with it. */
  const stopIfOurs = useCallback(() => {
    if (navHere.current) { stopNavigation(); navHere.current = false; }
  }, []);
  const reroute = () => {
    setRerouteFailed(false);
    forceReroute().catch(() => setRerouteFailed(true));
  };

  return {
    navBanner, camera, following, setFollowing, rerouteFailed, reroute, resetCam,
    navTargetName, startNavTo, startNav, stopNav, stopIfOurs,
  };
}
