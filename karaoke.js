const toggle = document.getElementById('karaoke-toggle');
const dialog = document.getElementById('karaoke-dialog');
const vocalSlider = document.getElementById('karaoke-vocal');
const vocalValue = document.getElementById('karaoke-vocal-value');
const statusText = document.getElementById('karaoke-status');
const lyricsContainer = document.getElementById('karaoke-lyrics');
const lyricsDialog = document.getElementById('lyrics-dialog');
const lyricsTrackLabel = document.getElementById('lyrics-track-label');
const lyricsStatus = document.getElementById('lyrics-status');
const lyricsLinesContainer = document.getElementById('lyrics-lines');
const player = document.getElementById('audio-player');
let karaoke = null;
let lyrics = [];
let lyricLookupKey = '';
let lyricsRequestId = 0;
let activeLyricIndex = -1;
let currentFileUrl = '';
let processing = false;
let activeTrackUrl = '';

window.toggleKaraoke = function toggleKaraoke() {
  if (karaoke) {
    stopKaraoke();
    return;
  }
  if (!activeTrackUrl) return;
  if (!dialog.open) dialog.showModal();
  void startKaraoke();
};

window.closeKaraokeDialog = function closeKaraokeDialog() {
  if (dialog.open) dialog.close();
  if (!karaoke) stopKaraoke();
};

dialog.addEventListener('click', event => {
  if (event.target === dialog) window.closeKaraokeDialog();
});
dialog.addEventListener('cancel', () => {
  if (!karaoke) stopKaraoke();
});

lyricsDialog.addEventListener('click', event => {
  if (event.target === lyricsDialog) window.closeLyrics();
});
lyricsDialog.addEventListener('cancel', window.closeLyrics);
window.toggleLyrics = function toggleLyrics(event) {
  event?.stopPropagation();
  if (lyricsDialog.open) {
    window.closeLyrics();
    return;
  }
  lyricsDialog.showModal();
  document.getElementById('lyrics-toggle').setAttribute('aria-expanded', 'true');
  const track = window.getSharedAudioTrack?.();
  if (track) void loadLyrics(track.title, track.artist);
};
window.closeLyrics = function closeLyrics() {
  if (lyricsDialog.open) lyricsDialog.close();
  document.getElementById('lyrics-toggle').setAttribute('aria-expanded', 'false');
};
window.addEventListener('spotisix:track-change', event => {
  const track = event.detail;
  if (!track?.title || !track?.artist) return;
  lyricsRequestId++;
  activeLyricIndex = -1;
  lyricLookupKey = '';
  lyrics = [];
  lyricsTrackLabel.textContent = `${track.title} · ${track.artist}`;
  lyricsLinesContainer.replaceChildren();
  lyricsStatus.textContent = 'Đang tìm lời bài hát…';
  lyricsStatus.classList.remove('hidden');
  if (lyricsDialog.open) void loadLyrics(track.title, track.artist);
});

vocalSlider.addEventListener('input', () => {
  vocalValue.textContent = `${vocalSlider.value}%`;
  if (karaoke) karaoke.vocalGain.gain.value = Number(vocalSlider.value) / 100;
});

player.addEventListener('play', () => void syncStemPlayback(true));
player.addEventListener('play', () => window.setTimeout(updateKaraokeAvailability, 0));
player.addEventListener('pause', () => void syncStemPlayback(false));
player.addEventListener('timeupdate', () => {
  syncStemPosition();
  renderCurrentLyric();
});
player.addEventListener('seeked', syncStemPosition);
player.addEventListener('ended', () => void syncStemPlayback(false));
player.addEventListener('loadedmetadata', updateKaraokeAvailability);
player.addEventListener('emptied', updateKaraokeAvailability);

function updateKaraokeAvailability() {
  const track = window.getSharedAudioTrack?.();
  activeTrackUrl = track?.audioSrc || '';
  toggle.disabled = !activeTrackUrl || window.isSharedListeningActive?.() || processing;
  toggle.title = activeTrackUrl ? 'Hát karaoke' : 'Nhập tệp nhạc để bật karaoke';
  if (karaoke && currentFileUrl !== activeTrackUrl) stopKaraoke();
}
window.updateKaraokeAvailability = updateKaraokeAvailability;

async function startKaraoke() {
  if (window.isSharedListeningActive?.()) {
    setStatus('Hãy rời phòng nghe chung trước khi bật karaoke.');
    return;
  }
  const track = window.getSharedAudioTrack?.();
  if (!track?.audioSrc) {
    setStatus('Karaoke chỉ khả dụng với tệp nhạc bạn đã tải lên. Hãy nhập một tệp âm thanh trước.');
    return;
  }
  if (processing) return;
  toggle.disabled = true;
  vocalSlider.disabled = true;
  try {
    const stems = await requestStems(track.audioSrc);
    if (!dialog.open || window.getSharedAudioTrack?.().audioSrc !== track.audioSrc) return;
    await activateStems(stems, track.audioSrc);
    await loadLyrics(track.title, track.artist);
    toggle.classList.add('karaoke-active');
    toggle.setAttribute('aria-pressed', 'true');
    setStatus('Đã tách vocal và beat. Kéo thanh vocal về 0% để tắt hoàn toàn giọng ca sĩ.');
  } catch (error) {
    stopKaraoke();
    setStatus(error.message || 'Không thể xử lý tệp karaoke.');
  } finally {
    vocalSlider.disabled = !karaoke;
    updateKaraokeAvailability();
  }
}

async function requestStems(fileUrl) {
  const client = window.getNearbySupabaseClient?.();
  if (!client) throw new Error('Không thể kết nối dịch vụ. Hãy tải lại trang và đăng nhập.');
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw new Error(`Không thể kiểm tra đăng nhập: ${sessionError.message}`);
  if (!sessionData.session) throw new Error('Đăng nhập để sử dụng karaoke.');

  let response;
  try {
    response = await fetch(fileUrl);
  } catch {
    throw new Error('Không thể đọc tệp âm thanh. Hãy nhập lại tệp từ thiết bị của bạn.');
  }
  if (!response.ok) throw new Error('Không thể đọc tệp âm thanh đã tải lên.');
  const file = await response.blob();
  if (!file.type.startsWith('audio/')) throw new Error('Định dạng tệp này không được hỗ trợ.');
  if (!file.size || file.size > 25 * 1024 * 1024) throw new Error('Tệp karaoke phải nhỏ hơn hoặc bằng 25 MB.');

  processing = true;
  setStatus('Đang gửi tệp và tách vocal/beat. Có thể mất vài phút...');
  let objectPath = '';
  try {
    const extension = String(file.name || '').match(/\.(mp3|wav|m4a|flac|ogg|aac)$/i)?.[0] || '';
    objectPath = `${sessionData.session.user.id}/${crypto.randomUUID()}${extension}`;
    const { error: uploadError } = await client.storage.from('karaoke-inputs').upload(objectPath, file, {
      contentType: file.type,
      upsert: false,
    });
    if (uploadError) throw new Error(`Không thể tải tệp karaoke lên: ${uploadError.message}`);
    let started;
    try {
      const result = await client.functions.invoke('karaoke', { body: { objectPath } });
      if (result.error) throw new Error(result.data?.error || result.error.message);
      started = result.data;
    } catch (error) {
      const { error: cleanupError } = await client.storage.from('karaoke-inputs').remove([objectPath]);
      if (cleanupError) console.error('Could not remove an interrupted karaoke upload.', cleanupError);
      throw error;
    }
    if (!started?.jobId) throw new Error(started?.error || 'Dịch vụ không trả về mã xử lý karaoke.');

    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise(resolve => window.setTimeout(resolve, 2000));
      const { data, error } = await client.functions.invoke('karaoke', {
        body: { action: 'status', jobId: started.jobId },
      });
      if (error) throw new Error(data?.error || error.message);
      if (data?.status === 'succeeded' && data.vocalsUrl && data.instrumentalUrl) return data;
      if (data?.status === 'failed' || data?.status === 'canceled') {
        throw new Error(data.error || 'Không thể tách vocal từ tệp này.');
      }
      if (data?.error) throw new Error(data.error);
    }
    throw new Error('Tách vocal đang mất nhiều thời gian. Hãy thử lại sau.');
  } finally {
    processing = false;
  }
}

async function activateStems(stems, fileUrl) {
  stopStems();
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) throw new Error('Trình duyệt này không hỗ trợ phát karaoke.');
  const context = new AudioContextConstructor();
  const vocalAudio = createStemAudio(stems.vocalsUrl);
  const instrumentalAudio = createStemAudio(stems.instrumentalUrl);
  const vocalGain = context.createGain();
  const instrumentalGain = context.createGain();
  vocalGain.gain.value = Number(vocalSlider.value) / 100;
  instrumentalGain.gain.value = 1;
  for (const [audio, gain] of [[vocalAudio, vocalGain], [instrumentalAudio, instrumentalGain]]) {
    const source = context.createMediaElementSource(audio);
    source.connect(gain);
    gain.connect(context.destination);
  }
  karaoke = { context, vocalAudio, instrumentalAudio, vocalGain, fileUrl };
  currentFileUrl = fileUrl;
  window.setKaraokeMuted?.(true);
  if (context.state === 'suspended') await context.resume();
  await Promise.all([waitForMetadata(vocalAudio), waitForMetadata(instrumentalAudio)]);
  vocalSlider.disabled = false;
  syncStemPosition();
  if (!player.paused) await syncStemPlayback(true);
}

function createStemAudio(url) {
  const audio = new Audio();
  audio.crossOrigin = 'anonymous';
  audio.preload = 'auto';
  audio.src = url;
  return audio;
}

function waitForMetadata(audio) {
  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    audio.addEventListener('loadedmetadata', resolve, { once: true });
    audio.addEventListener('error', () => reject(new Error('Không thể tải stem karaoke. Kiểm tra kết nối mạng rồi thử lại.')), { once: true });
  });
}

async function syncStemPlayback(shouldPlay) {
  if (!karaoke) return;
  if (shouldPlay) {
    for (const audio of [karaoke.vocalAudio, karaoke.instrumentalAudio]) {
      try {
        await audio.play();
      } catch (error) {
        setStatus(`Không thể phát stem karaoke: ${error.message}`);
      }
    }
  } else {
    karaoke.vocalAudio.pause();
    karaoke.instrumentalAudio.pause();
  }
}

function syncStemPosition() {
  if (!karaoke) return;
  if (currentFileUrl !== window.getSharedAudioTrack?.().audioSrc) {
    stopKaraoke();
    setStatus('Đã đổi bài hát; bật karaoke lại cho tệp mới.');
    return;
  }
  const time = player.currentTime;
  for (const audio of [karaoke.vocalAudio, karaoke.instrumentalAudio]) {
    if (Number.isFinite(time) && Math.abs(audio.currentTime - time) > 0.35) {
      try {
        audio.currentTime = time;
      } catch {
        setStatus('Không thể đồng bộ stem karaoke với bài hát.');
      }
    }
  }
}

function stopKaraoke() {
  stopStems();
  window.setKaraokeMuted?.(false);
  vocalSlider.disabled = true;
  toggle.classList.remove('karaoke-active');
  toggle.setAttribute('aria-pressed', 'false');
  lyricsContainer.textContent = 'Lyrics sẽ hiển thị tại đây.';
  if (dialog.open) dialog.close();
  updateKaraokeAvailability();
}

function stopStems() {
  if (!karaoke) return;
  karaoke.vocalAudio.pause();
  karaoke.instrumentalAudio.pause();
  karaoke.vocalAudio.removeAttribute('src');
  karaoke.instrumentalAudio.removeAttribute('src');
  void karaoke.context.close();
  karaoke = null;
  currentFileUrl = '';
}

async function loadLyrics(title, artist) {
  const key = `${title}|${artist}`;
  if (lyricLookupKey === key) return;
  lyricLookupKey = key;
  const requestId = ++lyricsRequestId;
  lyrics = [];
  activeLyricIndex = -1;
  lyricsTrackLabel.textContent = `${title} · ${artist}`;
  lyricsLinesContainer.replaceChildren();
  lyricsLinesContainer.classList.remove('has-synced-lines');
  lyricsStatus.textContent = 'Đang tìm lời bài hát…';
  lyricsStatus.classList.remove('hidden');
  lyricsContainer.textContent = 'Đang tìm lyrics...';
  try {
    const params = new URLSearchParams({ track_name: title, artist_name: artist });
    const response = await fetch(`https://lrclib.net/api/get?${params}`);
    if (!response.ok && response.status !== 404) throw new Error(`LRCLIB trả về lỗi ${response.status}.`);
    let result = response.ok ? await response.json() : null;
    if (!hasLyrics(result)) {
      const searchResponse = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(title)}`);
      if (!searchResponse.ok) throw new Error(`LRCLIB trả về lỗi ${searchResponse.status}.`);
      const matches = await searchResponse.json();
      const wantedTitle = normalizeLyricsText(title);
      result = matches.find(item => normalizeLyricsText(item.trackName || '') === wantedTitle && hasLyrics(item)) || null;
    }
    if (requestId !== lyricsRequestId) return;
    if (!result) {
      lyricsStatus.textContent = 'Không tìm thấy lời bài hát cho bản nhạc này.';
      lyricsContainer.textContent = 'Không tìm thấy lyrics cho bài hát này.';
      return;
    }
    lyrics = parseSyncedLyrics(result.syncedLyrics || '');
    if (lyrics.length) {
      renderLyricsList();
      lyricsStatus.textContent = 'Lời bài hát sẽ sáng theo thời điểm phát.';
      renderCurrentLyric();
    } else if (result.plainLyrics) {
      renderPlainLyrics(result.plainLyrics);
      lyricsStatus.textContent = 'Bản lời này không có mốc thời gian để đồng bộ.';
      lyricsContainer.textContent = result.plainLyrics;
    } else {
      lyricsStatus.textContent = 'Không có lời bài hát cho bản nhạc này.';
      lyricsContainer.textContent = 'Không có lyrics cho bài hát này.';
    }
  } catch (error) {
    if (requestId !== lyricsRequestId) return;
    lyricsStatus.textContent = `Không tải được lời bài hát: ${error.message}`;
    lyricsContainer.textContent = `Không tải được lyrics: ${error.message}`;
  }
}

function hasLyrics(result) {
  return Boolean(result?.syncedLyrics || result?.plainLyrics);
}

function normalizeLyricsText(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLocaleLowerCase();
}

function parseSyncedLyrics(text) {
  const entries = [];
  text.split(/\r?\n/).forEach(rawLine => {
    const timestamps = [...rawLine.matchAll(/\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
    const text = rawLine.replace(/(?:\[\d{2}:\d{2}(?:\.\d{1,3})?\])+/g, '').trim();
    timestamps.forEach(([, minutes, seconds, fraction = '0']) => {
      entries.push({
        time: Number(minutes) * 60 + Number(seconds) + Number(`0.${fraction}`),
        text,
      });
    });
  });
  return entries.sort((first, second) => first.time - second.time);
}

function renderCurrentLyric() {
  if (!lyrics.length) return;
  const index = lyrics.findLastIndex(line => line.time <= player.currentTime);
  const activeIndex = index >= 0 ? index : 0;
  const line = lyrics[activeIndex];
  lyricsContainer.textContent = line.text || '♪';
  if (activeLyricIndex === activeIndex) return;
  activeLyricIndex = activeIndex;
  const rows = lyricsLinesContainer.querySelectorAll('.lyrics-line');
  rows.forEach((row, rowIndex) => row.classList.toggle('active', rowIndex === activeIndex));
  rows[activeIndex]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function renderLyricsList() {
  const fragment = document.createDocumentFragment();
  lyrics.forEach(line => {
    const row = document.createElement('p');
    row.className = 'lyrics-line';
    row.textContent = line.text || '♪';
    row.addEventListener('click', () => {
      player.currentTime = line.time;
      renderCurrentLyric();
    });
    fragment.appendChild(row);
  });
  lyricsLinesContainer.replaceChildren(fragment);
  lyricsLinesContainer.classList.add('has-synced-lines');
  activeLyricIndex = -1;
}

function renderPlainLyrics(text) {
  const fragment = document.createDocumentFragment();
  text.split(/\r?\n/).filter(line => line.trim()).forEach(line => {
    const row = document.createElement('p');
    row.className = 'lyrics-line';
    row.textContent = line.trim();
    fragment.appendChild(row);
  });
  lyricsLinesContainer.replaceChildren(fragment);
}

function setStatus(message) {
  statusText.textContent = message;
}

dialog.addEventListener('close', () => {
  if (!karaoke) window.setKaraokeMuted?.(false);
});

updateKaraokeAvailability();
window.isKaraokeActive = () => Boolean(karaoke || processing || toggle.disabled);
