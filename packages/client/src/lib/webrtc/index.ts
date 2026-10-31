/**
 * Transport layer public API. Knows about peers and channels — never about
 * files, chunks, or keys.
 */
export { PeerConnection } from './connection.js';
export type { Route } from './connection.js';
export { DataChannelTransport } from './dataChannel.js';
export { RelayTransport } from './relayTransport.js';
export type { Transport, ChannelData } from './transport.js';
export { fetchIceConfig } from './iceClient.js';
export type { IceConfig } from './iceClient.js';
