// components/live/useStageOrientation.ts — the panel turns for a landscape share.
//
// Moved out of app/live-view.tsx unchanged.

import { useEffect } from 'react';

export function useStageOrientation({
  onStage, stageReady, stageIsScreen, stageFrame, mainStream,
}: {
  onStage: boolean;
  stageReady: boolean;
  stageIsScreen: boolean;
  /** Memoised upstream: a fresh object per render would re-issue lockAsync forever. */
  stageFrame: { width: number; height: number } | undefined;
  mainStream: string | null | undefined;
}) {
  /**
   * ORIENTATION FOLLOWS THE CONTENT — for PUBG and Free Fire, mostly.
   *
   * The app is portrait-locked in app.json AND in AndroidManifest, which is
   * right for every other screen and ruinous here: a landscape mobile game
   * shared onto a portrait phone is a strip across the middle with two thirds
   * of the panel black, and no amount of fit or fill can rescue it. Nothing can
   * — a landscape picture does not go into a portrait hole. The panel has to
   * turn.
   *
   * So a landscape SHARE turns the viewer's phone, exactly as a fullscreen
   * video player does, and turns it back on the way out. `lockAsync` overrides
   * the manifest at runtime (app/video-player.tsx has relied on that for as
   * long as it has existed) and it also overrides the viewer's own rotation
   * lock, which unlocking would not.
   *
   * SCREEN SHARES ONLY, and that restriction is load-bearing. A camera track
   * reports its CAPTURE geometry — the Honor's front camera arrives as
   * 1280x720 while it draws 720x1280 — so keying on any video track would spin
   * the phone sideways for an ordinary face. Screen capture carries no such
   * rotation, measured at 1200x2664 on the same handset, so it can be trusted.
   *
   * HLS is left UNLOCKED rather than guessed at: the composite is a landscape
   * canvas whatever the publisher was, so locking to it would turn the phone
   * for a portrait broadcast. Unlocked, the viewer turns it themselves and
   * everything downstream — the fit, the corner, the zoom pan — re-decides.
   */
  useEffect(() => {
    if (onStage || !stageReady) return;
    let dead = false;
    (async () => {
      const O = await import('expo-screen-orientation');
      if (dead) return;
      try {
        // Only a screen share may speak for the panel. See above.
        const frame = stageIsScreen ? stageFrame : undefined;
        if (frame) {
          await O.lockAsync(frame.width > frame.height
            ? O.OrientationLock.LANDSCAPE
            : O.OrientationLock.PORTRAIT_UP);
        } else if (!mainStream) {
          // HLS with no share reported: a camera broadcast, whose canvas is
          // landscape by construction and says nothing about the publisher.
          // Unlocked rather than guessed at — the viewer may still turn it.
          await O.unlockAsync();
        } else {
          await O.lockAsync(O.OrientationLock.PORTRAIT_UP);
        }
      } catch {}
    })();
    return () => { dead = true; };
  }, [onStage, stageReady, stageIsScreen, stageFrame, mainStream]);

  /**
   * AND ALWAYS BACK TO PORTRAIT ON THE WAY OUT.
   *
   * Separate from the effect above and deliberately dependency-free: leaving a
   * landscape game share must restore the rest of the app whatever the stage
   * was doing at the time, including when the screen unmounts mid-rotation.
   */
  useEffect(() => () => {
    // UNLOCK, do not re-lock to portrait.
    //
    // This re-locked PORTRAIT_UP on the way out, which was correct while the
    // whole app was portrait-only: it restored the app default. Now that
    // rotation is unlocked app-wide, re-locking would leave every screen AFTER
    // a broadcast stuck in portrait until the app restarted — the stage would
    // quietly become a global setting. Unlocking restores the real default.
    void import('expo-screen-orientation')
      .then(O => O.unlockAsync())
      .catch(() => {});
  }, []);
}
