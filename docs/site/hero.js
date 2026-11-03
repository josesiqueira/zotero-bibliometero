/* global window, document, fetch, getComputedStyle, requestAnimationFrame */
// Hero: a small force-directed co-authorship network made from mock data.
// Nodes can be dragged; the layout settles and stops (no idle animation).
(function () {
  "use strict";

  // Download count from the same JSON the README badge reads.
  var dl = document.getElementById("downloads");
  if (dl && window.fetch && window.BADGE_JSON) {
    fetch(window.BADGE_JSON, { cache: "no-store" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (j) {
        var n = j && Number(j.message);
        if (n > 0) {
          dl.textContent = n.toLocaleString("en") + " downloads so far";
          dl.hidden = false;
        }
      })
      .catch(function () {});
  }

  var canvas = document.getElementById("graph");
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Seeded random numbers so the mock graph is the same on every visit.
  var seed = 7;
  function rand() {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  }

  // Three research groups, a few bridges between them.
  var ANCHORS = [
    [0.3, 0.38],
    [0.72, 0.34],
    [0.52, 0.74],
  ];
  var groups = [14, 11, 9];
  var nodes = [];
  var edges = [];
  var start = 0;
  groups.forEach(function (size, g) {
    for (var i = 0; i < size; i++) {
      nodes.push({
        g: g,
        x: ANCHORS[g][0] + (rand() - 0.5) * 0.2,
        y: ANCHORS[g][1] + (rand() - 0.5) * 0.2,
        vx: 0,
        vy: 0,
        w: 1,
        pinned: false,
      });
    }
    for (var a = start; a < start + size; a++) {
      var links = 1 + Math.floor(rand() * 2.2);
      for (var k = 0; k < links; k++) {
        var b = start + Math.floor(rand() * size);
        if (b !== a) edges.push([a, b]);
      }
    }
    start += size;
  });
  edges.push([0, 15], [3, 20], [16, 27], [25, 30], [8, 33]);
  edges.forEach(function (e) {
    nodes[e[0]].w++;
    nodes[e[1]].w++;
  });

  var W = 0,
    H = 0,
    dpr = 1;
  function resize() {
    var r = canvas.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = r.width;
    H = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function colors() {
    var s = getComputedStyle(document.documentElement);
    var v = function (n) {
      return s.getPropertyValue(n).trim();
    };
    return {
      edge: v("--edge"),
      g: [v("--teal"), v("--plum"), v("--ochre")],
      ring: v("--surface"),
    };
  }

  var alpha = 1;
  function tick() {
    var i, j, a, b, dx, dy, d2, d, f;
    // Repulsion between all nodes (layout runs in unit square coordinates).
    for (i = 0; i < nodes.length; i++) {
      for (j = i + 1; j < nodes.length; j++) {
        a = nodes[i];
        b = nodes[j];
        dx = b.x - a.x;
        dy = b.y - a.y;
        d2 = dx * dx + dy * dy + 1e-4;
        f = (0.00012 * alpha) / d2;
        dx *= f;
        dy *= f;
        a.vx -= dx;
        a.vy -= dy;
        b.vx += dx;
        b.vy += dy;
      }
    }
    // Springs along edges.
    edges.forEach(function (e) {
      a = nodes[e[0]];
      b = nodes[e[1]];
      dx = b.x - a.x;
      dy = b.y - a.y;
      d = Math.sqrt(dx * dx + dy * dy) || 1e-4;
      f = ((d - 0.06) / d) * 0.08 * alpha;
      dx *= f;
      dy *= f;
      a.vx += dx;
      a.vy += dy;
      b.vx -= dx;
      b.vy -= dy;
    });
    var maxV = 0;
    nodes.forEach(function (n) {
      // Each research group drifts toward its own area, bridges pull them together.
      n.vx += (ANCHORS[n.g][0] - n.x) * 0.02 * alpha;
      n.vy += (ANCHORS[n.g][1] - n.y) * 0.02 * alpha;
      n.vx *= 0.6;
      n.vy *= 0.6;
      if (!n.pinned) {
        n.x += n.vx;
        n.y += n.vy;
      }
      maxV = Math.max(maxV, Math.abs(n.vx) + Math.abs(n.vy));
    });
    alpha *= 0.985;
    return alpha > 0.02 || maxV > 0.0004;
  }

  // Layout coordinates are mapped to the canvas so the graph fills it (like
  // the plugin's Fit button). The mapping is frozen while a node is dragged.
  var view = { s: 1, ox: 0, oy: 0 };
  function fitView() {
    var minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    nodes.forEach(function (n) {
      minX = Math.min(minX, n.x);
      maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y);
      maxY = Math.max(maxY, n.y);
    });
    var pad = 28;
    var s = Math.min(
      (W - 2 * pad) / (maxX - minX || 1),
      (H - 2 * pad) / (maxY - minY || 1),
    );
    view.s = s;
    view.ox = (W - s * (maxX + minX)) / 2;
    view.oy = (H - s * (maxY + minY)) / 2;
  }
  function px(n) {
    return { x: view.ox + n.x * view.s, y: view.oy + n.y * view.s };
  }
  function radius(n) {
    return 3 + Math.sqrt(n.w) * 2.1;
  }

  function draw() {
    if (!W) return;
    if (!drag) fitView();
    var c = colors();
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = c.edge;
    ctx.beginPath();
    edges.forEach(function (e) {
      var a = px(nodes[e[0]]),
        b = px(nodes[e[1]]);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    });
    ctx.stroke();
    nodes.forEach(function (n) {
      var p = px(n);
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius(n), 0, Math.PI * 2);
      ctx.fillStyle = c.g[n.g];
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = c.ring;
      ctx.stroke();
    });
  }

  var running = false;
  function loop() {
    var more = tick();
    draw();
    if (more) requestAnimationFrame(loop);
    else running = false;
  }
  function wake(level) {
    alpha = Math.max(alpha, level);
    if (reduce) {
      for (var i = 0; i < 400 && tick(); i++);
      draw();
      return;
    }
    if (!running) {
      running = true;
      requestAnimationFrame(loop);
    }
  }

  // Drag a node: it follows the pointer and stays pinned where you drop it.
  var drag = null;
  function hit(ev) {
    var r = canvas.getBoundingClientRect();
    var x = ev.clientX - r.left,
      y = ev.clientY - r.top;
    var best = null,
      bestD = 18 * 18;
    nodes.forEach(function (n) {
      var p = px(n),
        dx = p.x - x,
        dy = p.y - y,
        d = dx * dx + dy * dy;
      if (d < bestD) {
        best = n;
        bestD = d;
      }
    });
    return { node: best, x: x, y: y };
  }
  canvas.addEventListener("pointerdown", function (ev) {
    var h = hit(ev);
    if (!h.node) return;
    drag = h.node;
    drag.pinned = true;
    canvas.setPointerCapture(ev.pointerId);
    canvas.classList.add("dragging");
  });
  canvas.addEventListener("pointermove", function (ev) {
    if (!drag) return;
    var r = canvas.getBoundingClientRect();
    var sx = Math.min(W - 10, Math.max(10, ev.clientX - r.left));
    var sy = Math.min(H - 10, Math.max(10, ev.clientY - r.top));
    drag.x = (sx - view.ox) / view.s;
    drag.y = (sy - view.oy) / view.s;
    wake(0.25);
    if (reduce) draw();
  });
  function end() {
    drag = null;
    canvas.classList.remove("dragging");
  }
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  window.addEventListener("resize", resize);
  if (window.matchMedia) {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", draw);
  }
  resize();
  if (reduce) {
    for (var i = 0; i < 600 && tick(); i++);
    draw();
  } else {
    running = true;
    requestAnimationFrame(loop);
  }
})();
