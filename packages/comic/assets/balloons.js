/*
 * Places every balloon and draws its shape, once the fonts are in and the
 * text has wrapped.
 *
 * Two jobs the stylesheet cannot do:
 *
 * 1. PLACEMENT. The anchor in the script says which corner the writer wanted,
 *    but not what is underneath it. The assembler measures how busy each part
 *    of the panel is (`assemble/energy.ts`) and hands it over as
 *    `data-energy`; this searches near the anchor for the quietest spot the
 *    balloon fits in, so it covers sky rather than her face. Without that
 *    attribute it just uses the anchor, which is how this used to work.
 *
 * 2. THE SHAPE. The balloon and its tail are ONE path, with the tail spliced
 *    into the outline and curved, so there is a single continuous stroke.
 *    Drawing a separate triangle and hiding the join under a second fill is
 *    what made the old tails look stuck on.
 *
 * When everything is drawn, <body data-ready="1"> tells the screenshotter.
 */
(function () {
  const NS = 'http://www.w3.org/2000/svg'

  function cssPx(element, name, fallback) {
    const value = parseFloat(getComputedStyle(element).getPropertyValue(name))
    return Number.isFinite(value) ? value : fallback
  }

  /* ---- where the art is busy ------------------------------------------ */

  function readEnergy(panel) {
    const raw = panel.dataset.energy
    if (!raw) return null
    const comma = raw.indexOf(',')
    const comma2 = raw.indexOf(',', comma + 1)
    const cols = Number(raw.slice(0, comma))
    const rows = Number(raw.slice(comma + 1, comma2))
    const cells = raw.slice(comma2 + 1)
    if (!cols || !rows || cells.length < cols * rows) return null
    return { cols: cols, rows: rows, cells: cells }
  }

  /* Mean busyness under a rectangle, 0 (flat) to 9 (detailed). */
  function energyUnder(energy, panel, rect) {
    const x0 = Math.max(0, Math.floor((rect.left / panel.clientWidth) * energy.cols))
    const x1 = Math.min(energy.cols - 1, Math.ceil(((rect.left + rect.width) / panel.clientWidth) * energy.cols) - 1)
    const y0 = Math.max(0, Math.floor((rect.top / panel.clientHeight) * energy.rows))
    const y1 = Math.min(energy.rows - 1, Math.ceil(((rect.top + rect.height) / panel.clientHeight) * energy.rows) - 1)
    let sum = 0
    let n = 0
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        sum += Number(energy.cells.charAt(y * energy.cols + x)) || 0
        n++
      }
    }
    return n ? sum / n : 0
  }

  /* The corner the writer asked for, as a top-left position. */
  function anchorPosition(anchor, panel, box, inset) {
    const pw = panel.clientWidth
    const ph = panel.clientHeight
    let left = inset
    let top = inset
    if (anchor.indexOf('right') >= 0) left = pw - box.width - inset
    else if (anchor === 'top' || anchor === 'bottom' || anchor === 'center') left = (pw - box.width) / 2
    if (anchor.indexOf('bottom') >= 0) top = ph - box.height - inset
    else if (anchor === 'left' || anchor === 'right' || anchor === 'center') top = (ph - box.height) / 2
    return { left: left, top: top }
  }

  function overlaps(a, b, pad) {
    return (
      a.left < b.left + b.width + pad &&
      a.left + a.width + pad > b.left &&
      a.top < b.top + b.height + pad &&
      a.top + a.height + pad > b.top
    )
  }

  /*
   * Search near the anchor for somewhere quiet that does not sit on another
   * balloon. The anchor still dominates: straying is charged for, so a
   * balloon only moves when what it would have covered is genuinely busy.
   */
  function place(balloon, panel, taken, energy) {
    const inset = cssPx(balloon, '--balloon-inset', 24)
    const box = { width: balloon.offsetWidth, height: balloon.offsetHeight }
    const anchor = balloon.dataset.anchor || 'top-left'
    const ideal = anchorPosition(anchor, panel, box, inset)

    const maxLeft = Math.max(inset, panel.clientWidth - box.width - inset)
    const maxTop = Math.max(inset, panel.clientHeight - box.height - inset)
    const clamp = (p) => ({
      left: Math.min(maxLeft, Math.max(inset, p.left)),
      top: Math.min(maxTop, Math.max(inset, p.top)),
      width: box.width,
      height: box.height,
    })

    let best = clamp(ideal)
    if (!energy) {
      for (let i = 0; i < taken.length; i++) {
        if (overlaps(best, taken[i], 8)) best = clamp({ left: best.left, top: taken[i].top + taken[i].height + 12 })
      }
      return best
    }

    /* How far it may wander: about a third of the panel, in steps. */
    const reachX = panel.clientWidth * 0.34
    const reachY = panel.clientHeight * 0.34
    const steps = 7
    let bestScore = Infinity
    for (let iy = 0; iy <= steps; iy++) {
      for (let ix = 0; ix <= steps; ix++) {
        const candidate = clamp({
          left: ideal.left + ((ix / steps) * 2 - 1) * reachX,
          top: ideal.top + ((iy / steps) * 2 - 1) * reachY,
        })
        let score = energyUnder(energy, panel, candidate)
        /* Straying from the writer's corner costs; 9 is the busiest a cell
         * can be, so this is measured in the same units. */
        const drift =
          Math.abs(candidate.left - ideal.left) / panel.clientWidth +
          Math.abs(candidate.top - ideal.top) / panel.clientHeight
        score += drift * 6
        for (let i = 0; i < taken.length; i++) if (overlaps(candidate, taken[i], 8)) score += 40
        if (score < bestScore) {
          bestScore = score
          best = candidate
        }
      }
    }
    return best
  }

  /* ---- the shape ------------------------------------------------------- */

  /* Which edge of the box a point outside it lies past. */
  function exitEdge(box, target) {
    const cx = box.width / 2
    const cy = box.height / 2
    const dx = target.x - cx
    const dy = target.y - cy
    if (Math.abs(dx) / (cx || 1) > Math.abs(dy) / (cy || 1)) return dx > 0 ? 'right' : 'left'
    return dy > 0 ? 'bottom' : 'top'
  }

  /*
   * One path: a rounded rectangle with the tail spliced into whichever edge
   * faces the speaker. The tail leaves the edge at full base width and
   * narrows to the tip along two quadratic curves that bow the same way, so
   * it reads as a drawn tail rather than a triangle stuck on the side.
   */
  function bubblePath(w, h, r, tail) {
    r = Math.min(r, w / 2, h / 2)
    const p = []
    const tipX = tail ? tail.tip.x : 0
    const tipY = tail ? tail.tip.y : 0
    /* Bow the tail slightly towards the reading direction. */
    const bow = tail ? tail.base * 0.55 : 0

    function tailOn(edge) {
      if (!tail || tail.edge !== edge) return false
      const horizontal = edge === 'top' || edge === 'bottom'
      const span = horizontal ? w : h
      const half = Math.min(tail.base, span / 3)
      let at = horizontal ? tipX : tipY
      at = Math.min(span - r - half, Math.max(r + half, at))
      const a = at - half
      const b = at + half
      /* Walk the edge to the near base point, curve out to the tip, curve
       * back, then carry on along the edge. */
      if (edge === 'top') {
        p.push('L' + a + ',0', 'Q' + (a + bow) + ',' + -Math.abs(tipY) * 0.3 + ' ' + tipX + ',' + tipY, 'Q' + (b + bow) + ',' + -Math.abs(tipY) * 0.3 + ' ' + b + ',0')
      } else if (edge === 'bottom') {
        p.push('L' + b + ',' + h, 'Q' + (b - bow) + ',' + (h + (tipY - h) * 0.3) + ' ' + tipX + ',' + tipY, 'Q' + (a - bow) + ',' + (h + (tipY - h) * 0.3) + ' ' + a + ',' + h)
      } else if (edge === 'right') {
        p.push('L' + w + ',' + a, 'Q' + (w + (tipX - w) * 0.3) + ',' + (a + bow) + ' ' + tipX + ',' + tipY, 'Q' + (w + (tipX - w) * 0.3) + ',' + (b + bow) + ' ' + w + ',' + b)
      } else {
        p.push('L0,' + b, 'Q' + -Math.abs(tipX) * 0.3 + ',' + (b - bow) + ' ' + tipX + ',' + tipY, 'Q' + -Math.abs(tipX) * 0.3 + ',' + (a - bow) + ' 0,' + a)
      }
      return true
    }

    p.push('M' + r + ',0')
    tailOn('top')
    p.push('L' + (w - r) + ',0', 'A' + r + ',' + r + ' 0 0 1 ' + w + ',' + r)
    tailOn('right')
    p.push('L' + w + ',' + (h - r), 'A' + r + ',' + r + ' 0 0 1 ' + (w - r) + ',' + h)
    tailOn('bottom')
    p.push('L' + r + ',' + h, 'A' + r + ',' + r + ' 0 0 1 0,' + (h - r))
    tailOn('left')
    p.push('L0,' + r, 'A' + r + ',' + r + ' 0 0 1 ' + r + ',0', 'Z')
    return p.join(' ')
  }

  /* A shout is a burst; the tail is spliced the same way afterwards. */
  function burst(w, h, points) {
    const cx = w / 2
    const cy = h / 2
    const parts = []
    for (let i = 0; i < points * 2; i++) {
      const angle = (Math.PI * 2 * i) / (points * 2) - Math.PI / 2
      const outer = i % 2 === 0
      const rx = (w / 2) * (outer ? 1.16 : 0.97)
      const ry = (h / 2) * (outer ? 1.26 : 1.0)
      parts.push((i === 0 ? 'M' : 'L') + (cx + Math.cos(angle) * rx).toFixed(1) + ',' + (cy + Math.sin(angle) * ry).toFixed(1))
    }
    return parts.join(' ') + ' Z'
  }

  /* Thought balloons trail shrinking circles instead of a tail. */
  function thoughtTrail(box, target) {
    const cx = box.width / 2
    const cy = box.height / 2
    const dx = target.x - cx
    const dy = target.y - cy
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len
    const uy = dy / len
    const sx = Math.abs(ux) > 1e-6 ? (cx - 6) / Math.abs(ux) : Infinity
    const sy = Math.abs(uy) > 1e-6 ? (cy - 6) / Math.abs(uy) : Infinity
    const edge = Math.min(sx, sy)
    const reach = Math.max(24, Math.min(len - edge, box.height * 1.1))
    const circles = []
    for (let i = 1; i <= 3; i++) {
      const t = i / 3.6
      circles.push({
        cx: cx + ux * (edge + reach * t),
        cy: cy + uy * (edge + reach * t),
        r: Math.max(3, box.height * 0.13 * (1 - i * 0.26)),
      })
    }
    return circles
  }

  function draw(balloon, panel, taken, energy) {
    const kind = ['thought', 'shout', 'caption'].find((k) => balloon.classList.contains(k)) || 'speech'
    const spot = place(balloon, panel, taken, energy)
    balloon.style.left = spot.left + 'px'
    balloon.style.top = spot.top + 'px'
    taken.push(spot)

    const w = spot.width
    const h = spot.height
    const svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('width', w)
    svg.setAttribute('height', h)
    /* The tail leaves the box, so the viewBox cannot clip it. */
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h)
    svg.setAttribute('overflow', 'visible')

    let tail = null
    if (balloon.dataset.tail && kind !== 'caption') {
      const parts = balloon.dataset.tail.split(',')
      const target = {
        x: (panel.clientWidth * Number(parts[0])) / 100 - spot.left,
        y: (panel.clientHeight * Number(parts[1])) / 100 - spot.top,
      }
      const inside = target.x > 0 && target.x < w && target.y > 0 && target.y < h
      if (!inside) {
        if (kind === 'thought') {
          for (const c of thoughtTrail(spot, target)) {
            const circle = document.createElementNS(NS, 'circle')
            circle.setAttribute('class', 'shape')
            circle.setAttribute('cx', c.cx.toFixed(1))
            circle.setAttribute('cy', c.cy.toFixed(1))
            circle.setAttribute('r', c.r.toFixed(1))
            svg.appendChild(circle)
          }
        } else {
          /*
           * A tail POINTS at the speaker, it does not reach her. Its length
           * is a property of the balloon — a little under its own height —
           * not of how far away she happens to be. Interpolating toward the
           * target instead produced tails the length of the panel once
           * balloons were free to move away from what they point at.
           */
          const cx = w / 2
          const cy = h / 2
          const dx = target.x - cx
          const dy = target.y - cy
          const away = Math.hypot(dx, dy) || 1
          const ux = dx / away
          const uy = dy / away
          /* Where the centre-to-speaker ray leaves the bubble. */
          const toSide = Math.abs(ux) > 1e-6 ? cx / Math.abs(ux) : Infinity
          const toTopOrBottom = Math.abs(uy) > 1e-6 ? cy / Math.abs(uy) : Infinity
          const edgeAt = Math.min(toSide, toTopOrBottom)
          const reach = Math.min(Math.max(0, away - edgeAt) * 0.7, Math.max(30, h * 0.8))
          const tipDistance = edgeAt + reach
          tail = {
            edge: exitEdge(spot, target),
            /* Narrow enough to taper over that reach. */
            base: Math.max(10, Math.min(24, Math.min(h * 0.26, reach * 0.6))),
            tip: { x: Number((cx + ux * tipDistance).toFixed(1)), y: Number((cy + uy * tipDistance).toFixed(1)) },
          }
        }
      }
    }

    const shape = document.createElementNS(NS, 'path')
    shape.setAttribute('class', 'shape')
    const radius = kind === 'caption' ? 6 : cssPx(balloon, '--balloon-radius', 30)
    shape.setAttribute('d', kind === 'shout' ? burst(w, h, 14) : bubblePath(w, h, radius, tail))
    svg.insertBefore(shape, svg.firstChild)

    /* A shout's tail is a separate wedge: splicing into a burst would eat a
     * spike. Drawn under the burst so the outline stays unbroken. */
    if (tail && kind === 'shout') {
      const wedge = document.createElementNS(NS, 'path')
      wedge.setAttribute('class', 'shape')
      const half = tail.base
      const horizontal = tail.edge === 'top' || tail.edge === 'bottom'
      const ax = horizontal ? tail.tip.x - half : tail.edge === 'right' ? w : 0
      const ay = horizontal ? (tail.edge === 'top' ? 0 : h) : tail.tip.y - half
      const bx = horizontal ? tail.tip.x + half : ax
      const by = horizontal ? ay : tail.tip.y + half
      wedge.setAttribute('d', 'M' + ax + ',' + ay + ' L' + tail.tip.x + ',' + tail.tip.y + ' L' + bx + ',' + by + ' Z')
      svg.insertBefore(wedge, svg.firstChild)
    }

    balloon.insertBefore(svg, balloon.firstChild)
    balloon.style.visibility = 'visible'
  }

  function run() {
    for (const panel of document.querySelectorAll('.panel')) {
      const energy = readEnergy(panel)
      const taken = []
      /* Sound effects are already placed by the stylesheet; balloons avoid
       * them the same as they avoid each other. */
      for (const sfx of panel.querySelectorAll('.sfx')) {
        taken.push({ left: sfx.offsetLeft, top: sfx.offsetTop, width: sfx.offsetWidth, height: sfx.offsetHeight })
      }
      for (const balloon of panel.querySelectorAll('.balloon')) draw(balloon, panel, taken, energy)
    }
    document.body.dataset.ready = '1'
  }

  const fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()
  const images = Promise.all(
    Array.from(document.images).map((img) => (img.complete ? Promise.resolve() : new Promise((r) => { img.onload = r; img.onerror = r }))),
  )
  Promise.all([fonts, images]).then(run, run)
})()
