// Web shim for the native WebRTC module (@livekit/react-native-webrtc).
// On web, use browser-native WebRTC APIs instead of the native module.

import React = require('react');

const root = globalThis as any;

const RTCPeerConnection =
  typeof root.window !== 'undefined'
    ? root.window.RTCPeerConnection
      || root.window.webkitRTCPeerConnection
      || root.window.mozRTCPeerConnection
    : class {};

const RTCIceCandidate =
  typeof root.window !== 'undefined' ? root.window.RTCIceCandidate : class {};

const RTCSessionDescription =
  typeof root.window !== 'undefined' ? root.window.RTCSessionDescription : class {};

const MediaStream =
  typeof root.window !== 'undefined' ? root.window.MediaStream : class {};

const mediaDevices =
  typeof root.navigator !== 'undefined' && root.navigator.mediaDevices
    ? root.navigator.mediaDevices
    : { getUserMedia: () => Promise.reject(new Error('Not supported')) };

type RTCViewProps = {
  streamURL?: unknown;
  style?: unknown;
};

// RTCView is native-only; on web, use a <video> element instead.
// This stub prevents the requireNativeComponent crash.
const RTCView = React.forwardRef<any, RTCViewProps>((props, ref) => {
  const videoRef = React.useRef<any>(null);

  React.useEffect(() => {
    if (videoRef.current && props.streamURL) {
      try {
        if (typeof props.streamURL === 'object') {
          videoRef.current.srcObject = props.streamURL;
        } else {
          videoRef.current.src = props.streamURL;
        }
      } catch {}
    }
  }, [props.streamURL]);

  return React.createElement('video', {
    ref: (node: any) => {
      videoRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    autoPlay: true,
    playsInline: true,
    style: props.style || { width: '100%', height: '100%' },
  });
});

RTCView.displayName = 'RTCView';

const RTCPIPView = RTCView;

export = {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  RTCView,
  RTCPIPView,
  MediaStream,
  mediaDevices,
  registerGlobals: () => {},
};
