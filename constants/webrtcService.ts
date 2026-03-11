// VaultChat — WebRTC Service (Jitsi-based, works in Expo Go)

export interface CallSession {
  roomId: string;
  contactName: string;
  startTime: Date;
  duration: number;
  type: "video" | "audio";
}

export interface CallHistoryEntry {
  id: string;
  contactName: string;
  duration: number;
  timestamp: Date;
  type: "video" | "audio";
  missed: boolean;
}

class WebRTCService {
  private callHistory: CallHistoryEntry[] = [];

  generateRoomId(contactId: string): string {
    return `vaultchat-${contactId}-${Date.now()}`;
  }

  addToHistory(entry: CallHistoryEntry): void {
    this.callHistory.unshift(entry);
    if (this.callHistory.length > 50) this.callHistory.pop();
  }

  getHistory(): CallHistoryEntry[] {
    return this.callHistory;
  }

  clearHistory(): void {
    this.callHistory = [];
  }

  formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  }
}

const webrtcService = new WebRTCService();
export default webrtcService;
