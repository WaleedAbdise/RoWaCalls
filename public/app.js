import { videoFilters } from './video-filters.js';

const el = id => document.getElementById(id);
const names = { waleed: 'Waleed Abdullah', roha: 'Roha Nadeem' };
const seals = { waleed: '🦭♂️', roha: '🦭💕' };
let account;
let partner;
let current = null;
let incoming = null;
let busy = false;
let polling = false;
let actionVersion = 0;
let lastPoll = Date.now();
let audioContext;
let lastRing = 0;
let ringingMode;
let ringGain;
let nativeFullscreen = false;
let galleryRequest = 0;
let heartRequest = 0;
let heartUsage;
let heartCallActive = false;
const minuteMs = 60000;
let cameraTest = null;
const videoQuality = { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15 } };

async function api(path, data) {
  const response = await fetch('/api/' + path, data === undefined ? {
    signal: AbortSignal.timeout(8000)
  } : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    keepalive: path === 'logout' || data.action === 'end'
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status });
  return result;
}

function notice(id, message = '') {
  el(id).textContent = message;
  el(id).hidden = !message;
}

function setAccount(user) {
  account = user;
  lastPoll = Date.now();
  el('login').hidden = !!user;
  el('room').hidden = !user;
  el('logout').hidden = !user;
  if (!user) {
    resetGallery();
    heartRequest++;
    heartUsage = null;
    heartCallActive = false;
    renderHeart();
    closeCameraTest();
    cleanup();
    incoming = null;
    renderCall();
    return;
  }
  const partnerId = user === 'waleed' ? 'roha' : 'waleed';
  partner = names[partnerId];
  el('partner').textContent = `${partner} ${seals[partnerId]}`;
  el('avatar').textContent = '🦭';
  el('avatar').dataset.partner = partnerId;
  el('welcome').textContent = `Signed in as ${names[user]} ${seals[user]}`;
  void loadGallery();
  void refreshHeart();
}

function renderHeart() {
  const data = heartUsage;
  const estimate = data ? Math.min(data.runningMs, Math.max(0, performance.now() - data.receivedAt)) : 0;
  const used = data ? Math.min(data.limitMs, data.usedMs + estimate) : 0;
  const minutes = Math.floor(used / minuteMs);
  const milestone = minutes >= 3000 ? 5000 : minutes >= 1000 ? 3000 : 1000;
  const meter = el('heart-meter');
  el('heart-liquid').style.setProperty('--fill', `${Math.min(100, 100 * used / (milestone * minuteMs))}%`);
  el('heart-cap').hidden = !data || milestone <= data.limitMs / minuteMs;
  if (data) {
    el('heart-cap').textContent = `Monthly call limit · ${(data.limitMs / minuteMs).toLocaleString()} minutes`;
  }
  el('heart-minutes').textContent = data
    ? `${minutes.toLocaleString()} ${minutes === 1 ? 'minute' : 'minutes'}`
    : 'Checking call time…';
  meter.setAttribute('aria-valuenow', String(minutes));
  meter.setAttribute('aria-valuetext', data
    ? `${minutes} shared minutes this month`
    : 'Loading this month’s call time');
  meter.setAttribute('aria-valuemax', String(milestone));
}

async function refreshHeart() {
  if (!account) return;
  const request = ++heartRequest;
  try {
    const data = await api('usage');
    if (request !== heartRequest) return;
    heartUsage = { ...data, receivedAt: performance.now() };
    renderHeart();
  } catch {
    if (request === heartRequest && !heartUsage) el('heart-minutes').textContent = 'Call time temporarily unavailable';
  }
}

function resetGallery() {
  galleryRequest++;
  el('photo-viewer').close();
  el('photo-full').removeAttribute('src');
  el('gallery-track').replaceChildren();
  el('gallery-window').hidden = true;
  el('gallery-toggle').hidden = true;
  el('gallery-empty').hidden = false;
}

async function loadGallery() {
  resetGallery();
  const request = galleryRequest;
  const photos = await api('gallery').catch(() => []);
  if (request !== galleryRequest || !photos.length) return;

  const window = el('gallery-window');
  const track = el('gallery-track');
  const toggle = el('gallery-toggle');
  const animated = photos.length > 1;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const group = document.createElement('div');
  group.className = 'gallery-group';
  const count = animated ? Math.ceil(6 / photos.length) * photos.length : 1;
  for (let index = 0; index < count; index++) {
    const image = document.createElement('img');
    image.src = photos[index % photos.length];
    image.alt = '';
    image.decoding = 'async';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'gallery-photo';
    button.dataset.photo = String(index % photos.length + 1);
    button.setAttribute('aria-label', `Open photo ${button.dataset.photo}`);
    if (index >= photos.length) {
      button.classList.add('gallery-repeat');
      button.tabIndex = -1;
      button.setAttribute('aria-hidden', 'true');
    }
    button.append(image);
    group.append(button);
  }
  track.append(group);
  if (animated) {
    const copy = group.cloneNode(true);
    copy.classList.add('gallery-copy');
    copy.setAttribute('aria-hidden', 'true');
    for (const button of copy.querySelectorAll('button')) button.tabIndex = -1;
    track.append(copy);
  }
  window.classList.toggle('gallery-animated', animated);
  window.classList.remove('gallery-paused');
  toggle.textContent = 'Pause gallery';
  toggle.hidden = !animated || reducedMotion.matches;
  window.hidden = false;
  el('gallery-empty').hidden = true;
}

el('gallery-track').onclick = event => {
  const button = event.target.closest('.gallery-photo');
  if (!button || !account) return;
  const viewer = el('photo-viewer');
  el('photo-full').src = button.querySelector('img').src;
  el('photo-caption').textContent = `Our little memories · Photo ${button.dataset.photo}`;
  viewer.showModal();
};
el('photo-viewer').addEventListener('close', () => {
  el('photo-full').removeAttribute('src');
});

el('gallery-toggle').onclick = () => {
  const paused = el('gallery-window').classList.toggle('gallery-paused');
  el('gallery-toggle').textContent = paused ? 'Resume gallery' : 'Pause gallery';
};

function unlockRing() {
  if (!window.AudioContext) return;
  try {
    if (!audioContext) {
      audioContext = new AudioContext();
      audioContext.onstatechange = updateRing;
    }
    if (audioContext.state !== 'running') void audioContext.resume().then(updateRing).catch(() => {});
  } catch {
    // The visual incoming-call controls are available regardless of audio support.
  }
}

function updateRing() {
  const running = audioContext?.state === 'running';
  el('enable-ringer').hidden = !window.AudioContext || running;
  const mode = current?.ringing ? 'outgoing' : !busy && !current && incoming ? 'incoming' : null;
  if (mode !== ringingMode || !running) {
    ringGain?.disconnect();
    ringGain = null;
    lastRing = 0;
    ringingMode = mode;
  }
  if (!running || !mode || Date.now() - lastRing < 2800) return;
  lastRing = Date.now();
  if (!ringGain) {
    ringGain = audioContext.createGain();
    ringGain.connect(audioContext.destination);
  }
  const notes = mode === 'incoming' ? [[0, 587], [.24, 784], [.48, 880]] : [[0, 440], [.28, 480]];
  for (const [offset, frequency] of notes) {
    const start = audioContext.currentTime + offset;
    const tone = audioContext.createOscillator();
    const gain = audioContext.createGain();
    tone.frequency.value = frequency;
    gain.gain.setValueAtTime(.001, start);
    gain.gain.exponentialRampToValueAtTime(mode === 'incoming' ? .16 : .09, start + .03);
    gain.gain.exponentialRampToValueAtTime(.001, start + .2);
    tone.connect(gain).connect(ringGain);
    tone.onended = () => gain.disconnect();
    tone.start(start);
    tone.stop(start + .21);
  }
}

function renderCall() {
  const invite = !current && incoming;
  const call = current || invite;
  el('dial').hidden = !!call;
  el('call-panel').hidden = !call;
  el('incoming-controls').hidden = !invite;
  el('active-controls').hidden = !current;
  const video = current?.mode === 'video' && !!current.stream;
  el('stage').hidden = !video;
  el('video-tools').hidden = !video;
  el('swap-video').disabled = !video || el('local-frame').hidden;
  el('filter-panel').hidden = !current?.connectedAt;
  el('camera').hidden = current?.mode !== 'video';
  el('flip-camera').hidden = !video;
  for (const id of ['voice', 'video', 'accept', 'decline', 'hangup', 'logout']) el(id).disabled = busy;
  el('mute').disabled = !current?.stream;
  el('camera').disabled = !current?.stream || !!current.switchingCamera;
  el('flip-camera').disabled = !current?.videoSender || !!current.switchingCamera;
  updateRing();
  if (!call) return;
  const type = call.mode === 'video' ? 'video' : 'voice';
  const prefix = type[0].toUpperCase() + type.slice(1);
  el('call-title').textContent = invite ? `Incoming ${type} call` : `${prefix} call with ${partner}`;
  const status = invite ? `${partner} is calling.` : current.status;
  if (el('call-status').textContent !== status) el('call-status').textContent = status;
}

function cleanup() {
  if (current) {
    const old = current;
    current = null;
    clearTimeout(old.cutoff);
    old.pc?.close();
    old.stream?.getTracks().forEach(track => track.stop());
  }
  for (const id of ['local', 'remote', 'remote-audio']) el(id).srcObject = null;
  el('local').hidden = true;
  el('local-frame').hidden = true;
  el('filter-panel').open = false;
  el('filter-target').value = 'local';
  el('filter-choice').value = 'none';
  notice('filter-notice');
  for (const id of ['local-filter', 'remote-filter']) {
    el(id).hidden = true;
    el(id).style.removeProperty('--sticker-x');
    el(id).style.removeProperty('--sticker-y');
  }
  setSwapped(false);
  setFullscreen(false);
  updateRing();
  el('play').hidden = true;
  el('mute').setAttribute('aria-pressed', 'false');
  el('camera').setAttribute('aria-pressed', 'false');
  el('mute').textContent = 'Mute';
  el('camera').textContent = 'Turn camera off';
  notice('camera-notice');
}

function setSwapped(swapped) {
  el('stage').classList.toggle('swapped', swapped);
  el('swap-video').setAttribute('aria-pressed', String(swapped));
}

function setFullscreen(fullscreen) {
  const panel = el('call-panel');
  document.body.classList.toggle('call-immersive', fullscreen);
  panel.classList.toggle('call-fullscreen', fullscreen);
  el('fullscreen').setAttribute('aria-pressed', String(fullscreen));
  el('fullscreen').textContent = fullscreen ? 'Exit fullscreen' : 'Fullscreen';
  if (!fullscreen && document.fullscreenElement === panel) void document.exitFullscreen().catch(() => {});
}

el('fullscreen').onclick = () => {
  const fullscreen = !el('call-panel').classList.contains('call-fullscreen');
  setFullscreen(fullscreen);
  if (fullscreen) void el('call-panel').requestFullscreen?.().catch(() => {});
};
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement === el('call-panel')) {
    nativeFullscreen = true;
    if (!current) setFullscreen(false);
  } else if (nativeFullscreen) {
    nativeFullscreen = false;
    setFullscreen(false);
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && el('call-panel').classList.contains('call-fullscreen')) setFullscreen(false);
});
el('swap-video').onclick = () => setSwapped(!el('stage').classList.contains('swapped'));

function filterValue(target) {
  if (target === 'local') return current?.localFilter || 'none';
  return current?.remoteFilter || current?.partnerFilter || 'none';
}

function drawFilters() {
  for (const target of ['local', 'remote']) {
    const sticker = el(target + '-filter');
    const filter = filterValue(target);
    sticker.hidden = filter === 'none';
    if (sticker.dataset.filter !== filter) {
      sticker.dataset.filter = filter;
      sticker.textContent = videoFilters[filter].art;
    }
  }
  el('filter-choice').value = filterValue(el('filter-target').value);
}

for (const [id, filter] of Object.entries(videoFilters)) {
  el('filter-choice').add(new Option(filter.name, id));
}
el('filter-target').onchange = () => {
  notice('filter-notice');
  drawFilters();
};
el('filter-choice').onchange = async event => {
  const call = current;
  if (!call) return;
  const choice = event.target;
  const filter = choice.value;
  notice('filter-notice');
  if (el('filter-target').value === 'remote') {
    call.remoteFilter = filter;
    drawFilters();
    return;
  }
  choice.disabled = true;
  try {
    await send(call, 'filter', { filter });
    if (call === current) call.localFilter = filter;
  } catch (error) {
    if (call === current) notice('filter-notice', describe(error));
  } finally {
    choice.disabled = false;
    if (call === current) drawFilters();
  }
};

for (const id of ['local-filter', 'remote-filter']) {
  const sticker = el(id);
  sticker.onpointerdown = event => sticker.setPointerCapture(event.pointerId);
  sticker.onpointermove = event => {
    if (!sticker.hasPointerCapture(event.pointerId)) return;
    const frame = sticker.parentElement.getBoundingClientRect();
    const percent = (position, size) => Math.min(92, Math.max(8, 100 * position / size)) + '%';
    sticker.style.setProperty('--sticker-x', percent(event.clientX - frame.left, frame.width));
    sticker.style.setProperty('--sticker-y', percent(event.clientY - frame.top, frame.height));
  };
}

async function playRemote() {
  const call = current;
  if (!call) return;
  const media = el(call.mode === 'video' ? 'remote' : 'remote-audio');
  try {
    await media.play();
    if (call === current) el('play').hidden = true;
  } catch {
    if (call === current) el('play').hidden = false;
  }
}

function send(call, action, data = {}) {
  return api('call', { action, id: call.id, ...data });
}

function scheduleCutoff(call, { remainingMs, cutoffMessage }) {
  if (call.cutoff || !Number.isFinite(remainingMs)) return;
  call.cutoff = setTimeout(() => {
    if (call !== current) return;
    cleanup();
    notice('room-notice', cutoffMessage);
    renderCall();
  }, remainingMs);
}

async function capture(constraints, stillNeeded) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Open ROWA Calls over HTTPS in Safari, Chrome, or another browser with camera support.');
  let expired = false;
  const mediaRequest = navigator.mediaDevices.getUserMedia(constraints).then(stream => {
    if (expired || !stillNeeded()) {
      stream.getTracks().forEach(track => track.stop());
      throw new Error('Camera or microphone request cancelled.');
    }
    return stream;
  });
  let deadline;
  try {
    return await Promise.race([mediaRequest, new Promise((_, reject) => {
      deadline = setTimeout(() => {
        expired = true;
        reject(new Error('Device access timed out. Check the browser’s permission prompt and try again.'));
      }, 20000);
    })]);
  } finally {
    clearTimeout(deadline);
  }
}

async function captureDefault(audio, video, stillNeeded) {
  try {
    return await capture({ audio, video: video && { ...videoQuality, facingMode: { ideal: 'user' } } }, stillNeeded);
  } catch (error) {
    if (!video || !stillNeeded() || !['NotReadableError', 'OverconstrainedError'].includes(error.name)) throw error;
    return capture({ audio, video: true }, stillNeeded);
  }
}

function closeCameraTest() {
  const old = cameraTest;
  cameraTest = null;
  old?.stream?.getTracks().forEach(track => track.stop());
  el('test-video').srcObject = null;
  el('test-video').hidden = true;
  el('camera-test').hidden = true;
}

el('close-camera-test').onclick = closeCameraTest;
el('test-camera').onclick = async () => {
  if (cameraTest) return;
  const test = {};
  cameraTest = test;
  el('camera-test').hidden = false;
  el('camera-test-status').textContent = 'Checking camera permission…';
  try {
    test.stream = await captureDefault(false, true, () => cameraTest === test);
    if (cameraTest !== test) return;
    const video = el('test-video');
    video.srcObject = test.stream;
    video.hidden = false;
    await video.play();
    if (cameraTest === test) el('camera-test-status').textContent = 'Camera is working. Only you can see this preview.';
  } catch (error) {
    if (cameraTest === test) el('camera-test-status').textContent = describe(error);
  }
};

async function capVideo(sender) {
  try {
    const parameters = sender.getParameters();
    if (!parameters.encodings.length) return;
    parameters.encodings[0].maxBitrate = 350000;
    await sender.setParameters(parameters);
  } catch {
    // Browsers that reject the bitrate hint still use the lower capture resolution.
  }
}

function showCallCamera(enabled) {
  el('local').hidden = !enabled;
  el('local-frame').hidden = !enabled;
  if (!enabled) setSwapped(false);
  el('camera').textContent = enabled ? 'Turn camera off' : 'Turn camera on';
  el('camera').setAttribute('aria-pressed', String(!enabled));
}

async function changeCamera(call, flip) {
  if (call.switchingCamera) return;
  const previous = call.stream.getVideoTracks()[0];
  const settings = previous?.getSettings() || {};
  const oldDevice = settings.deviceId || call.cameraDevice;
  const oldFacing = settings.facingMode || call.cameraFacing || 'user';
  const mobile = !!settings.facingMode || matchMedia('(pointer: coarse)').matches;
  const nextFacing = oldFacing === 'environment' ? 'user' : 'environment';
  call.switchingCamera = true;
  notice('camera-notice');
  renderCall();
  let nextTrack;
  try {
    let selection = oldDevice ? { deviceId: { exact: oldDevice } } : { facingMode: { ideal: oldFacing } };
    if (flip) {
      if (mobile) {
        selection = { facingMode: { exact: nextFacing } };
      } else {
        const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput');
        const index = devices.findIndex(device => device.deviceId === oldDevice);
        const other = devices.length > 1 ? devices[(index + 1) % devices.length] : null;
        if (!other?.deviceId || other.deviceId === oldDevice) throw new Error('No second camera is available on this device.');
        selection = { deviceId: { exact: other.deviceId } };
      }
    }
    if (call !== current) return;
    previous?.stop();
    const stream = await capture({ video: { ...videoQuality, ...selection }, audio: false }, () => call === current);
    [nextTrack] = stream.getVideoTracks();
    await installCamera(call, previous, nextTrack);
    call.cameraFacing = nextTrack.getSettings().facingMode || (flip && mobile ? nextFacing : oldFacing);
  } catch (error) {
    nextTrack?.stop();
    if (call !== current) return;
    if (previous?.readyState !== 'live') {
      try {
        const video = oldDevice ? { deviceId: { exact: oldDevice } } : { facingMode: { ideal: oldFacing } };
        const restored = await capture({ video, audio: false }, () => call === current);
        [nextTrack] = restored.getVideoTracks();
        await installCamera(call, previous, nextTrack);
      } catch {
        nextTrack?.stop();
        if (call === current) showCallCamera(false);
      }
    }
    if (call === current) notice('camera-notice', flip && ['NotFoundError', 'OverconstrainedError'].includes(error.name)
      ? 'No alternate camera was found.' : describe(error));
  } finally {
    call.switchingCamera = false;
    if (call === current) renderCall();
  }
}

async function installCamera(call, previous, track) {
  await call.videoSender.replaceTrack(track);
  if (call !== current) {
    track.stop();
    return;
  }
  if (previous) call.stream.removeTrack(previous);
  call.stream.addTrack(track);
  call.cameraDevice = track.getSettings().deviceId;
  el('local').srcObject = call.stream;
  showCallCamera(true);
  void el('local').play().catch(() => {});
  void capVideo(call.videoSender);
}

async function prepare(call) {
  if (!window.RTCPeerConnection) throw new Error('Open this page in a browser that supports WebRTC calls.');
  call.stream = await captureDefault(
    { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    call.mode === 'video', () => call === current
  );
  const iceServers = await api('ice');
  if (call !== current) throw new Error('This call is no longer available.');
  const pc = new RTCPeerConnection({ iceServers });
  call.hasRelay = iceServers.some(server => [server.urls].flat().some(url => /^turns?:/.test(url)));
  call.pc = pc;
  call.localCandidates = [];
  call.remoteCandidates = 0;
  call.remoteStream = new MediaStream();
  pc.onicecandidate = ({ candidate }) => {
    if (candidate && call === current) call.localCandidates.push(candidate.toJSON());
  };
  pc.ontrack = ({ track }) => {
    if (call !== current) return;
    call.remoteStream.addTrack(track);
    el(call.mode === 'video' ? 'remote' : 'remote-audio').srcObject = call.remoteStream;
    void playRemote();
  };
  pc.onconnectionstatechange = () => {
    if (call !== current) return;
    if (pc.connectionState === 'connected') {
      if (!call.connectedAt && call.videoSender) void capVideo(call.videoSender);
      call.connectedAt ||= Date.now();
      call.disconnectedAt = null;
      call.status = 'Connected';
    } else if (pc.connectionState === 'disconnected') {
      call.disconnectedAt ||= Date.now();
      call.status = 'Reconnecting…';
    }
    renderCall();
  };
  if (call.mode === 'video') {
    el('local').srcObject = call.stream;
    showCallCamera(true);
    void el('local').play().catch(() => {});
  }
  for (const track of call.stream.getTracks()) {
    const sender = pc.addTrack(track, call.stream);
    if (track.kind === 'video') call.videoSender = sender;
  }
}

function describe(error) {
  const messages = {
    NotAllowedError: 'Allow camera and microphone access for this site in your browser settings, then try again.',
    NotFoundError: 'No camera or microphone was found. Check that it is connected and enabled.',
    NotReadableError: 'Close other apps or tabs using your camera or microphone, then try again.'
  };
  return messages[error.name] || error.message || 'The call could not be completed.';
}

async function act(action) {
  if (busy) return;
  busy = true;
  actionVersion++;
  notice('room-notice');
  renderCall();
  try {
    await action();
  } catch (error) {
    notice('room-notice', describe(error));
  } finally {
    busy = false;
    renderCall();
  }
}

async function dial(mode, offer = null) {
  closeCameraTest();
  const call = { id: offer?.id, mode, status: 'Waiting for device permission…' };
  current = call;
  renderCall();
  try {
    await prepare(call);
    if (offer) {
      await call.pc.setRemoteDescription(offer.offer);
      await call.pc.setLocalDescription(await call.pc.createAnswer());
      const accepted = await send(call, 'accept', { sdp: call.pc.localDescription.sdp });
      scheduleCutoff(call, accepted);
      call.connectingAt = Date.now();
      call.status = 'Connecting…';
    } else {
      await call.pc.setLocalDescription(await call.pc.createOffer());
      const result = await send(call, 'start', { mode, sdp: call.pc.localDescription.sdp });
      call.id = result.id;
      call.ringing = true;
      call.status = 'Ringing…';
    }
    incoming = null;
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function hangup(message) {
  const call = current;
  cleanup();
  if (call?.id) {
    try {
      await send(call, 'end');
    } catch (error) {
      if (error.status !== 409) throw error;
    }
  }
  notice('room-notice', message || 'Call ended.');
}

async function reconcile(snapshot) {
  const remote = snapshot.call;
  if (current) {
    const call = current;
    if (remote?.id !== call.id || remote.state === 'ended') {
      cleanup();
      notice('room-notice', remote?.reason || 'Call ended.');
    } else {
      call.ringing = remote.state === 'ringing';
      updateRing();
      scheduleCutoff(call, remote);
      call.partnerFilter = remote.partnerFilter;
      drawFilters();
      if (remote.answer && !call.pc.remoteDescription) {
        await call.pc.setRemoteDescription(remote.answer);
        call.connectingAt = Date.now();
        call.status = 'Connecting…';
      }
      if (call !== current) return;
      if (call.pc.remoteDescription) {
        while (call.remoteCandidates < remote.candidates.length && call === current) {
          const candidate = remote.candidates[call.remoteCandidates++];
          await call.pc.addIceCandidate(candidate).catch(() => {});
        }
      }
      while (call.localCandidates.length && call === current) {
        await send(call, 'candidate', { candidate: call.localCandidates[0] });
        call.localCandidates.shift();
      }
      if (call !== current) return;
      const expired = (!call.connectedAt && call.connectingAt && Date.now() - call.connectingAt > 30000) ||
        (call.disconnectedAt && Date.now() - call.disconnectedAt > 15000);
      if (call.pc.connectionState === 'failed' || expired) {
        const message = call.hasRelay ? 'The call could not connect. Check your network and whether the relay quota is available.'
          : 'A direct connection could not be made. These networks may require an active call relay.';
        await act(() => hangup(message));
      } else if (call.pc.connectionState === 'connected') {
        const seconds = Math.floor((Date.now() - call.connectedAt) / 1000);
        call.status = `Connected · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      }
    }
  } else if (!remote?.outgoing && remote?.state === 'ringing') {
    if (incoming?.id !== remote.id) notice('room-notice');
    incoming = remote;
  } else if (incoming) {
    incoming = null;
    if (remote?.state !== 'ended') notice('room-notice', 'The incoming call is no longer available.');
  } else if (remote && remote.state !== 'ended') {
    await send(remote, 'end').catch(() => {});
  }
  renderCall();
}

async function poll() {
  if (polling || !account) return;
  polling = true;
  const version = actionVersion;
  try {
    const snapshot = await api('state');
    lastPoll = Date.now();
    const isActive = snapshot.call?.state === 'active';
    if (isActive !== heartCallActive) {
      heartCallActive = isActive;
      if (!isActive && heartUsage) {
        const elapsed = Math.min(heartUsage.runningMs, performance.now() - heartUsage.receivedAt);
        heartUsage = { ...heartUsage, usedMs: heartUsage.usedMs + elapsed, runningMs: 0 };
      }
      void refreshHeart();
    }
    el('presence-dot').classList.toggle('online', snapshot.online);
    el('presence').textContent = snapshot.online ? 'Online' : 'Away';
    if (!busy && version === actionVersion) await reconcile(snapshot);
  } catch (error) {
    if (error.status === 401) setAccount(null);
    else if (error.status !== 409) {
      el('presence-dot').classList.remove('online');
      el('presence').textContent = 'Checking connection…';
      if (!busy && Date.now() - lastPoll > 30000 && (current || incoming)) {
        cleanup();
        incoming = null;
        notice('room-notice', 'Lost connection to the call room.');
        renderCall();
      }
    }
  } finally {
    polling = false;
  }
}

el('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  unlockRing();
  const user = el('user').value;
  el('sign-in').disabled = true;
  notice('login-error');
  try {
    await api('login', { user, password: el('password').value });
    el('password').value = '';
    setAccount(user);
    void poll();
  } catch (error) {
    notice('login-error', describe(error));
  } finally {
    el('sign-in').disabled = false;
  }
});
document.addEventListener('pointerdown', () => {
  if (account && audioContext?.state !== 'running') unlockRing();
});
el('enable-ringer').onclick = unlockRing;
el('logout').onclick = () => act(async () => {
  await api('logout', {});
  setAccount(null);
});
function callWithRinger(action) {
  unlockRing();
  return act(action);
}
el('voice').onclick = () => callWithRinger(() => dial('voice'));
el('video').onclick = () => callWithRinger(() => dial('video'));
el('accept').onclick = () => callWithRinger(() => dial(incoming.mode, incoming));
el('decline').onclick = () => act(async () => {
  await send(incoming, 'decline');
  incoming = null;
});
el('hangup').onclick = () => act(() => hangup());
el('play').onclick = playRemote;
el('mute').onclick = () => {
  const track = current?.stream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  el('mute').textContent = track.enabled ? 'Mute' : 'Unmute';
  el('mute').setAttribute('aria-pressed', String(!track.enabled));
};
el('camera').onclick = () => {
  const call = current;
  if (!call?.videoSender) return;
  const track = call.stream.getVideoTracks()[0];
  if (track?.readyState !== 'live') return void changeCamera(call, false);
  track.enabled = !track.enabled;
  showCallCamera(track.enabled);
  renderCall();
};
el('flip-camera').onclick = () => {
  if (current?.videoSender) void changeCamera(current, true);
};
window.addEventListener('pagehide', () => {
  closeCameraTest();
  const call = current;
  cleanup();
  if (call?.id) void send(call, 'end').catch(() => {});
});
setInterval(poll, 900);
setInterval(updateRing, 350);
setInterval(() => {
  if (account && !document.hidden) void refreshHeart();
}, 15000);
setInterval(() => {
  if (heartUsage?.runningMs && !document.hidden) renderHeart();
}, 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refreshHeart();
});
try {
  const snapshot = await api('state');
  if (!account) setAccount(snapshot.user);
  void poll();
} catch (error) {
  if (error.status !== 401) notice('login-error', 'Could not connect to ROWA Calls. Refresh to try again.');
}
