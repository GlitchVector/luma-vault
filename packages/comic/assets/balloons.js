/*
 * Draws every balloon's shape once the fonts are in and the text has wrapped.
 *
 * The text block decides the size: it lays itself out under the CSS max-width,
 * then an SVG the same size is put behind it with a rounded rectangle (or a
 * burst, for a shout) and a tail toward `data-tail`, a point in percent of
 * the panel. Anchors position the balloon inside the panel with the inset the
 * stylesheet sets. When everything is drawn, <body data-ready="1"> tells the
 * screenshotter it can shoot.
 */
(function () {
  const NS = 'http://www.w3.org/2000/svg'

  function cssPx(element, name, fallback) {
    const value = parseFloat(getComputedStyle(element).getPropertyValue(name))
    return Number.isFinite(value) ? value : fallback
  }

  function place(balloon, panel) {
    const anchor = balloon.dataset.anchor || 'top-left'
    const inset = cssPx(balloon, '--balloon-inset', 24)
    const pw = panel.clientWidth
    const ph = panel.clientHeight
    const bw = balloon.offsetWidth
    const bh = balloon.offsetHeight
    let left = inset
    let top = inset
    if (anchor.includes('right')) left = pw - bw - inset
    else if (anchor === 'top' || anchor === 'bottom' || anchor === 'center') left = (pw - bw) / 2
    if (anchor.includes('bottom')) top = ph - bh - inset
    else if (anchor === 'left' || anchor === 'right' || anchor === 'center') top = (ph - bh) / 2
    balloon.style.left = Math.max(0, left) + 'px'
    balloon.style.top = Math.max(0, top) + 'px'
    return { left: Math.max(0, left), top: Math.max(0, top), width: bw, height: bh }
  }

  function roundedRect(w, h, r) {
    r = Math.min(r, w / 2, h / 2)
    return `M${r},0 H${w - r} A${r},${r} 0 0 1 ${w},${r} V${h - r} A${r},${r} 0 0 1 ${w - r},${h} H${r} A${r},${r} 0 0 1 0,${h - r} V${r} A${r},${r} 0 0 1 ${r},0 Z`
  }

  function burst(w, h, points) {
    const cx = w / 2
    const cy = h / 2
    const parts = []
    for (let i = 0; i < points * 2; i++) {
      const angle = (Math.PI * 2 * i) / (points * 2) - Math.PI / 2
      const outer = i % 2 === 0
      const rx = (w / 2) * (outer ? 1.18 : 0.98)
      const ry = (h / 2) * (outer ? 1.28 : 1.0)
      parts.push(`${i === 0 ? 'M' : 'L'}${(cx + Math.cos(angle) * rx).toFixed(1)},${(cy + Math.sin(angle) * ry).toFixed(1)}`)
    }
    return parts.join(' ') + ' Z'
  }

  /* A tail from the edge nearest the target, stopping short of it so it never
   * covers the face it points at. */
  function tail(box, target, kind) {
    const cx = box.width / 2
    const cy = box.height / 2
    const tx = target.x - box.left
    const ty = target.y - box.top
    const dx = tx - cx
    const dy = ty - cy
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len
    const uy = dy / len
    // Where the centre-to-target line leaves the rectangle.
    const sx = Math.abs(ux) > 1e-6 ? (cx - 6) / Math.abs(ux) : Infinity
    const sy = Math.abs(uy) > 1e-6 ? (cy - 6) / Math.abs(uy) : Infinity
    const s = Math.min(sx, sy)
    const ex = cx + ux * s
    const ey = cy + uy * s
    const reach = Math.min(len - s, Math.max(40, box.height * 0.9))
    const px = ex + ux * reach
    const py = ey + uy * reach
    const base = Math.max(18, Math.min(34, box.height * 0.28))
    const nx = -uy
    const ny = ux
    if (kind === 'thought') {
      const circles = []
      for (let i = 1; i <= 3; i++) {
        const t = i / 4
        const r = base * (0.55 - i * 0.12)
        circles.push({ cx: ex + ux * reach * t, cy: ey + uy * reach * t, r: r })
      }
      return { circles }
    }
    const a = `${(ex + nx * base).toFixed(1)},${(ey + ny * base).toFixed(1)}`
    const b = `${(ex - nx * base).toFixed(1)},${(ey - ny * base).toFixed(1)}`
    return { path: `M${a} L${px.toFixed(1)},${py.toFixed(1)} L${b} Z` }
  }

  function draw(balloon, panel) {
    const kind = ['thought', 'shout', 'caption'].find((k) => balloon.classList.contains(k)) || 'speech'
    const box = place(balloon, panel)
    const svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('width', box.width)
    svg.setAttribute('height', box.height)
    svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`)

    const radius = kind === 'caption' ? 6 : cssPx(balloon, '--balloon-radius', 30)
    const shape = document.createElementNS(NS, 'path')
    shape.setAttribute('class', 'shape')
    shape.setAttribute('d', kind === 'shout' ? burst(box.width, box.height, 14) : roundedRect(box.width, box.height, radius))

    if (balloon.dataset.tail && kind !== 'caption') {
      const [px, py] = balloon.dataset.tail.split(',').map(Number)
      const target = { x: (panel.clientWidth * px) / 100, y: (panel.clientHeight * py) / 100 }
      const t = tail(box, target, kind)
      if (t.path) {
        const tailPath = document.createElementNS(NS, 'path')
        tailPath.setAttribute('class', 'shape tail')
        tailPath.setAttribute('d', t.path)
        svg.appendChild(tailPath)
        // The body goes on top so its stroke hides the tail's base line.
        svg.appendChild(shape)
        const cover = document.createElementNS(NS, 'path')
        cover.setAttribute('d', shape.getAttribute('d'))
        cover.setAttribute('class', 'shape')
        cover.setAttribute('style', 'stroke:none')
        svg.appendChild(cover)
      } else {
        svg.appendChild(shape)
        for (const c of t.circles) {
          const circle = document.createElementNS(NS, 'circle')
          circle.setAttribute('class', 'shape')
          circle.setAttribute('cx', c.cx.toFixed(1))
          circle.setAttribute('cy', c.cy.toFixed(1))
          circle.setAttribute('r', c.r.toFixed(1))
          svg.appendChild(circle)
        }
      }
    } else {
      svg.appendChild(shape)
    }
    balloon.insertBefore(svg, balloon.firstChild)
    balloon.style.visibility = 'visible'
  }

  function run() {
    for (const panel of document.querySelectorAll('.panel')) {
      for (const balloon of panel.querySelectorAll('.balloon')) draw(balloon, panel)
    }
    document.body.dataset.ready = '1'
  }

  const fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()
  const images = Promise.all(
    Array.from(document.images).map((img) => (img.complete ? Promise.resolve() : new Promise((r) => { img.onload = r; img.onerror = r }))),
  )
  Promise.all([fonts, images]).then(run, run)
})()
