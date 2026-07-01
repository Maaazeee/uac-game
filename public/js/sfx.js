var audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playTone(freq, duration, type, volume) {
  try {
    var ctx = getAudioCtx();
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume || 0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch (e) { /* silent fail */ }
}

function playNote(freq, startDelay, duration, type, volume) {
  try {
    var ctx = getAudioCtx();
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume || 0.15, ctx.currentTime + startDelay);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startDelay + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime + startDelay);
    osc.stop(ctx.currentTime + startDelay + duration);
  } catch (e) { /* silent fail */ }
}

function playReveal() {
  playTone(440, 0.15, 'triangle', 0.12);
  setTimeout(function(){ playTone(554, 0.15, 'triangle', 0.12); }, 100);
  setTimeout(function(){ playTone(659, 0.3, 'triangle', 0.12); }, 200);
}

function playWin() {
  var notes = [523, 659, 784, 1047];
  notes.forEach(function(f, i) {
    playNote(f, i * 0.12, 0.25, 'sine', 0.12);
  });
}

function playCountdown() {
  playTone(880, 0.08, 'square', 0.08);
}

function playImpostorReveal() {
  playTone(300, 0.2, 'sawtooth', 0.08);
  setTimeout(function(){ playTone(250, 0.2, 'sawtooth', 0.08); }, 200);
  setTimeout(function(){ playTone(200, 0.4, 'sawtooth', 0.08); }, 400);
}

function playError() {
  playTone(200, 0.2, 'square', 0.08);
  setTimeout(function(){ playTone(160, 0.3, 'square', 0.08); }, 150);
}
