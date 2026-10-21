import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface NearbyPeer {
  peerId: string;
  displayName: string;
  rssi: number;
}

export interface NearbyBluetoothPlugin {
  startDiscovery(options: { displayName: string }): Promise<void>;
  stopDiscovery(): Promise<void>;
  addListener(
    eventName: 'nearbyPeer',
    listenerFunc: (peer: NearbyPeer) => void,
  ): Promise<PluginListenerHandle>;
}

export const NearbyBluetooth = registerPlugin<NearbyBluetoothPlugin>('NearbyBluetooth');
