// Re-exports from canonical config. Do not edit the URL here.
export { SERVER_URL } from '../constants/server';
import { SERVER_URL } from '../constants/server';
export const WS_URL = SERVER_URL.replace(/^http/, 'ws');
