// Web shim for the native WebRTC module (@livekit/react-native-webrtc).
// On web, use browser-native WebRTC APIs instead of the native module.
//
// Filename kept as-is: it describes what it shims (a react-native-webrtc-shaped
// module), and metro maps the import name to this path explicitly.

const RTCPeerConnection =
  typeof window !== 'undefined'
    ? window.RTCPeerConnection ||
      window.webkitRTCPeerConnection ||
      window.mozRTCPeerConnection
    : class {};

const RTCIceCandidate =
  typeof window !== 'undefined' ? window.RTCIceCandidate : class {};

const RTCSessionDescription =
  typeof window !== 'undefined' ? window.RTCSessionDescription : class {};

const MediaStream =
  typeof window !== 'undefined' ? window.MediaStream : class {};

const mediaDevices =
  typeof navigator !== 'undefined' && navigator.mediaDevices
    ? navigator.mediaDevices
    : { getUserMedia: () => Promise.reject(new Error('Not supported')) };

// RTCView is native-only; on web, use a <video> element instead.
// This stub prevents the requireNativeComponent crash.
const React = require('react');
const RTCView = React.forwardRef((props, ref) => {
  const videoRef = React.useRef(null);

  React.useEffect(() => {
    if (videoRef.current && props.streamURL) {
      try {
        // streamURL may be a MediaStream object or a blob URL
        if (typeof props.streamURL === 'object') {
          videoRef.current.srcObject = props.streamURL;
        } else {
          videoRef.current.src = props.streamURL;
        }
      } catch (_) {}
    }
  }, [props.streamURL]);

  return React.createElement('video', {
    ref: videoRef,
    autoPlay: true,
    playsInline: true,
    style: props.style || { width: '100%', height: '100%' },
  });
});

RTCView.displayName = 'RTCView';

const RTCPIPView = RTCView;

module.exports = {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  RTCView,
  RTCPIPView,
  MediaStream,
  mediaDevices,
  registerGlobals: () => {},
};
