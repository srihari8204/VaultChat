
export type CallState = 'idle' | 'calling' | 'incoming' | 'connected' | 'ended';
export type CallType = 'audio' | 'video' | 'screen';

export interface CallSession {
  id: string;
  contactId: string;
  contactName: string;
  contactEmoji: string;
  type: CallType;
  state: CallState;
  isAnonymous: boolean;
  startTime?: number;
  endTime?: number;
  duration?: number;
  isEncrypted: boolean;
  isMuted: boolean;
  isSpeaker: boolean;
  isCameraOn: boolean;
  isFrontCamera: boolean;
  isScreenSharing: boolean;
  timeLimitMinutes?: number;
}

export interface CallHistoryEntry {
  id: string;
  contactId: string;
  contactName: string;
  contactEmoji: string;
  type: CallType;
  direction: 'incoming' | 'outgoing' | 'missed';
  duration: number;
  timestamp: number;
  isAnonymous: boolean;
  isEncrypted: boolean;
}

type EventMap = {
  callStateChanged: CallSession;
  durationUpdate: number;
  callEnded: { session: CallSession; reason?: string };
};

class SimpleEmitter {
  private listeners: { [key: string]: Array<(data: any) => void> } = {};

  on(event: string, fn: (data: any) => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  off(event: string, fn: (data: any) => void) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter(f => f !== fn);
  }

  emit(event: string, data?: any) {
    if (!this.listeners[event]) return;
    this.listeners[event].forEach(fn => { try { fn(data); } catch(e) {} });
  }

  removeAllListeners(event?: string) {
    if (event) delete this.listeners[event];
    else this.listeners = {};
  }
}

class WebRTCService extends SimpleEmitter {
  private currentSession: CallSession | null = null;
  private callHistory: CallHistoryEntry[] = [];
  private timeLimitTimer: ReturnType<typeof setTimeout> | null = null;
  private durationTimer: ReturnType<typeof setInterval> | null = null;
  private currentDuration: number = 0;

  generateCallId(): string {
    return 'call_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  startCall(params: {
    contactId: string;
    contactName: string;
    contactEmoji: string;
    type: CallType;
    isAnonymous: boolean;
    timeLimitMinutes?: number;
  }): CallSession {
    if (this.currentSession) this.endCall('replaced');
    const session: CallSession = {
      id: this.generateCallId(),
      contactId: params.contactId,
      contactName: params.contactName,
      contactEmoji: params.contactEmoji,
      type: params.type,
      state: 'calling',
      isAnonymous: params.isAnonymous,
      isEncrypted: true,
      isMuted: false,
      isSpeaker: params.type !== 'audio',
      isCameraOn: params.type === 'video',
      isFrontCamera: true,
      isScreenSharing: false,
      timeLimitMinutes: params.timeLimitMinutes,
    };
    this.currentSession = session;
    this.emit('callStateChanged', { ...session });
    setTimeout(() => this.connectCall(), 2000 + Math.random() * 1000);
    return session;
  }

  private connectCall() {
    if (!this.currentSession) return;
    this.currentSession.state = 'connected';
    this.currentSession.startTime = Date.now();
    this.currentDuration = 0;
    this.emit('callStateChanged', { ...this.currentSession });
    this.durationTimer = setInterval(() => {
      this.currentDuration++;
      this.emit('durationUpdate', this.currentDuration);
    }, 1000);
    if (this.currentSession.timeLimitMinutes) {
      this.timeLimitTimer = setTimeout(() => {
        this.endCall('timelimit');
      }, this.currentSession.timeLimitMinutes * 60 * 1000);
    }
  }

  endCall(reason?: string) {
    if (!this.currentSession) return;
    if (this.durationTimer) { clearInterval(this.durationTimer); this.durationTimer = null; }
    if (this.timeLimitTimer) { clearTimeout(this.timeLimitTimer); this.timeLimitTimer = null; }
    this.currentSession.state = 'ended';
    this.currentSession.endTime = Date.now();
    this.currentSession.duration = this.currentDuration;
    const entry: CallHistoryEntry = {
      id: this.currentSession.id,
      contactId: this.currentSession.contactId,
      contactName: this.currentSession.isAnonymous ? 'Anonymous' : this.currentSession.contactName,
      contactEmoji: this.currentSession.isAnonymous ? '👻' : this.currentSession.contactEmoji,
      type: this.currentSession.type,
      direction: 'outgoing',
      duration: this.currentDuration,
      timestamp: Date.now(),
      isAnonymous: this.currentSession.isAnonymous,
      isEncrypted: this.currentSession.isEncrypted,
    };
    this.callHistory.unshift(entry);
    if (this.callHistory.length > 50) this.callHistory = this.callHistory.slice(0, 50);
    const endedSession = { ...this.currentSession };
    this.currentSession = null;
    this.currentDuration = 0;
    this.emit('callEnded', { session: endedSession, reason });
  }

  toggleMute(): boolean {
    if (!this.currentSession) return false;
    this.currentSession.isMuted = !this.currentSession.isMuted;
    this.emit('callStateChanged', { ...this.currentSession });
    return this.currentSession.isMuted;
  }

  toggleSpeaker(): boolean {
    if (!this.currentSession) return false;
    this.currentSession.isSpeaker = !this.currentSession.isSpeaker;
    this.emit('callStateChanged', { ...this.currentSession });
    return this.currentSession.isSpeaker;
  }

  toggleCamera(): boolean {
    if (!this.currentSession) return false;
    this.currentSession.isCameraOn = !this.currentSession.isCameraOn;
    this.emit('callStateChanged', { ...this.currentSession });
    return this.currentSession.isCameraOn;
  }

  switchCamera(): boolean {
    if (!this.currentSession) return false;
    this.currentSession.isFrontCamera = !this.currentSession.isFrontCamera;
    this.emit('callStateChanged', { ...this.currentSession });
    return this.currentSession.isFrontCamera;
  }

  toggleScreenShare(): boolean {
    if (!this.currentSession) return false;
    this.currentSession.isScreenSharing = !this.currentSession.isScreenSharing;
    if (this.currentSession.isScreenSharing) this.currentSession.isCameraOn = false;
    this.emit('callStateChanged', { ...this.currentSession });
    return this.currentSession.isScreenSharing;
  }

  getHistory(): CallHistoryEntry[] {
    return [...this.callHistory];
  }

  clearHistory() {
    this.callHistory = [];
  }

  getCurrentSession(): CallSession | null {
    return this.currentSession ? { ...this.currentSession } : null;
  }

  formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
}

export const webrtcService = new WebRTCService();
export default webrtcService;
