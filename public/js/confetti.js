function fireConfetti(duration) {
  duration = duration || 3000;
  var canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9999';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  var ctx = canvas.getContext('2d');
  var particles = [];
  var colors = ['#a855f7','#c084fc','#43b581','#f04747','#ffd700','#ff6b6b','#48dbfb','#ff9ff3'];
  var end = Date.now() + duration;

  for (var i = 0; i < 150; i++) {
    particles.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height - canvas.height,
      w: Math.random() * 10 + 5,
      h: Math.random() * 6 + 3,
      color: colors[Math.floor(Math.random() * colors.length)],
      vx: (Math.random() - 0.5) * 4,
      vy: Math.random() * 3 + 2,
      rot: Math.random() * 360,
      rv: (Math.random() - 0.5) * 10,
      opacity: 1
    });
  }

  function frame() {
    var remaining = end - Date.now();
    if (remaining <= 0 && particles.length === 0) {
      canvas.remove();
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles = particles.filter(function(p) {
      p.x += p.vx;
      p.vy += 0.05;
      p.y += p.vy;
      p.rot += p.rv;
      if (remaining <= 0) p.opacity -= 0.02;
      if (p.y > canvas.height + 20 || p.opacity <= 0) return false;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot * Math.PI / 180);
      ctx.globalAlpha = Math.max(0, p.opacity);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w/2, -p.h/2, p.w, p.h);
      ctx.restore();
      return true;
    });
    requestAnimationFrame(frame);
  }
  frame();
}
