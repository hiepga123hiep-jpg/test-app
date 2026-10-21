const banner = document.getElementById('shared-listening-banner');
const bannerLabel = document.getElementById('shared-listening-label');
const inviteDialog = document.createElement('dialog');
inviteDialog.className = 'playlist-dialog shared-invite-dialog';
inviteDialog.innerHTML = `
  <form method="dialog">
    <span class="eyebrow">SPOTISIX · NGHE CHUNG</span>
    <h2>Tham gia nghe nhạc chung?</h2>
    <p id="shared-invite-copy"></p>
    <div class="dialog-actions">
      <button class="dialog-cancel" type="button" id="shared-invite-decline">Từ chối</button>
      <button class="dialog-submit" type="button" id="shared-invite-accept">Tham gia</button>
    </div>
  </form>`;
document.body.append(inviteDialog);

const inviteCopy = inviteDialog.querySelector('#shared-invite-copy');
const acceptInviteButton = inviteDialog.querySelector('#shared-invite-accept');
const declineInviteButton = inviteDialog.querySelector('#shared-invite-decline');
const clientId = globalThis.crypto?.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const peerConnections = new Map();
const pendingIceCandidates = new Map();
let discoveryChannel = null;
let ownSessionKey = null;
let roomChannel = null;
let roomId = null;
let roomRole = null;
let roomHostId = null;
let roomHostName = '';
let activeInvite = null;
let pendingInviteResponse = null;
let hostAudioStream = null;
let hostStateTimer = null;

window.setSharedListeningDiscoveryChannel = function setSharedListeningDiscoveryChannel(channel, sessionKey) {
  discoveryChannel = channel;
  ownSessionKey = sessionKey;
};

window.inviteForSharedListening = async function inviteForSharedListening(targetSessionKey, displayName) {
  if (!discoveryChannel || !ownSessionKey) {
    showAppToast('Bật tìm kiếm online trước khi mời người nghe chung.');
    return;
  }
  if (roomRole && roomRole !== 'host') {
    showAppToast('Chỉ chủ phòng mới có thể mời thêm người nghe.');
    return;
  }
  if (window.isKaraokeActive?.()) {
    showAppToast('Tắt karaoke trước khi mời nghe chung.');
    return;
  }
  if (!getHostAudioStream()) return;

  const inviteRoomId = roomId || globalThis.crypto?.randomUUID?.();
  if (!inviteRoomId) {
    showAppToast('Trình duyệt không hỗ trợ tạo phòng nghe chung an toàn.');
    return;
  }
  const inviteId = globalThis.crypto?.randomUUID?.() || `invite-${Date.now()}`;
  pendingInviteResponse = { inviteId, targetSessionKey, ownSessionKey, displayName, inviteRoomId };
  const timeoutId = window.setTimeout(() => {
    if (pendingInviteResponse?.inviteId !== inviteId) return;
    pendingInviteResponse.reject?.(new Error(`${displayName} chưa phản hồi lời mời nghe chung.`));
    pendingInviteResponse = null;
  }, 30000);

  try {
    const status = await discoveryChannel.send({
      type: 'broadcast',
      event: 'listen-invite',
      payload: {
        inviteId,
        roomId: inviteRoomId,
        targetSessionKey,
        fromSessionKey: ownSessionKey,
        fromName: getLocalDisplayName(),
      },
    });
    if (status !== 'ok') throw new Error(`Không thể gửi lời mời (${status || 'Realtime'}).`);
    const response = await new Promise((resolve, reject) => {
      pendingInviteResponse.resolve = resolve;
      pendingInviteResponse.reject = reject;
      pendingInviteResponse.timeoutId = timeoutId;
    });
    window.clearTimeout(timeoutId);
    pendingInviteResponse = null;
    if (!response.accepted) {
      showAppToast(`${displayName} đã từ chối lời mời nghe chung.`);
      return;
    }
    if (!roomChannel) {
      await joinRoom({
        roomId: inviteRoomId,
        role: 'host',
        hostId: clientId,
        hostName: getLocalDisplayName(),
      });
    } else {
      await sendRoomMessage('room-state', { snapshot: getSharedAudioTrackSnapshot() });
    }
  } catch (error) {
    window.clearTimeout(timeoutId);
    if (pendingInviteResponse?.inviteId === inviteId) pendingInviteResponse = null;
    showAppToast(error instanceof Error ? error.message : 'Không thể mời nghe chung.');
  }
};

window.receiveSharedListeningInvite = function receiveSharedListeningInvite(payload) {
  if (roomRole) {
    void respondToInvite(payload, false);
    showAppToast('Đang ở trong một phòng nghe chung; rời phòng hiện tại để tham gia phòng khác.');
    return;
  }
  activeInvite = payload;
  inviteCopy.textContent = `${payload.fromName || 'Một người dùng SpotiSix'} mời bạn nghe chung bài đang phát.`;
  if (!inviteDialog.open) inviteDialog.showModal();
};

window.receiveSharedListeningInviteResponse = function receiveSharedListeningInviteResponse(payload) {
  if (pendingInviteResponse?.inviteId !== payload.inviteId ||
      pendingInviteResponse.ownSessionKey !== payload.targetSessionKey ||
      pendingInviteResponse.targetSessionKey !== payload.fromSessionKey) return;
  pendingInviteResponse.resolve(payload);
};

acceptInviteButton.addEventListener('click', () => {
  if (!activeInvite) return;
  const invite = activeInvite;
  activeInvite = null;
  inviteDialog.close();
  void respondToInvite(invite, true);
  void joinRoom({
    roomId: invite.roomId,
    role: 'guest',
    hostId: null,
    hostName: invite.fromName || 'chủ phòng',
  }).catch(error => {
    showAppToast(error instanceof Error ? error.message : 'Không thể tham gia phòng nghe chung.');
  });
});

declineInviteButton.addEventListener('click', () => {
  if (!activeInvite) return;
  void respondToInvite(activeInvite, false);
  activeInvite = null;
  inviteDialog.close();
});

inviteDialog.addEventListener('click', event => {
  if (event.target === inviteDialog && activeInvite) {
    void respondToInvite(activeInvite, false);
    activeInvite = null;
  }
});

inviteDialog.addEventListener('cancel', event => {
  event.preventDefault();
  if (!activeInvite) return;
  void respondToInvite(activeInvite, false);
  activeInvite = null;
  inviteDialog.close();
});

window.leaveSharedListening = async function leaveSharedListening() {
  window.clearInterval(hostStateTimer);
  hostStateTimer = null;
  for (const connection of peerConnections.values()) connection.close();
  peerConnections.clear();
  pendingIceCandidates.clear();
  if (roomChannel) {
    const channel = roomChannel;
    roomChannel = null;
    await window.getNearbySupabaseClient?.()?.removeChannel(channel);
  }
  roomId = null;
  roomRole = null;
  roomHostId = null;
  roomHostName = '';
  hostAudioStream = null;
  banner.classList.add('hidden');
  window.clearSharedAudio?.();
};

window.isSharedListeningActive = () => Boolean(roomRole);

window.addEventListener('spotisix:playback-change', event => {
  if (roomRole === 'host' && roomChannel) {
    void sendRoomMessage('playback-state', { snapshot: event.detail });
  }
});

function getLocalDisplayName() {
  const name = document.querySelector('.user-name')?.textContent?.trim();
  return name || document.querySelector('.topbar-avatar')?.textContent?.trim() || 'SpotiSix';
}

function getSharedAudioTrackSnapshot() {
  const track = window.getSharedAudioTrack?.();
  if (!track) throw new Error('Không thể lấy thông tin bài hát đang phát.');
  return {
    title: track.title,
    artist: track.artist,
    album: track.album,
    img: track.img,
    duration: track.duration,
    currentTime: track.currentTime,
    isPlaying: track.isPlaying,
  };
}

function getHostAudioStream() {
  const track = window.getSharedAudioTrack?.();
  const audio = track?.audioElement;
  if (!track?.audioSrc || !audio?.src) {
    showAppToast('Để nghe chung thật, trước tiên nhập và phát một tệp nhạc của bạn.');
    return null;
  }
  try {
    if (!hostAudioStream) {
      if (typeof audio.captureStream === 'function') {
        hostAudioStream = audio.captureStream();
      } else if (typeof audio.mozCaptureStream === 'function') {
        hostAudioStream = audio.mozCaptureStream();
      } else {
        showAppToast('Trình duyệt này không hỗ trợ truyền âm thanh trực tiếp. Hãy thử Chrome hoặc Firefox.');
        return null;
      }
    }
    if (!hostAudioStream.getAudioTracks().some(track => track.readyState === 'live')) {
      hostAudioStream = null;
      showAppToast('Không lấy được luồng âm thanh của tệp đang phát. Hãy phát lại tệp rồi thử lại.');
      return null;
    }
    return hostAudioStream;
  } catch (error) {
    showAppToast(`Không thể chia sẻ âm thanh: ${error instanceof Error ? error.message : 'lỗi không xác định'}`);
    return null;
  }
}

async function respondToInvite(invite, accepted) {
  if (!discoveryChannel || !ownSessionKey) return;
  const status = await discoveryChannel.send({
    type: 'broadcast',
    event: 'listen-invite-response',
    payload: {
      inviteId: invite.inviteId,
      targetSessionKey: invite.fromSessionKey,
      fromSessionKey: ownSessionKey,
      accepted,
    },
  });
  if (status !== 'ok') showAppToast(`Không thể gửi phản hồi lời mời (${status || 'Realtime'}).`);
}

async function joinRoom({ roomId: requestedRoomId, role, hostId, hostName }) {
  if (roomChannel) await window.leaveSharedListening();
  const client = window.getNearbySupabaseClient?.();
  if (!client) throw new Error('Đăng nhập và kết nối Supabase trước khi mở phòng nghe chung.');
  if (role === 'host') hostAudioStream = getHostAudioStream();
  if (role === 'host' && !hostAudioStream) throw new Error('Không có luồng âm thanh để chia sẻ.');

  roomId = requestedRoomId;
  roomRole = role;
  roomHostId = hostId || null;
  roomHostName = hostName;
  const channel = client.channel(`spotisix:listen:${requestedRoomId}`, {
    config: { presence: { key: clientId } },
  });
  roomChannel = channel;
  channel.on('presence', { event: 'sync' }, updateRoomBanner);
  channel.on('presence', { event: 'sync' }, () => {
    if (roomRole === 'host') {
      for (const [key, entries] of Object.entries(channel.presenceState())) {
        if (key === clientId || !entries.some(entry => entry.role === 'guest')) continue;
        void createHostPeerConnection(key);
      }
    }
  });
  channel.on('presence', { event: 'join' }, ({ key }) => {
    if (roomRole === 'host' && key !== clientId) void createHostPeerConnection(key);
  });
  channel.on('presence', { event: 'leave' }, ({ key }) => {
    peerConnections.get(key)?.close();
    peerConnections.delete(key);
    pendingIceCandidates.delete(key);
    updateRoomBanner();
  });
  channel.on('broadcast', { event: 'signal' }, ({ payload }) => {
    if (payload?.targetId === clientId) void handleSignal(payload);
  });
  channel.on('broadcast', { event: 'playback-state' }, ({ payload }) => {
    if (roomRole === 'guest' && payload?.snapshot) window.applySharedPlaybackSnapshot?.(payload.snapshot);
  });
  channel.on('broadcast', { event: 'room-state' }, ({ payload }) => {
    if (roomRole === 'guest' && payload?.snapshot) window.applySharedPlaybackSnapshot?.(payload.snapshot);
  });
  try {
    await new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Kết nối phòng nghe chung hết thời gian chờ.')), 10000);
      channel.subscribe(status => {
        if (status === 'SUBSCRIBED') {
          window.clearTimeout(timeout);
          resolve();
        } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
          window.clearTimeout(timeout);
          reject(new Error(`Không thể kết nối phòng nghe chung (${status}).`));
        }
      });
    });
    const trackStatus = await channel.track({ displayName: getLocalDisplayName(), role });
    if (trackStatus !== 'ok') throw new Error(`Không thể kết nối phòng nghe chung (${trackStatus || 'Realtime'}).`);
    if (role === 'guest') {
      window.setSharedListeningRole?.('guest');
    } else {
      window.setSharedListeningRole?.('host');
      const snapshot = getSharedAudioTrackSnapshot();
      await sendRoomMessage('room-state', { snapshot });
      hostStateTimer = window.setInterval(() => {
        void sendRoomMessage('playback-state', { snapshot: getSharedAudioTrackSnapshot() });
      }, 1200);
    }
    updateRoomBanner();
    showAppToast(role === 'host' ? 'Đã tạo phòng nghe chung.' : `Đã tham gia nghe chung với ${hostName}.`);
  } catch (error) {
    window.clearInterval(hostStateTimer);
    hostStateTimer = null;
    for (const connection of peerConnections.values()) connection.close();
    peerConnections.clear();
    pendingIceCandidates.clear();
    roomChannel = null;
    roomId = null;
    roomRole = null;
    roomHostId = null;
    roomHostName = '';
    hostAudioStream = null;
    banner.classList.add('hidden');
    window.setSharedListeningRole?.(null);
    try {
      await client.removeChannel(channel);
    } catch (cleanupError) {
      console.error('Could not clean up a failed shared listening room.', cleanupError);
    }
    throw error;
  }
}

async function createHostPeerConnection(remoteClientId) {
  if (peerConnections.has(remoteClientId) || !hostAudioStream || !roomChannel) return;
  const connection = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
  peerConnections.set(remoteClientId, connection);
  hostAudioStream.getTracks().forEach(track => connection.addTrack(track, hostAudioStream));
  connection.onicecandidate = event => {
    if (event.candidate) void sendSignal(remoteClientId, { candidate: event.candidate });
  };
  connection.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(connection.connectionState)) {
      connection.close();
      peerConnections.delete(remoteClientId);
      pendingIceCandidates.delete(remoteClientId);
    }
  };
  try {
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await sendSignal(remoteClientId, { description: connection.localDescription });
  } catch (error) {
    connection.close();
    peerConnections.delete(remoteClientId);
    showAppToast(`Không thể kết nối âm thanh với người nghe: ${error instanceof Error ? error.message : 'lỗi WebRTC'}`);
  }
}

async function handleSignal(payload) {
  if (roomRole === 'host') {
    const connection = peerConnections.get(payload.fromId);
    if (!connection) return;
    try {
      if (payload.description?.type === 'answer') {
        await connection.setRemoteDescription(payload.description);
        await flushPendingIceCandidates(payload.fromId, connection);
      }
      if (payload.candidate) await addOrQueueIceCandidate(payload.fromId, connection, payload.candidate);
    } catch (error) {
      showAppToast(`Lỗi đồng bộ kết nối âm thanh: ${error instanceof Error ? error.message : 'WebRTC'}`);
    }
    return;
  }
  if (roomRole !== 'guest') return;
  let connection = peerConnections.get(payload.fromId);
  if (!connection) {
    connection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    peerConnections.set(payload.fromId, connection);
    connection.onicecandidate = event => {
      if (event.candidate) void sendSignal(payload.fromId, { candidate: event.candidate });
    };
    connection.ontrack = event => {
      void window.attachSharedAudioStream?.(event.streams[0]);
    };
  }
  try {
    if (payload.description?.type === 'offer') {
      await connection.setRemoteDescription(payload.description);
      await flushPendingIceCandidates(payload.fromId, connection);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      await sendSignal(payload.fromId, { description: connection.localDescription });
    }
    if (payload.candidate) await addOrQueueIceCandidate(payload.fromId, connection, payload.candidate);
  } catch (error) {
    showAppToast(`Không thể nhận âm thanh chung: ${error instanceof Error ? error.message : 'WebRTC'}`);
  }
}

async function addOrQueueIceCandidate(remoteId, connection, candidate) {
  if (!connection.remoteDescription) {
    const candidates = pendingIceCandidates.get(remoteId) || [];
    candidates.push(candidate);
    pendingIceCandidates.set(remoteId, candidates);
    return;
  }
  await connection.addIceCandidate(candidate);
}

async function flushPendingIceCandidates(remoteId, connection) {
  const candidates = pendingIceCandidates.get(remoteId) || [];
  pendingIceCandidates.delete(remoteId);
  for (const candidate of candidates) await connection.addIceCandidate(candidate);
}

async function sendSignal(targetId, signal) {
  if (!roomChannel) return;
  const status = await roomChannel.send({
    type: 'broadcast',
    event: 'signal',
    payload: { ...signal, fromId: clientId, targetId },
  });
  if (status !== 'ok') showAppToast(`Lỗi truyền tín hiệu âm thanh (${status || 'Realtime'}).`);
}

async function sendRoomMessage(event, payload) {
  if (!roomChannel) return;
  const status = await roomChannel.send({ type: 'broadcast', event, payload });
  if (status !== 'ok') showAppToast(`Không thể đồng bộ phòng nghe (${status || 'Realtime'}).`);
}

function updateRoomBanner() {
  if (!roomChannel) return;
  const members = Object.entries(roomChannel.presenceState())
    .filter(([key]) => key !== clientId)
    .flatMap(([, entries]) => entries)
    .map(entry => entry.displayName)
    .filter(Boolean);
  const names = roomRole === 'host'
    ? [...new Set(members)]
    : [roomHostName];
  bannerLabel.textContent = `Đang nghe nhạc chung với ${names.length ? names.join(', ') : 'đang chờ người tham gia'}`;
  banner.classList.remove('hidden');
}
