const nearbyDialog = document.getElementById('nearby-dialog');
const scanButton = document.getElementById('nearby-scan-button');
const cancelButton = document.getElementById('nearby-cancel-button');
const radar = document.getElementById('nearby-radar');
const nearbyStatus = document.getElementById('nearby-status');
const nearbyList = document.getElementById('nearby-list');
const peers = new Map();
const nearbySignalThreshold = -78;
let displayName = '';
let scanning = false;
let starting = false;
let peerListener = null;
let pruneTimer = null;
let cancelButtonTimer = null;
let discoverySession = 0;
let nearbyBluetooth = null;
let pluginLoadPromise = null;
let realtimeChannel = null;
let nativeDiscoveryActive = false;

function isNativeApp() {
  return Boolean(window.Capacitor?.isNativePlatform?.() || window.Capacitor?.isNative);
}

async function loadNearbyBluetooth() {
  if (!isNativeApp()) return null;
  if (!pluginLoadPromise) {
    pluginLoadPromise = Promise.all([
      import('@capacitor/core'),
      import('@spotisix/nearby-bluetooth'),
    ]).then(([, pluginModule]) => {
      nearbyBluetooth = pluginModule.NearbyBluetooth;
      return nearbyBluetooth;
    }).catch(error => {
      pluginLoadPromise = null;
      throw error;
    });
  }
  return pluginLoadPromise;
}

window.openNearbyDialog = function openNearbyDialog() {
  nearbyDialog.showModal();
  if (!isNativeApp()) {
    document.getElementById('nearby-title').textContent = 'Người dùng online';
    setStatus('Tìm người dùng SpotiSix đang online ở mọi nơi.');
    document.querySelector('.nearby-description').textContent = 'Kết nối với người đang mở SpotiSix và chủ động bật tìm kiếm.';
    document.querySelector('.nearby-privacy-note').textContent = 'Khi bật tìm kiếm, tên hiển thị của bạn sẽ được chia sẻ với người dùng SpotiSix khác đang tìm kiếm. Kết nối qua Internet, không giới hạn khoảng cách Bluetooth. Đóng cửa sổ hoặc nhấn “Hủy tìm kiếm” để ngừng chia sẻ.';
    nearbyList.setAttribute('aria-label', 'Người dùng SpotiSix đang tìm kiếm online');
  } else {
    document.getElementById('nearby-title').textContent = 'Người dùng online & ở gần';
    setStatus('Tìm người dùng SpotiSix online; Bluetooth cũng tìm thiết bị ở gần.');
    document.querySelector('.nearby-description').textContent = 'Kết nối online với người đang tìm kiếm ở bất kỳ đâu; BLE bổ sung phát hiện thiết bị ở gần.';
    document.querySelector('.nearby-privacy-note').textContent = 'Khi bật tìm kiếm, tên hiển thị của bạn được chia sẻ với người dùng SpotiSix khác đang tìm kiếm. Ứng dụng native cũng phát tên qua Bluetooth để tìm thiết bị ở gần. Đóng cửa sổ hoặc nhấn “Hủy tìm kiếm” để ngừng chia sẻ và quét.';
    nearbyList.setAttribute('aria-label', 'Người dùng SpotiSix đang tìm kiếm');
  }
};

window.closeNearbyDialog = function closeNearbyDialog() {
  nearbyDialog.close();
};

nearbyDialog.addEventListener('click', event => {
  if (event.target === nearbyDialog) nearbyDialog.close();
});

nearbyDialog.addEventListener('close', () => {
  if (scanning || starting) void stopNearbyDiscovery();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && (scanning || starting)) void stopNearbyDiscovery();
});

window.setNearbyIdentity = function setNearbyIdentity(name) {
  displayName = typeof name === 'string' ? name.trim().slice(0, 40) : '';
  if (!displayName && (scanning || starting)) void stopNearbyDiscovery();
};

window.startNearbyDiscovery = async function startNearbyDiscovery() {
  if (starting || scanning) return;
  if (!displayName) {
    setStatus('Đăng nhập để dùng tên hiển thị khi tìm người ở gần.');
    return;
  }
  const supabase = window.getNearbySupabaseClient?.();
  if (!supabase) {
    setStatus('Không thể kết nối dịch vụ online. Kiểm tra cấu hình Supabase và tải lại ứng dụng.');
    return;
  }

  const session = ++discoverySession;
  starting = true;
  peers.clear();
  renderPeers();
  setScannerVisibility(true);
  scanButton.disabled = true;
  setStatus('Đang kết nối với người dùng SpotiSix online…');
  cancelButtonTimer = window.setTimeout(() => {
    if (session !== discoverySession) return;
    if (peers.size === 0) {
      cancelButton.classList.remove('hidden');
      setStatus(isNativeApp()
        ? 'Chưa thấy ai, tiếp tục tìm online và quét Bluetooth ở gần…'
        : 'Chưa thấy người online, vẫn tiếp tục tìm kiếm…');
    }
  }, 3000);
  try {
    await startOnlineDiscovery(supabase, session);
    if (session !== discoverySession) return;
    if (document.hidden) {
      await stopNearbyDiscovery();
      return;
    }
    if (isNativeApp()) {
      try {
        const plugin = await loadNearbyBluetooth();
        if (session !== discoverySession) return;
        if (!peerListener) peerListener = await plugin.addListener('nearbyPeer', updateNearbyPeer);
        if (session !== discoverySession) return;
        await plugin.startDiscovery({ displayName });
        nativeDiscoveryActive = true;
        pruneTimer = window.setInterval(removeExpiredPeers, 3000);
        if (session !== discoverySession) {
          await stopNativeDiscovery();
          return;
        }
      } catch (error) {
        if (session !== discoverySession) return;
        setStatus(`Tìm online vẫn hoạt động, nhưng không thể bật Bluetooth: ${error instanceof Error ? error.message : 'lỗi không xác định'}`);
      }
    }
  } catch (error) {
    if (session === discoverySession) {
      scanning = false;
      if (realtimeChannel) {
        const channel = realtimeChannel;
        realtimeChannel = null;
        window.setSharedListeningDiscoveryChannel?.(null, null);
        try {
          const result = await supabase?.removeChannel(channel);
          if (result !== 'ok') throw new Error(`Realtime trả về trạng thái ${result || 'không xác định'}.`);
        } catch (cleanupError) {
          console.error('Không thể dọn kênh tìm kiếm online sau lỗi.', cleanupError);
        }
      }
      window.clearTimeout(cancelButtonTimer);
      cancelButtonTimer = null;
      cancelButton.classList.add('hidden');
      setScannerVisibility(false);
      setStatus(error instanceof Error ? error.message : 'Không thể bắt đầu tìm người ở gần.');
    }
  } finally {
    if (session === discoverySession) {
      starting = false;
      scanButton.disabled = false;
    }
  }
};

window.stopNearbyDiscovery = async function stopNearbyDiscovery() {
  if (!scanning && !starting) return;
  const wasScanning = scanning;
  const wasStarting = starting;
  discoverySession++;
  scanning = false;
  starting = false;
  window.clearInterval(pruneTimer);
  pruneTimer = null;
  window.clearTimeout(cancelButtonTimer);
  cancelButtonTimer = null;
  setScannerVisibility(false);
  scanButton.disabled = false;
  cancelButton.classList.add('hidden');
  if (!wasScanning && !wasStarting) return;
  const stopErrors = [];
  if (realtimeChannel) {
    const channel = realtimeChannel;
    realtimeChannel = null;
    try {
      const result = await window.getNearbySupabaseClient?.()?.removeChannel(channel);
      if (result !== 'ok') throw new Error(`Realtime trả về trạng thái ${result || 'không xác định'}.`);
    } catch (error) {
      stopErrors.push(error instanceof Error ? `Realtime: ${error.message}` : 'Không thể ngắt kết nối realtime.');
    }
  }
  const bluetoothError = await stopNativeDiscovery();
  if (bluetoothError) stopErrors.push(`Bluetooth: ${bluetoothError}`);
  peers.clear();
  renderPeers();
  if (stopErrors.length) {
    setStatus(`Đã dừng giao diện tìm kiếm nhưng có lỗi khi ngắt dịch vụ: ${stopErrors.join(' ')}`);
  } else {
    setStatus('Đã dừng tìm kiếm. Tên của bạn không còn được chia sẻ.');
  }
};

async function stopNativeDiscovery() {
  if (!nearbyBluetooth || !nativeDiscoveryActive) return null;
  try {
    await nearbyBluetooth.stopDiscovery();
    nativeDiscoveryActive = false;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Không thể dừng Bluetooth.';
  }
}

async function startOnlineDiscovery(supabase, session) {
  const sessionKey = globalThis.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const channel = supabase.channel('spotisix:online-discovery', {
    config: { presence: { key: sessionKey } },
  });
  realtimeChannel = channel;
  channel.on('presence', { event: 'sync' }, () => {
    if (session === discoverySession) syncOnlinePeers(channel, sessionKey);
  });
  window.setSharedListeningDiscoveryChannel?.(channel, sessionKey);
  channel.on('broadcast', { event: 'listen-invite' }, ({ payload }) => {
    if (session === discoverySession && payload?.targetSessionKey === sessionKey) {
      window.receiveSharedListeningInvite?.(payload);
    }
  });
  channel.on('broadcast', { event: 'listen-invite-response' }, ({ payload }) => {
    if (session === discoverySession && payload?.targetSessionKey === sessionKey) {
      window.receiveSharedListeningInviteResponse?.(payload);
    }
  });
  const subscription = new Promise((resolve, reject) => {
    channel.subscribe(status => {
      if (status === 'SUBSCRIBED') resolve();
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        reject(new Error(`Không thể kết nối tìm kiếm online (${status}).`));
      }
    });
  });
  await subscription;
  if (session !== discoverySession) return;
  const trackStatus = await channel.track({ displayName });
  if (trackStatus !== 'ok') {
    throw new Error(`Không thể hiển thị bạn trong danh sách online (${trackStatus || 'lỗi realtime'}).`);
  }
  if (session !== discoverySession) return;
  scanning = true;
  cancelButton.classList.remove('hidden');
  syncOnlinePeers(channel, sessionKey);
  setStatus(peers.size
    ? `Đang kết nối với ${peers.size} người dùng SpotiSix.`
    : 'Đang chờ người dùng SpotiSix khác bật tìm kiếm…');
}

function syncOnlinePeers(channel, ownSessionKey) {
  for (const [peerId, peer] of peers) {
    if (peer.source !== 'ble') peers.delete(peerId);
  }
  const presence = channel.presenceState();
  for (const [sessionKey, entries] of Object.entries(presence)) {
    if (sessionKey === ownSessionKey) continue;
    const entry = entries.find(item => typeof item.displayName === 'string' && item.displayName.trim());
    if (!entry) continue;
    peers.set(`online:${sessionKey}`, {
      displayName: entry.displayName.trim(),
      sessionKey,
      lastSeen: Date.now(),
      source: 'online',
    });
  }
  if (peers.size > 0) cancelButton.classList.remove('hidden');
  setStatus(peers.size
    ? `Đang kết nối với ${peers.size} người dùng SpotiSix.`
    : 'Đang chờ người dùng SpotiSix khác bật tìm kiếm…');
  renderPeers();
}

function updateNearbyPeer(peer) {
  if (!scanning || typeof peer?.peerId !== 'string' || typeof peer.displayName !== 'string') return;
  if (Number.isFinite(peer.rssi) && peer.rssi < nearbySignalThreshold) return;
  const name = peer.displayName.trim();
  if (!name) return;
  peers.set(`ble:${peer.peerId}`, { displayName: name, lastSeen: Date.now(), source: 'ble' });
  cancelButton.classList.remove('hidden');
  setStatus(peers.size === 1 ? 'Đã tìm thấy người dùng SpotiSix.' : `Đã tìm thấy ${peers.size} người dùng SpotiSix.`);
  renderPeers();
}

function removeExpiredPeers() {
  const expiresBefore = Date.now() - 15000;
  for (const [peerId, peer] of peers) {
    if (peer.source === 'ble' && peer.lastSeen < expiresBefore) peers.delete(peerId);
  }
  if (scanning && peers.size === 0) setStatus('Chưa thấy người dùng, vẫn tiếp tục tìm kiếm…');
  renderPeers();
}

function renderPeers() {
  nearbyList.replaceChildren();
  for (const peer of peers.values()) {
    const item = document.createElement('li');
    item.className = 'nearby-peer';
    const avatar = document.createElement('span');
    avatar.className = 'nearby-peer-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = peer.displayName.charAt(0).toUpperCase();
    const name = document.createElement('span');
    name.className = 'nearby-peer-name';
    name.textContent = peer.displayName;
    item.append(avatar, name);
    if (peer.source === 'online' && peer.sessionKey) {
      const invite = document.createElement('button');
      invite.type = 'button';
      invite.className = 'nearby-listen-invite';
      invite.textContent = 'Mời nghe chung';
      invite.addEventListener('click', () => {
        window.inviteForSharedListening?.(peer.sessionKey, peer.displayName);
      });
      item.append(invite);
    }
    nearbyList.append(item);
  }
}

function setScannerVisibility(visible) {
  radar.classList.toggle('hidden', !visible);
  scanButton.classList.toggle('hidden', visible);
}

function setStatus(message) {
  nearbyStatus.textContent = message;
}
